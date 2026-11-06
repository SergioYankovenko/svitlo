import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {addressGroupCount} from '../../app/lib/address-groups.js';
export async function verifyLineSql(db){
 const owner=randomUUID(),other=randomUUID(),homes=[];let profilesCount=0;
 const as=async(fn,subject=owner)=>{await db.query("select set_config('svitlo.owner_id',$1,false)",[subject]);await db.exec('set role svitlo_stage_api');try{return await fn();}finally{await db.exec('reset role');}};
 const create=addresses=>as(async()=>(await db.query('select public.svitlo_profile_group_create($1,$2,\'Дім\',\'{"lead":30,"reminder":true}\') r',[owner,addresses])).rows[0].r);
 {
  await db.query('insert into auth.users(id) values($1),($2)',[owner,other]);
  await db.exec("insert into svitlo_vps.operators(id,adapter_key,label,state,is_test) values('qa-lines','qa','QA','available',true)");
  const city=(await db.query("insert into svitlo_vps.catalog(kind,label) values('city','QA') returning id")).rows[0].id;
  const street=(await db.query("insert into svitlo_vps.catalog(kind,parent_id,label) values('street',$1,'Street') returning id",[city])).rows[0].id;
  for(let i=0;i<11;i++){
   const home=(await db.query("insert into svitlo_vps.catalog(kind,parent_id,label,operator_id) values('address',$1,$2,'qa-lines') returning id",[street,String(i+1)])).rows[0].id,addresses=[];
   for(let j=0;j<2;j++){const line=(await db.query("insert into svitlo_vps.address_lines(address_id,source_key,label,group_code) values($1,$2,$2,$2) returning id",[home,'line'+j])).rows[0].id;addresses.push({canonicalAddressId:home,operatorId:'qa-lines',department:'universal:qa-lines',cityId:city,streetId:street,city:'QA',street:'Street',house:String(i+1),lineId:line});}homes.push(addresses);
  }
  const thirdLine=(await db.query("insert into svitlo_vps.address_lines(address_id,source_key,label,group_code) values($1,'third','Third','third') returning id",[homes[0][0].canonicalAddressId])).rows[0].id;
  const three=[...homes[0],{...homes[0][0],lineId:thirdLine}];
  const triple=await as(async()=>(await db.query("select public.svitlo_profile_group_create($1,$2,'Три лінії','{}') r",[other,three])).rows[0].r,other);
  assert.equal(triple.profiles.length,3);assert.deepEqual(triple.profiles.map(p=>p.address.lineNumber),[1,2,3]);assert.equal(addressGroupCount(triple.profiles),1);
  const mapAddress={department:'universal:map-only',operatorId:'map-only',mapOnly:true,cityId:city,city:'QA',street:'Map Street',house:'20',lineId:null,mapLocation:{source:'visicom',precision:'house',street:'Map Street',latitude:50.45,longitude:30.52,featureId:'ADRTEST12345'}};
  const map=await as(async()=>(await db.query("select svitlo_maps.create_profile($1,$2,$3,'Мапа','{}') r",['1'.repeat(64),'2'.repeat(64),mapAddress])).rows[0].r,other);
  assert.equal(map.created,true);assert.equal(map.profile.address.mapOnly,true);
  const mapLimit=await as(async()=>(await db.query("select svitlo_maps.create_profile($1,$2,$3,'Мапа','{}') r",['3'.repeat(64),'4'.repeat(64),{...mapAddress,house:'21'}])).rows[0].r,other);
  assert.equal(mapLimit.status,'limit');
  const first=await create(homes[0]);assert.equal(first.profiles.length,2);assert.deepEqual(first.profiles.map(p=>p.address.lineNumber),[1,2]);assert.equal(first.profiles[1].preferences.reminder,false);
  const repeated=await create(homes[0].toReversed());assert.deepEqual(repeated.profiles.map(p=>p.id),first.profiles.map(p=>p.id));assert.equal(repeated.created,false);
  assert.equal((await create(homes[1])).profiles.length,2);assert.equal((await create(homes[2])).status,'limit');
  assert.equal((await db.query('select count(*)::integer n from public.svitlo_profiles where owner=$1',[owner])).rows[0].n,4);
  await db.query("insert into svitlo_sensors.main_app_subscriptions values($1,'private_test',now()-interval '1 minute',now()+interval '1 hour',null)",[owner]);
  for(let i=2;i<10;i++)assert.equal((await create(homes[i])).profiles.length,2);
  assert.equal((await create(homes[10])).status,'limit');
  await assert.rejects(()=>as(()=>db.query('select public.svitlo_profile_group_create($1,$2,\'\',\'{}\')',[other,homes[0]])),/owner mismatch/);
  await assert.rejects(()=>create([{...homes[0][0],lineId:homes[1][0].lineId},homes[0][1]]),/line mismatch/);
  const profiles=(await db.query('select * from public.svitlo_profiles where owner=$1 order by created_at,id',[owner])).rows;
  profilesCount=profiles.length;assert.equal(profiles.length,20);assert.equal(addressGroupCount(profiles),10);
  const sensorPackets=[];
  for(let i=0;i<profiles.length;i++){
   const hash=(i+1).toString(16).padStart(64,'0');await db.query('select svitlo_sensors.admin_provision($1)',[hash]);
   const r=await as(async()=>(await db.query("select svitlo_sensors.command('claim',$1) r",[{requestId:randomUUID(),claimHash:hash,profileId:profiles[i].id}])).rows[0].r);
   assert.equal(r.http,200);assert.equal(r.sensor.lineId,profiles[i].address.lineId);sensorPackets.push(r.sensor);
  }
  assert.equal((await as(async()=>(await db.query("select svitlo_sensors.command('list','{}') r")).rows[0].r)).sensors.length,20);
  const hash='f'.repeat(64);await db.query('select svitlo_sensors.admin_provision($1)',[hash]);
  assert.equal((await as(async()=>(await db.query("select svitlo_sensors.command('claim',$1) r",[{requestId:randomUUID(),claimHash:hash,profileId:profiles[0].id}])).rows[0].r)).code,'profile_already_has_sensor');
  const s=sensorPackets[0];await as(()=>db.query("select svitlo_sensors.command('disconnect',$1)",[{requestId:randomUUID(),sensorId:s.sensorId,bindingEpoch:s.bindingEpoch,confirmed:true}]));
  assert.equal((await as(async()=>(await db.query("select svitlo_sensors.command('list','{}') r")).rows[0].r)).sensors.length,19);
 }
 return {homes:10,lineProfiles:profilesCount,sensors:20};
}

