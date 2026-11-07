import test from 'node:test';import assert from 'node:assert/strict';import {corePorts,port,dependencyState} from './ports.js';import {validateContract,openApi} from './contracts.js';
const id='5eef4d44-69f0-4538-a36f-a16b5955d031';
test('an alternate catalogue implementation uses the same HTTP-facing port without changing request/response identities',async()=>{
 const calls=[],catalog={search:async p=>{calls.push(p);return {schemaVersion:1,items:[{id,label:'10/1'}]};},legacy:async p=>p};const reader={catalog,capabilities:()=>({schemaVersion:1}),resolve:async p=>({addressId:p.addressId}),batch:async p=>p,snapshot:async(...p)=>p},service={handle:async(owner,p)=>({owner,...p})};
 const ports=corePorts({reader,service}),query={kind:'houses',parentId:id,q:'10/1'};validateContract('/api/v1/search',query);assert.equal((await ports.catalog.search(query)).items[0].id,id);assert.deepEqual(calls,[query]);assert.equal((await ports.profiles.handle('owner',{action:'sync'})).owner,'owner');assert.ok(Object.isFrozen(ports.catalog));assert.throws(()=>port('BillingProvider',{lookup(){}}));
});
test('shared OpenAPI schemas reject wrong types/private extra fields while installed-client v1 omission stays compatible',()=>{
 validateContract('/api/v1/resolve',{addressId:id});validateContract('/api/v1/snapshots',{schemaVersion:1,items:[{addressId:id}]});
 for(const p of [{kind:'houses',parentId:5},{kind:'houses',parentId:id,limit:51},{kind:'streets',owner:id},{schemaVersion:2,kind:'cities'}])assert.throws(()=>validateContract('/api/v1/search',p));
 assert.throws(()=>validateContract('/api/v1/identity',{schemaVersion:1,action:'complete',nonce:'n'.repeat(43),idToken:'token',accountId:id}));
 const api=openApi();assert.equal(api.openapi,'3.1.0');assert.equal(api.paths['/api/v1/identity'].post.security[0].session.length,0);assert.ok(!JSON.stringify(api).includes('#/$defs/'));
 for(const [error,state]of [[{code:'forbidden'},'blocked'],[{code:'captcha'},'captcha'],[{code:'daily_quota_exceeded'},'quota_exceeded'],[{status:429},'rate_limited'],[{code:'identity_not_configured'},'not_configured'],[{},'degraded']])assert.equal(dependencyState(error),state);
});
