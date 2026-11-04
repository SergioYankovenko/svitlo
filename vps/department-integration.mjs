import pg from 'pg';import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
import {runtime} from './runtime.js';import {providerTransport} from '../server/provider-transport.js';
if(!/^svitlo_pwa_qa_\d+$/.test(process.env.PGDATABASE||''))throw Error('Disposable PWA QA database required');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database:process.env.PGDATABASE,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const a=await runtime(),b=await runtime('worker'),checks=[];let calls=0;
const check=async(name,fn)=>{await fn();checks.push(name);};
try{
 await admin.query('truncate public.svitlo_source_cache');
 const refs=(await admin.query("select source_ref from svitlo_vps.catalog where kind='address' and operator_id='ua-cherkasy' and svitlo_vps.catalog_allowed(id) order by id limit 2")).rows.map(x=>x.source_ref);assert.equal(refs.length,2);
 const now=Date.now(),date=new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv'}).format(now),time=new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
 const fixture={DATETIME:time+' '+date,DISCONNECTIONS:refs.map(r=>({ADDRESS:`<strong>${r.city}</strong><br>${r.street} ${r.house}<br>`,DATE_START:'10:00 '+date,DATE_STOP:'11:00 '+date,NAME:'PRIVATE_TEST_PERSON',LS:'12345678901'})),DISCONN_QUEUQ:[]};
 for(const rt of [a,b])rt.source.fetcher=providerTransport(rt.db,async()=>{calls++;return Response.json(fixture);});
 let values;
 await check('API and worker coalesce one shared transport per category across PostgreSQL claims',async()=>{values=await Promise.all([a.source.address(refs[0],now),b.source.address(refs[1],now)]);assert.equal(calls,3);assert.ok(values.every(v=>v.failures.length===0));});
 await check('later addresses reuse the parsed durable data without refreshing checkedAt',async()=>{const value=await b.source.address(refs[0],now+1000);assert.equal(calls,3);assert.equal(value.categories.planned.checkedAt,values[0].categories.planned.checkedAt);assert.equal(value.categories.hourly.events.length,1);});
 await check('persisted cache has no raw rows, accounts, names or public address text',async()=>{const rows=(await admin.query('select value from public.svitlo_source_cache')).rows;assert.equal(rows.length,3);const text=JSON.stringify(rows);for(const field of ['PRIVATE_TEST_PERSON','12345678901','<strong>',refs[0].street])assert.ok(!text.includes(field));});
 await check('API role cannot modify authoritative catalog or bypass RLS',async()=>{assert.equal((await a.p.query('select rolbypassrls from pg_roles where rolname=current_user')).rows[0].rolbypassrls,false);await assert.rejects(()=>a.p.query('update svitlo_vps.catalog set label=label'),e=>e.code==='42501');});
 console.log(JSON.stringify({scope:'department-shared-postgresql',passed:checks.length,checks,syntheticProviderRequests:calls,realOperatorRequests:0}));
}finally{await Promise.all([a.p.end(),b.p.end(),admin.end()]);}
