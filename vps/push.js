import {readFileSync} from 'node:fs';
import webpush from 'web-push';
import {validSubscription} from '../server/service.js';

// Only the isolated pilot may opt in. Old releases and disposable preflights stay inert.
export async function pilotPush(p,{enabled=process.env.SVITLO_PILOT_PUSH==='enabled',read=()=>JSON.parse(readFileSync('/run/secrets/pilot_vapid','utf8')),send=webpush.sendNotification.bind(webpush)}={}){
  if(!enabled)return {delivery:'disabled',vapid:'',push:async()=>{throw Error('STAGING_DELIVERY_DISABLED');}};
  const flag=(await p.query('select pilot_push_enabled from svitlo_vps.release_state where id')).rows[0];
  if(flag?.pilot_push_enabled!==true)throw Error('PILOT_PUSH_NOT_AUTHORIZED');
  const keys=read();
  if(!/^[A-Za-z0-9_-]{87}$/.test(keys.publicKey||'')||!/^[A-Za-z0-9_-]{43}$/.test(keys.privateKey||''))throw Error('PILOT_VAPID_INVALID');
  return {delivery:'pilot-enabled',vapid:keys.publicKey,push:async(subscription,payload,{ttl=300}={})=>{
    if(!validSubscription(subscription))throw Object.assign(Error('INVALID_PUSH_SUBSCRIPTION'),{statusCode:410});
    return send(subscription,JSON.stringify(payload),{TTL:Math.max(1,Math.min(3600,ttl)),timeout:10000,
      vapidDetails:{subject:'https://svitlo.guru',publicKey:keys.publicKey,privateKey:keys.privateKey}});
  }};
}

export async function sensorPushTick(rt){
  if(rt.delivery!=='pilot-enabled')return {sent:0};
  await rt.p.query('select svitlo_vps.sensor_notice_sweep()');
  let sent=0;
  for(let n=0;n<10;n++){
    const row=(await rt.p.query('select * from svitlo_vps.sensor_notice_claim()')).rows[0];if(!row)break;
    const valid=(await rt.p.query('select svitlo_vps.sensor_notice_valid($1,$2) ok',[row.id,row.claim])).rows[0]?.ok;
    if(!valid)continue;
    try{
      const types={on:['Світло з’явилося','За даними датчика'],off:['Світло зникло','За даними датчика'],lost:['Зв’язок із датчиком втрачено','Перевір пристрій і з’єднання']};
      const [title,body]=types[row.kind];
      await rt.push(row.subscription,{title,body,tag:'sensor:'+row.id,profile:row.profile_id},{ttl:Math.max(1,Math.min(300,Math.ceil((Date.parse(row.expires_at)-Date.now())/1000)))});
      await rt.p.query('select svitlo_vps.sensor_notice_finish($1,$2,$3)',[row.id,row.claim,'sent']);sent++;
    }catch(error){
      if([404,410].includes(error.statusCode))await rt.db.removeSubscription(row.subscription_id);
      await rt.p.query('select svitlo_vps.sensor_notice_finish($1,$2,$3)',[row.id,row.claim,'retry']);
    }
  }
  return {sent};
}
