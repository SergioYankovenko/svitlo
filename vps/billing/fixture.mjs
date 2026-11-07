import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {randomBytes,randomUUID} from 'node:crypto';import {adminFixture} from '../admin/fixture.mjs';import {PurchaseVault} from './vault.js';
export async function billingFixture(){
 const c=new PGlite();await adminFixture(c);
 await c.exec(`drop table svitlo_events.deliveries;drop function svitlo_events.replay_delivery(uuid,uuid,uuid,text);create role svitlo_events_owner;alter schema svitlo_events owner to svitlo_events_owner;grant usage on schema svitlo_events to svitlo_stage_worker;
 create table public.svitlo_profiles(id uuid primary key default gen_random_uuid(),owner uuid);alter table public.svitlo_profiles enable row level security;
 create table svitlo_sensors.bindings(owner_subject uuid,ended_at timestamptz);alter table svitlo_sensors.bindings enable row level security;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('svitlo.owner_id',true),'')::uuid$$;grant usage on schema auth to svitlo_stage_api,svitlo_sensor_owner;grant execute on function auth.uid() to svitlo_sensor_owner,svitlo_stage_api;`);
 for(const f of ['domain-jobs.sql','identity.sql','entitlements.sql','billing.sql'])await c.exec(await readFile(new URL('../sql/'+f,import.meta.url),'utf8'));
 const owner=randomUUID(),vault=new PurchaseVault(randomBytes(32).toString('hex'));await c.query('insert into auth.users(id) values($1)',[owner]);await c.query('update svitlo_identity.accounts set recoverable=true where id=$1',[owner]);await c.query("select set_config('svitlo.owner_id',$1,false)",[owner]);await c.exec("update svitlo_billing.control set mode='license',accepting=true,worker_ready=true,last_worker_at=clock_timestamp()");
 const pool={query:(...args)=>c.query(...args),connect:async()=>({query:(...args)=>c.query(...args),release(){}})};
 const register=async(token,product='premium')=>{const hashed=vault.hash(token);return (await c.query('select svitlo_billing.register_purchase($1,$2,$3) value',[hashed,vault.seal(token,hashed),product])).rows[0].value;};
 const rights=async()=>(await c.query('select svitlo_sensors.main_app_entitlement() value')).rows[0].value;
 return {c,pool,owner,vault,register,rights};
}
