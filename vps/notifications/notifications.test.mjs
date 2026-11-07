import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID,randomBytes} from 'node:crypto';
import {billingFixture} from '../billing/fixture.mjs';import {NotificationService} from './service.js';import {NotificationWorker,notificationPlan,notificationPayload} from './worker.js';import {FcmChannel} from './channel.js';
function profile(){const now=Date.now(),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),line={id:'line',label:'L',groupCode:null,supportedCategories:['hourly'],categories:{hourly:{checkedAt:now,sourceUpdatedAt:now,freshUntil:now+3600000,days:[{date,state:'published',intervals:[{start:now+600000,end:now+1200000}]}]}}};return {id:randomUUID(),address:{lineId:'line'},preferences:{reminder:true,restoration:true,lead:30},snapshot:{selectedLineId:'line',universal:{schemaVersion:1,revision:'1',addressId:randomUUID(),operatorId:'op',timeZone:'Europe/Kyiv',coverage:{fromDate:date,toDate:date},resolution:{state:'resolved',complete:true},lines:[line],notices:[],provenance:[],checkedAt:now,sourceUpdatedAt:now,freshUntil:now+3600000,refreshAfter:now+60000,supportState:'available'}}};}
async function fixture(){const f=await billingFixture();await f.c.exec(`alter table public.svitlo_profiles add column snapshot jsonb,add column address jsonb,add column preferences jsonb,add column snapshot_revision bigint default 1;create table public.svitlo_subscriptions(id uuid,owner uuid,subscription jsonb);alter table public.svitlo_subscriptions enable row level security;`);await f.c.exec(await readFile(new URL('../sql/notifications.sql',import.meta.url),'utf8'));await f.c.exec('update svitlo_notifications.control set enabled=true');const key=randomBytes(32).toString('hex'),service=new NotificationService({bridge:f.pool,key,channels:{fcm:true,webpush:true}}),session={owner:f.owner,token:randomBytes(32).toString('hex')},registration={schemaVersion:1,action:'register',installationId:randomUUID(),requestId:randomUUID(),channel:'fcm',permission:'granted',token:'fcm-qa-'+randomBytes(24).toString('hex')};const p=profile();p.owner=f.owner;await f.c.query('insert into public.svitlo_profiles(id,owner,snapshot,address,preferences) values($1,$2,$3,$4,$5)',[p.id,p.owner,JSON.stringify(p.snapshot),JSON.stringify(p.address),JSON.stringify(p.preferences)]);return {...f,key,service,session,registration,p};}
test('installation registration retry, token rotation, cross-owner proofs and denied permission',async()=>{
 const f=await fixture();try{const {service,session,registration:d,c}=f,first=await service.handle(session,d);assert.equal(first.ok,true);assert.deepEqual(await service.handle(session,d),first);
 await assert.rejects(service.handle(session,{...d,requestId:randomUUID(),token:d.token+'new'}),/installation_proof_required/);
 const rotated=await service.handle(session,{...d,requestId:randomUUID(),token:d.token+'new',credential:first.credential,permission:'denied'});assert.equal(rotated.revision,2);assert.notEqual(rotated.credential,first.credential);
 assert.equal((await c.query('select svitlo_notifications.due_profiles() value')).rows[0].value.length,0);
 const other=randomUUID();await c.query('insert into auth.users(id) values($1)',[other]);await c.query("select set_config('svitlo.owner_id',$1,false)",[other]);await assert.rejects(service.handle({...session,owner:other},d),/installation_owner_conflict/);
 await assert.rejects(service.handle({...session,owner:other},{...d,installationId:randomUUID(),token:d.token+'new'}),/token_already_bound/);
 assert.equal((await c.query("select has_table_privilege('svitlo_stage_api','svitlo_notifications.installations','SELECT') value")).rows[0].value,false);
 }finally{await f.c.close();}
});
test('transactional outbox fans out once, final check rejects plan changed one second before send; retries use stable intent',async()=>{
 const f=await fixture();try{await f.service.handle(f.session,f.registration);let sent=[];const worker=new NotificationWorker({pool:f.pool,key:f.key,channels:{fcm:{configured:true,send:async(t,p)=>sent.push(p)}}});
 const data=notificationPlan(f.p);assert.equal(data.desired[0].kind,'reminder');
 assert.equal((await f.c.query('select svitlo_notifications.apply_plan($1,1,$2,$3,$4) value',[f.p.id,data.key,data.preferenceKey,JSON.stringify(data.desired)])).rows[0].value,true);
 // Reapplying the same semantic plan must not publish duplicate jobs.
 await f.c.query('select svitlo_notifications.apply_plan($1,1,$2,$3,$4)',[f.p.id,data.key,data.preferenceKey,JSON.stringify(data.desired)]);
 assert.equal((await f.c.query("select count(*)::int n from svitlo_events.domain_events where type='notification.intent.v1'")).rows[0].n,1);
 await worker.jobs.run('notification-delivery-v1',({tx,event})=>tx.query('select svitlo_notifications.fanout($1)',[event.payload.intentId]));
 const job=(await f.c.query('select svitlo_notifications.claim() value')).rows[0].value[0],current=(await f.c.query('select svitlo_notifications.before_send($1,$2,$3) value',[job.id,job.proof,job.installationRevision])).rows[0].value;
 assert.ok(notificationPayload(job,current));current.snapshot.universal.lines[0].categories.hourly.days[0].intervals[0].start+=60000;
 await f.c.query('update public.svitlo_profiles set snapshot=$2,snapshot_revision=2 where id=$1',[f.p.id,JSON.stringify(current.snapshot)]);
 const changed=(await f.c.query('select svitlo_notifications.before_send($1,$2,$3) value',[job.id,job.proof,job.installationRevision])).rows[0].value;assert.equal(notificationPayload(job,changed),null);
 assert.equal((await f.c.query('select svitlo_notifications.apply_plan($1,1,$2,$3,$4) value',[f.p.id,data.key,data.preferenceKey,JSON.stringify(data.desired)])).rows[0].value,false);
 await f.c.query("select svitlo_notifications.finish($1,$2,'canceled')",[job.id,job.proof]);await worker.tick();assert.equal(sent.length,1);assert.notEqual(sent[0].intentId,job.intentId);await worker.tick();assert.equal(sent.length,1);
 }finally{await f.c.close();}
});
test('expiry, quiet hours, stale snapshots and revoked installation prevent delivery; receipts prove only their installation',async()=>{
 const f=await fixture();try{const r=await f.service.handle(f.session,f.registration),plan=notificationPlan(f.p),job={kind:'reminder',planKey:plan.key,preferenceKey:plan.preferenceKey,targetAt:plan.desired[0].targetAt,expiresAt:plan.desired[0].expiresAt,intentId:randomUUID(),profileId:f.p.id};
 assert.equal(notificationPayload({...job,expiresAt:new Date(Date.now()-1).toISOString()},f.p),null);const stale=structuredClone(f.p);stale.snapshot.universal.freshUntil=0;assert.equal(notificationPayload(job,stale),null);
 assert.equal((await f.service.handle(f.session,{schemaVersion:1,action:'revoke',installationId:f.registration.installationId,credential:r.credential})).ok,true);
 assert.deepEqual((await f.c.query('select svitlo_notifications.claim() value')).rows[0].value,[]);
 }finally{await f.c.close();}
});
test('FCM sends data-only with bounded TTL, fixed project host and unregistered-token handling',async()=>{
 let request;const channel=new FcmChannel({projectId:'svitlo-qa',serviceAccount:{project_id:'svitlo-qa',private_key:'fixture'},fetcher:async(url,options)=>{request={url,options};return new Response(JSON.stringify({name:'projects/svitlo-qa/messages/1'}),{status:200});}});channel.cached={token:'oauth',until:Date.now()+3600000};await channel.send('private-token',{intentId:'id',profileId:'profile',body:'Body'},{ttl:99999});const message=JSON.parse(request.options.body).message;assert.equal(message.android.ttl,'3600s');assert.equal(message.notification,undefined);assert.equal(request.url,'https://fcm.googleapis.com/v1/projects/svitlo-qa/messages:send');
 channel.fetcher=async()=>new Response(JSON.stringify({error:{details:[{errorCode:'UNREGISTERED'}]}}),{status:404});await assert.rejects(channel.send('t',{}),e=>e.permanent===true);
});
