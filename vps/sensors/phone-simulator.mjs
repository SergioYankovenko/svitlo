import {randomUUID} from 'node:crypto';
import {externalPower,validatePhoneBatch} from './phone.js';
// Device simulator only. Android must persist this queue atomically in app-private storage.
export class PhoneSimulator{
 constructor({state=null}={}){this.bootId=randomUUID();this.monitorId=randomUUID();this.sequence=state?.sequence||0;this.queue=state?.queue||[];this.previous=null;}
 snapshot(){return structuredClone({sequence:this.sequence,queue:this.queue});}
 observe(plugged,{now=Date.now(),elapsed,continuous=false,clockQuality='synchronized'}={}){
  const powerState=externalPower(plugged),at=clockQuality==='synchronized'?new Date(now).toISOString():null,p=this.previous;
  const e={eventId:randomUUID(),sequence:++this.sequence,eventType:'sample',powerState:powerState==='unknown'?null:powerState,observedAt:at,clockQuality,bootId:this.bootId,elapsedRealtimeMs:elapsed,monitorId:this.monitorId,coverage:null};
  if(continuous&&p&&at&&p.observedAt&&p.powerState!==null&&elapsed>p.elapsedRealtimeMs&&elapsed-p.elapsedRealtimeMs<=300000&&now-Date.parse(p.observedAt)===elapsed-p.elapsedRealtimeMs)e.coverage={startAt:p.observedAt,endAt:at,startElapsedMs:p.elapsedRealtimeMs,endElapsedMs:elapsed,powerState:p.powerState};
  this.queue.push(e);this.previous=e;return e;
 }
 restartMonitoring(){this.monitorId=randomUUID();this.previous=null;}
 async flush(key,send){
  while(this.queue.length){const events=[];for(const e of [this.queue.at(-1),...this.queue.slice(0,-1)]){const next={schemaVersion:3,sensorId:key.sensorId,bindingEpoch:key.bindingEpoch,streamId:key.streamId,events:[...events,e]};if(next.events.length>50||Buffer.byteLength(JSON.stringify(next))>16384)break;events.push(e);}
   if(!events.length)throw Error('Event exceeds packet limit');const packet=validatePhoneBatch({schemaVersion:3,sensorId:key.sensorId,bindingEpoch:key.bindingEpoch,streamId:key.streamId,events});const result=await send(packet);
   if(result.schemaVersion!==3||result.sensorId!==key.sensorId||result.bindingEpoch!==key.bindingEpoch||!Array.isArray(result.acknowledged))throw Error('Invalid acknowledgment');
   const sent=new Map(events.map(e=>[e.eventId,e.sequence])),acked=new Set();for(const ack of result.acknowledged){if(sent.get(ack.eventId)!==ack.sequence)throw Error('Unsolicited acknowledgment');acked.add(ack.eventId);}
   if(!acked.size)throw Error('No events acknowledged');this.queue=this.queue.filter(e=>!acked.has(e.eventId));
  }
 }
}
