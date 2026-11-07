import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {randomUUID} from 'node:crypto';import {adminFixture} from './fixture.mjs';
test('single-use tickets, current server RBAC, opaque private tables and bounded pagination',async()=>{
 const c=new PGlite();try{await adminFixture(c);const id=randomUUID(),hash='a'.repeat(64),session='b'.repeat(64);
  await c.query("insert into svitlo_admin.principals(id,label,roles) values($1,'Read-only',array['read-only'])",[id]);await c.query("insert into svitlo_admin.tickets values($1,$2,now()+interval '5 minutes')",[hash,id]);
  await c.exec('set role svitlo_stage_admin');assert.equal((await c.query('select svitlo_admin.login($1,$2) ok',[hash,session])).rows[0].ok,true);assert.equal((await c.query('select svitlo_admin.login($1,$2) ok',[hash,'c'.repeat(64)])).rows[0].ok,false);
  assert.deepEqual((await c.query("select svitlo_admin.list($1,'sources',25,0) value",[session])).rows[0].value,{data:[],total:0});
  await assert.rejects(()=>c.query("select svitlo_admin.list($1,'accounts',25,0)",[session]),e=>e.code==='42501');await assert.rejects(()=>c.query("select svitlo_admin.list($1,'sources',1000,0)",[session]));
  await assert.rejects(()=>c.query('select * from svitlo_admin.sessions'),e=>e.code==='42501');
  await assert.rejects(()=>c.query("select svitlo_admin.command($1,$2,'source.pause','test','A valid reason',$3)",[session,randomUUID(),{until:new Date(Date.now()+3600000).toISOString()}]),e=>e.code==='42501');
  await c.exec('reset role');await c.query('update svitlo_admin.principals set disabled=true where id=$1',[id]);await c.exec('set role svitlo_stage_admin');assert.equal((await c.query('select svitlo_admin.principal($1) value',[session])).rows[0].value,null);
 }finally{await c.close();}
});
test('audited temporary commands are idempotent, revoke accounts, hold source claims, and block sensors without changing epoch/history',async()=>{
 const c=new PGlite();try{await adminFixture(c);const actor=randomUUID(),owner=randomUUID(),sensor=randomUUID(),request=randomUUID(),proof='d'.repeat(64),until=new Date(Date.now()+3600000).toISOString();
  await c.query("insert into svitlo_admin.principals(id,label,roles) values($1,'Owner',array['owner'])",[actor]);await c.query("insert into svitlo_admin.sessions values($1,$2,now()+interval '30 minutes')",[proof,actor]);
  await c.query("insert into svitlo_sources.registry(id,label) values('test-source','Fixture')");await c.query('insert into auth.users(id) values($1)',[owner]);await c.query("insert into svitlo_vps.sessions values('reader',$1,now()+interval '1 day')",[owner]);await c.query("insert into svitlo_sensors.devices values($1,'bound',7,now())",[sensor]);
  const command=async(id,kind,target,data={})=>(await c.query('select svitlo_admin.command($1,$2,$3,$4,$5,$6::jsonb) value',[proof,id,kind,target,'Isolated acceptance scenario',JSON.stringify(data)])).rows[0].value;
  await c.exec('set role svitlo_stage_admin');assert.equal((await command(request,'source.pause','test-source',{until})).accepted,true);assert.equal((await command(request,'source.pause','test-source',{until})).accepted,true);await assert.rejects(()=>command(request,'source.resume','test-source'));
  await command(randomUUID(),'account.block',owner,{until});await command(randomUUID(),'device.block',sensor,{until});await assert.rejects(()=>command(randomUUID(),'source.pause','test-source',{until:new Date(Date.now()+2*86400000).toISOString()}));
  await c.exec('reset role');assert.equal((await c.query('select count(*)::int n from svitlo_vps.sessions')).rows[0].n,0);assert.equal((await c.query('select svitlo_admin.account_allowed($1) ok',[owner])).rows[0].ok,false);assert.equal((await c.query("select svitlo_discovery.source_available_at('test-source')::text value")).rows[0].value,'infinity');
  await c.exec('set role svitlo_stage_api');const blocked=(await c.query('select svitlo_sensors.phone_ingest($1::jsonb,$2) value',[JSON.stringify({sensorId:sensor}),'proof'])).rows[0].value;assert.equal(blocked.http,403);await assert.rejects(()=>c.query('select svitlo_sensors.phone_ingest_before_admin($1,$2)',[{},'proof']),e=>e.code==='42501');
  await c.exec('reset role');assert.equal((await c.query('select current_epoch from svitlo_sensors.devices')).rows[0].current_epoch,7);assert.equal((await c.query('select count(*)::int n from svitlo_admin.commands')).rows[0].n,3);
 }finally{await c.close();}
});
