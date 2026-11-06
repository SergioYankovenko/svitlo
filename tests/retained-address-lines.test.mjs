import test from 'node:test';import assert from 'node:assert/strict';
import {Regions} from '../vps/regions/service.js';
import {confirmedLines} from '../app/lib/address-groups.js';
import {createBackgroundAddresses} from '../app/lib/background-addresses.js';
import {UniversalService} from '../vps/universal/service.js';
const now=Date.now(),id='00000000-0000-4000-8000-000000000031';
const entity={id,kind:'address',operator_id:'ua-kyiv-region-dtek',source_ref:{city:'Фастів',street:'вул. Гетьманська',house:'155'},metadata:{sourceCheckedAt:now-86400000}};
const data=()=>({checkedAt:now-60000,houses:{'155':{groups:['GPV2.2','GPV3.1'],partial:false,external:false}}});
const make=value=>new Regions({db:{},secret:'s'.repeat(64),now:()=>now,bridge:{query:async()=>({rows:[{value}]})}});
const dto=proof=>({address:{id,operatorId:entity.operator_id},operator:{id:entity.operator_id,supportState:'available'},resolution:{state:'unknown',complete:false,lines:['2.2','3.1'].map((g,i)=>({id:'line'+i,key:'GPV'+g,groupCode:g,label:g,provenance:{source:'dtek-address',partial:false}})),provenance:{source:'dtek-address',sourceUnavailable:true,retainedIdentity:proof}},selection:{lineId:null}});
test('cached exact full house identity can enroll all lines without claiming a fresh schedule',async()=>{
 const regions=make(data()),proof=await regions.retainedIdentity(entity),r=dto(proof);assert.deepEqual(confirmedLines(r).map(l=>l.groupCode),['2.2','3.1']);
 const flow={house:{id},geography:{settlement:{code:'x'},routes:[{routeId:'r'}]}};
 assert.deepEqual((await createBackgroundAddresses(async()=>r).resolve(flow)).resolved,r);
 const service=new UniversalService({db:{},source:{}},{resolve:async()=>r,catalog:{entity:async()=>entity}});
 const a=await service.canonicalAddress({addressId:id,expandLines:true});assert.deepEqual(a._lineAddresses.map(a=>a.lineId),['line0','line1']);assert.equal(r.resolution.complete,false);assert.equal(r.resolution.provenance.sourceUnavailable,true);
});
test('cache failure never converts an unsupported source into usable identity',async()=>{
 for(const mutate of [x=>x.checkedAt=now+1,x=>x.checkedAt=now-8*86400000,x=>x.houses['155'].partial=true,x=>x.houses['155'].external=true,x=>x.houses['155'].groups=['GPV2.2','bad'],x=>delete x.houses['155']]){const value=data();mutate(value);assert.equal(await make(value).retainedIdentity(entity),null);}
});
test('only matching active server lines from the exact cached address can expand',async()=>{
 const proof=await make(data()).retainedIdentity(entity);
 for(const mutate of [r=>r.address.id='other',r=>r.resolution.lines.pop(),r=>r.resolution.lines[0].provenance.partial=true,r=>r.resolution.provenance.retainedIdentity=null]){const r=dto(structuredClone(proof));mutate(r);assert.deepEqual(confirmedLines(r),[]);const service=new UniversalService({db:{},source:{}},{resolve:async()=>r});await assert.rejects(()=>service.canonicalAddress({addressId:id,expandLines:true}));}
});
test('failed live resolve keeps failure metadata and a bounded address-only proof',async()=>{
 const regions=make(data());regions.address=async()=>{throw Object.assign(Error('forbidden'),{status:503,code:'forbidden'});};const r=await regions.resolve(entity);assert.equal(r.complete,false);assert.equal(r.state,'unknown');assert.deepEqual(r.lines,[]);assert.equal(r.provenance.sourceUnavailable,true);assert.equal(r.provenance.retainedIdentity.addressId,id);
});
