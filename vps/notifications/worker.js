import {createHash} from 'node:crypto';import {DomainJobs} from '../events/domain-jobs.js';import {SecretVault} from '../modules/secret-vault.js';
import {nextPlanEvent,isQuiet} from '../../app/lib/planning.js';import {planKey,canonicalJson} from '../planning/service.js';
const digest=v=>createHash('sha256').update(canonicalJson(v)).digest('hex');
export function notificationPlan(profile,now=Date.now()){
 const s=profile.snapshot?.universal,line=profile.address?.lineId||profile.snapshot?.selectedLineId,p=profile.preferences||{},key=planKey(s,line),preferenceKey=digest(p),desired=[];
 const next=nextPlanEvent(s,line,{now,policy:'conservative'}),event=next.event;
 if(event){const kind=event.kind==='outage'?'reminder':'restoration',lead=Number.isInteger(p.lead)&&p.lead>=5&&p.lead<=120?p.lead:30;
  if(p[kind]===true&&event.at>now){desired.push({kind,targetAt:new Date(event.at).toISOString(),dueAt:new Date(Math.max(now,event.at-lead*60000)).toISOString(),expiresAt:new Date(Math.min(event.at,now+2*86400000)).toISOString()});}
 }
 // Publication/change is meaningful only with a currently usable plan, and SQL
 // suppresses the first baseline. The worker doesn't persist profile names.
 if(next.horizon&&(p.change===true||p.publication===true))desired.push({kind:p.change===true?'change':'publication',targetAt:new Date(Math.floor(now/60000)*60000).toISOString(),dueAt:new Date(now).toISOString(),expiresAt:new Date(now+5*60000).toISOString()});
 return {key,preferenceKey,desired};
}
export function notificationPayload(job,profile,now=Date.now()){
 const current=notificationPlan(profile,now),line=profile.address?.lineId||profile.snapshot?.selectedLineId;
 if(current.key!==job.planKey||current.preferenceKey!==job.preferenceKey||Date.parse(job.expiresAt)<=now||isQuiet(now,job.quiet))return null;
 const next=nextPlanEvent(profile.snapshot?.universal,line,{now,policy:'conservative'});if(!next.horizon)return null;
 if(['reminder','restoration'].includes(job.kind)&&(!current.desired.some(i=>i.kind===job.kind&&Date.parse(i.targetAt)===Date.parse(job.targetAt))||Date.parse(job.targetAt)<=now))return null;
 const minutes=Math.max(1,Math.ceil((Date.parse(job.targetAt)-now)/60000));
 const body=job.kind==='reminder'?`За графіком відключення за ${minutes} хв. Час зарядитися.`:job.kind==='restoration'?`За графіком відновлення за ${minutes} хв.`:job.kind==='publication'?'Опубліковано графік відключень.':'Графік відключень змінився. Перевір оновлення.';
 return {schemaVersion:1,intentId:job.intentId,profileId:job.profileId,planKey:job.planKey,kind:job.kind,targetAt:job.targetAt,expiresAt:job.expiresAt,title:'Світло',body,tag:'plan:'+job.intentId};
}
export class NotificationWorker {
 constructor({pool,key=null,channels={},onError=()=>{}}){Object.assign(this,{pool,key,channels,onError});this.jobs=new DomainJobs(pool);this.vault=key?new SecretVault(key,'notifications'):null;}
 async tick({stopping=()=>false}={}){
  if(!this.vault)return {state:'not_configured'};
  const profiles=(await this.pool.query('select svitlo_notifications.due_profiles() value')).rows[0].value;
  for(const p of profiles){if(stopping())break;const plan=notificationPlan(p);await this.pool.query('select svitlo_notifications.apply_plan($1,$2,$3,$4,$5)',[p.id,p.revision,plan.key,plan.preferenceKey,JSON.stringify(plan.desired)]);}
  await this.jobs.run('entitlement-project-v1',async({tx,event})=>tx.query('select svitlo_notifications.entitlements_changed($1)',[event.payload.accountId]),{limit:5,stopping});
  await this.jobs.run('notification-delivery-v1',async({tx,event})=>tx.query('select svitlo_notifications.fanout($1)',[event.payload.intentId]),{limit:5,stopping});
  const jobs=(await this.pool.query('select svitlo_notifications.claim() value')).rows[0].value;let accepted=0;
  for(const job of jobs){if(stopping())break;let outcome='canceled';
   try{const channel=this.channels[job.channel];if(!channel?.configured){outcome='retry';continue;}
    // Final owner/revision/expiry/permission/plan check directly before network.
    const profile=(await this.pool.query('select svitlo_notifications.before_send($1,$2,$3) value',[job.id,job.proof,job.installationRevision])).rows[0].value;
    const payload=profile&&notificationPayload(job,profile);if(!payload)continue;
    const token=this.vault.open(job.cipher,'notification:'+job.installationId),ttl=Math.max(1,Math.floor((Date.parse(job.expiresAt)-Date.now())/1000));
    await channel.send(job.channel==='webpush'?JSON.parse(token):token,payload,{ttl});outcome='accepted';accepted++;
   }catch(e){outcome=e.permanent||[404,410].includes(e.statusCode)?'invalid_token':'retry';this.onError('notification_delivery_failed');}
   finally{await this.pool.query('select svitlo_notifications.finish($1,$2,$3)',[job.id,job.proof,outcome]);}
  }
  await this.pool.query('select svitlo_notifications.cleanup()');return {profiles:profiles.length,claimed:jobs.length,accepted};
 }
 async loop({stopping=()=>false}={}){while(!stopping()){try{await this.tick({stopping});}catch{this.onError('notification_worker_failed');}for(let n=0;n<10&&!stopping();n++)await new Promise(r=>setTimeout(r,1000));}}
}
