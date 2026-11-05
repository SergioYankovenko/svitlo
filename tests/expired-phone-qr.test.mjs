import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

for(const manual of [false,true])test(`expired phone proofs are bounded and preserve identity/history (manual columns: ${manual})`,async()=>{
 const db=new PGlite();try{
  await db.exec(`create role svitlo_sensor_owner;create role svitlo_stage_worker;create role svitlo_stage_api;create role anon;create role authenticated;
   create schema svitlo_sensors;grant usage on schema svitlo_sensors to svitlo_sensor_owner,svitlo_stage_worker,svitlo_stage_api,anon,authenticated;
   create table svitlo_sensors.devices(sensor_id uuid primary key,status text,owner_ref text);
   create table svitlo_sensors.phone_devices(sensor_id uuid primary key references svitlo_sensors.devices,
    kind text,control_hash text,registration_hash text,qr_hash text unique,qr_cipher text,qr_expires_at timestamptz,qr_consumed_at timestamptz,
    check((qr_hash is null)=(qr_cipher is null)),check(kind<>'factory' or(qr_hash is not null and qr_expires_at is null)));
   create table svitlo_sensors.binding_history(sensor_id uuid references svitlo_sensors.devices,profile_ref text,samples jsonb);
   insert into svitlo_sensors.devices select md5(i::text)::uuid,'claimed','owner-'||i from generate_series(1,208)i;
   insert into svitlo_sensors.phone_devices select sensor_id,case when owner_ref='owner-207' then 'factory' else 'phone' end,
    'control-'||owner_ref,'registration-'||owner_ref,'proof-'||owner_ref,'cipher-'||owner_ref,
    case when owner_ref='owner-207' then null when owner_ref='owner-206' then now()+interval '10 minutes' else now()-interval '1 minute' end,
    case when owner_ref='owner-1' then now()-interval '2 minutes' else null end from svitlo_sensors.devices;
   update svitlo_sensors.phone_devices set qr_hash=null,qr_cipher=null,qr_expires_at=null where sensor_id=md5('208')::uuid;
   insert into svitlo_sensors.binding_history select sensor_id,'profile-'||owner_ref,'{"on":42,"off":13}' from svitlo_sensors.devices;`);
  if(manual)await db.exec(`alter table svitlo_sensors.phone_devices add manual_code_hash text,add manual_code_cipher text,add manual_qr_hash text,
   add check((manual_code_hash is null)=(manual_code_cipher is null) and(manual_code_hash is null)=(manual_qr_hash is null));
   update svitlo_sensors.phone_devices set manual_code_hash='manual-'||qr_hash,manual_code_cipher='cipher-'||qr_hash,manual_qr_hash=qr_hash where qr_hash is not null;`);
  await db.exec(`alter table svitlo_sensors.devices owner to svitlo_sensor_owner;alter table svitlo_sensors.phone_devices owner to svitlo_sensor_owner;
   alter table svitlo_sensors.phone_devices enable row level security;alter table svitlo_sensors.phone_devices force row level security;
   create policy owner_only on svitlo_sensors.phone_devices to svitlo_sensor_owner using(true) with check(true);`);
  await db.exec(await readFile(new URL('../vps/sql/expired-phone-qr.sql',import.meta.url),'utf8'));
  const before=(await db.query(`select d.*,p.control_hash,p.registration_hash,h.profile_ref,h.samples from svitlo_sensors.devices d join svitlo_sensors.phone_devices p using(sensor_id) join svitlo_sensors.binding_history h using(sensor_id) order by sensor_id`)).rows;
  const cleanup=async()=>{await db.exec('set role svitlo_stage_worker');try{return(await db.query('select svitlo_sensors.expired_phone_qr_cleanup() r')).rows[0].r.expiredPhoneQrSecrets;}finally{await db.exec('reset role');}};
  assert.equal(await cleanup(),100);assert.equal(await cleanup(),100);assert.equal(await cleanup(),5);assert.equal(await cleanup(),0);
  assert.equal((await db.query(`select count(*)::int n from svitlo_sensors.phone_devices where qr_hash is not null`)).rows[0].n,2);
  assert.equal((await db.query(`select count(*)::int n from svitlo_sensors.phone_devices where kind='phone' and qr_expires_at<=now()`)).rows[0].n,0);
  if(manual)assert.equal((await db.query(`select count(*)::int n from svitlo_sensors.phone_devices where manual_code_hash is not null`)).rows[0].n,2);
  assert.deepEqual((await db.query(`select d.*,p.control_hash,p.registration_hash,h.profile_ref,h.samples from svitlo_sensors.devices d join svitlo_sensors.phone_devices p using(sensor_id) join svitlo_sensors.binding_history h using(sensor_id) order by sensor_id`)).rows,before);
  for(const role of ['anon','authenticated','svitlo_stage_api'])assert.equal((await db.query(`select has_function_privilege($1,'svitlo_sensors.expired_phone_qr_cleanup()','execute') ok`,[role])).rows[0].ok,false);
  // A phone can receive another proof after cleanup; it is not a deleted device.
  await db.exec(`update svitlo_sensors.phone_devices set qr_hash='new-proof',qr_cipher='new-cipher',qr_expires_at=now()+interval '15 minutes' where sensor_id=md5('1')::uuid;`);
  assert.equal(await cleanup(),0);
 }finally{await db.close();}
});
