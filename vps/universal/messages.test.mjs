import test from 'node:test';import assert from 'node:assert/strict';
import {seal} from './normalize.js';import {universalEnvelope} from '../../app/lib/universal-contract.js';
import {universalMessages} from './messages.js';import {UniversalService} from './service.js';
import {civil} from '../../app/lib/time.js';
const date='2026-11-04',now=civil(date,720);
function snapshot(start=960){return seal({schemaVersion:1,addressId:'a',operatorId:'ua-cherkasy',timeZone:'Europe/Kyiv',coverage:{fromDate:date,toDate:date},resolution:{state:'resolved',complete:true},
 lines:[{id:'l',label:'Лінія',groupCode:'3.2',supportedCategories:['hourly','emergency'],categories:Object.fromEntries(['hourly','emergency'].map(k=>[k,{checkedAt:now,sourceUpdatedAt:now-1000,freshUntil:now+3600000,days:[{date,state:'published',intervals:k==='hourly'?[{start:civil(date,start),end:civil(date,start+120)}]:[]}]}]))}],
 notices:[],provenance:[],checkedAt:now,sourceUpdatedAt:now-1000,freshUntil:now+3600000,refreshAfter:now+300000,supportState:'available'});}
test('universal publication and change messages keep approved text and do not change on reads',()=>{
 const a=universalEnvelope(snapshot(),'l'),first=universalMessages(a,{},now);assert.equal(first[0].title,'Графік на 4 листопада');assert.equal(first[0].revisionType,'publication');
 const next={...a,universal:seal({...a.universal,checkedAt:now+1000})};const same=universalMessages(next,a,now+1000,first);assert.deepEqual(same,first);
 const b=universalEnvelope(snapshot(1000),'l'),changed=universalMessages(b,a,now+2000,first);assert.equal(changed[0].title,'Графік на 4 листопада оновлено');assert.notEqual(changed[0].id,first[0].id);
 const reverted=universalMessages(a,b,now+3000,[...first,...changed]);assert.notEqual(reverted[0].id,first[0].id,'A→B→A is a new revision');
});
test('universal notifications reject stale/unknown plans and separate regional warnings from address emergencies',()=>{
 const a=snapshot();assert.equal(universalMessages(universalEnvelope(seal({...a,supportState:'degraded'}),'l'),{},now).length,0);
 a.notices=[{kind:'regional_emergency',active:true,start:now-1000,sourceUpdatedAt:now}];
 const regional=universalMessages(universalEnvelope(seal(a),'l'),{},now).filter(m=>m.kind==='emergency');assert.equal(regional.length,1);assert.equal(regional[0].scope,'region');
 a.lines[0].categories.emergency.days[0].intervals=[{start:now-60000,end:now+60000}];
 assert.equal(universalMessages(universalEnvelope(seal(a),'l'),{},now).filter(m=>m.scope==='address').length,1);
});
test('universal refresh sends only opted-in new current/address messages after enrollment',async()=>{
 let wire=snapshot(),sent=[];const base={id:'p',owner:'o',address:{canonicalAddressId:'a',lineId:'l'},preferences:{publication:true,change:true,emergency:true},snapshot:{},messages:[],last_checked:0,snapshot_revision:0};
 const db={commitProfile:async p=>({status:'updated',profile:p}),enqueue:async e=>sent.push(e)};
 const service=new UniversalService({db,source:{},push:async()=>{},now:()=>now}, {snapshot:async()=>wire,range:()=>({})});
 const first=await service.refresh(base);assert.equal(sent.length,0,'enrollment never replays old history');
 await service.refresh(first);assert.equal(sent.length,0,'same content does not send');
 wire=snapshot(1000);const changed=await service.refresh(first);assert.equal(sent.length,1);assert.equal(sent[0].channel,'change');assert.equal(changed.messages.length,2);
 wire=snapshot(1050);await service.refresh({...changed,preferences:{...changed.preferences,change:false}});assert.equal(sent.length,1);
});
test('canonical profile creation uses pilot notification defaults atomically',async()=>{
 let captured;const defaults={publication:false,change:false,schedule:false,emergency:false,reminder:false,restoration:false,lead:30};
 const db={rate:async()=>true,result:async x=>x,c:{rpc:async(_name,args)=>{captured=args;return {status:'created',profile:{id:'p'}};}}};
 const service=new UniversalService({db,source:{},now:()=>now,defaultPreferences:defaults},{catalog:{validateLegacy:async()=>{}}});
 service.canonicalAddress=async()=>({canonicalAddressId:'a'});service.refresh=async p=>({...p,address:{},preferences:defaults});
 await service.handle('o',{action:'save',confirmed:true,address:{canonicalAddressId:'a'}});assert.deepEqual(captured.preference_data,defaults);
});
