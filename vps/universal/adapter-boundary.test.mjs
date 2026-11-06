import test from 'node:test';
import assert from 'node:assert/strict';
import {validResolution,validSnapshot} from './validate.js';
import {AdapterRegistry} from './adapter-registry.js';
import {createAdapterRegistry} from './adapters.js';
import {UniversalReader} from './reader.js';
import {normalizeLegacy} from './normalize.js';
const good=()=>({state:'resolved',complete:true,checkedAt:100,lines:[{key:'a',label:'Лінія А',groupCode:'7.2/A'}]});
test('malformed source replies never reach catalogue writes and errors contain no source payload',async()=>{
 const values=[null,{}, {...good(),checkedAt:'100'}, {...good(),checkedAt:Infinity}, {...good(),checkedAt:-1},
  {...good(),lines:[...good().lines,...good().lines]}, {...good(),lines:[null]}, {...good(),lines:[{key:'a\n',label:'x'}]}];
 for(const value of values){
  assert.equal(!!validResolution(value),false);
  let writes=0;const adapterRegistry=new AdapterRegistry().register({key:'external-v1',create:()=>({resolve:async()=>value,snapshot:async()=>null})});
  const reader=new UniversalReader({db:{},bridge:{},secret:'test',adapterRegistry});
  reader.catalog={operator:async()=>({id:'op',adapter_key:'external-v1',state:'available',config:{}}),public:e=>e,lines:async()=>{writes++;}};
  await assert.rejects(()=>reader.resolveEntity({id:'home',operator_id:'op'}),e=>e.code==='invalid_adapter_resolution'&&e.message==='invalid_adapter_resolution');
  assert.equal(writes,0);
 }
});
test('a new adapter can be injected without modifying reader; existing allowlists remain enforced',async()=>{
 const registry=createAdapterRegistry();
 assert.equal(registry.for({id:'real',adapter_key:'qa-grid-v1',is_test:false},{}),null);
 assert.equal(registry.for({id:'real',adapter_key:'qa-grid-v1',is_test:'true'},{}),null);
 assert.equal(registry.for({id:'other',adapter_key:'cherkasy-v1'},{}),null);
 assert.equal(registry.for({id:'real',adapter_key:'file:///etc/secret'},{}),null);
 registry.register({key:'independent-v1',operatorIds:['new-op'],create:()=>({resolve:async()=>good(),snapshot:async()=>null})});
 assert.throws(()=>registry.register({key:'independent-v1',create:()=>({})}),/registration/);
 const reader=new UniversalReader({db:{},bridge:{},secret:'test',adapterRegistry:registry});
 reader.catalog={operator:async()=>({id:'new-op',adapter_key:'independent-v1',state:'available',config:{}}),public:e=>e,lines:async(id,result)=>({...result,addressId:id})};
 const r=await reader.resolveEntity({id:'home',operator_id:'new-op'});assert.equal(r.resolution.lines[0].groupCode,'7.2/A');assert.equal(r.resolution.addressId,'home');
});
test('snapshot validation preserves normalizer output and rejects cross-address, invalid date and numeric strings',()=>{
 const entity={id:'home',operator_id:'op'},range={fromDate:'2026-11-07',toDate:'2026-11-07'};
 const snapshot=normalizeLegacy(entity,{categories:{},plans:[],emergencies:[]},{state:'unknown',complete:false,lines:[]},range,1000);
 assert.equal(validSnapshot(snapshot,entity),true);
 for(const mutate of [s=>s.addressId='other',s=>s.operatorId='other',s=>s.coverage.fromDate='2026-02-30',s=>s.checkedAt='1000',s=>s.freshUntil=Infinity]){
  const s=structuredClone(snapshot);mutate(s);assert.equal(!!validSnapshot(s,entity),false);
 }
});
test('invalid adapter snapshot retains prior evidence as degraded instead of publishing it as fresh',async()=>{
 const entity={id:'home',operator_id:'op',kind:'address'},range={fromDate:'2026-11-07',toDate:'2026-11-07'};
 const previous=normalizeLegacy(entity,{categories:{},plans:[],emergencies:[]},{state:'unknown',complete:false,lines:[]},range,1000);
 const registry=new AdapterRegistry().register({key:'broken',create:()=>({resolve:async()=>good(),snapshot:async()=>({value:{...previous,addressId:'other'}})})});
 const reader=new UniversalReader({db:{},bridge:{query:async()=>({rows:[{value:previous}]})},secret:'test',adapterRegistry:registry});
 reader.catalog={entity:async()=>entity,operator:async()=>({id:'op',adapter_key:'broken',state:'available'})};
 reader.resolveEntity=async()=>({resolution:{...good(),lines:[]}});reader.shared={load:async(scope,read)=>read()};
 const result=await reader.snapshot('home',range);
 assert.equal(result.addressId,'home');assert.equal(result.supportState,'degraded');
 assert.equal(result.sourceUpdatedAt,previous.sourceUpdatedAt);assert.deepEqual(result.lines,previous.lines);
});
