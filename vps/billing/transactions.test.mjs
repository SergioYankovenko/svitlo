import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {billingFixture} from './fixture.mjs';import {BillingWorker} from './worker.js';import {BillingService} from './service.js';
function evidence(vault,owner,extra={}){return {kind:'androidpublisher#subscriptionPurchaseV2',subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',testPurchase:{},externalAccountIdentifiers:{obfuscatedExternalAccountId:vault.account(owner)},lineItems:[{productId:'premium',expiryTime:new Date(Date.now()+86400000).toISOString()}],...extra};}
test('verified rights commit before a separately retryable ACK; lost ACK is recovered without a second provider effect; hold and stale evidence stay distinct',async()=>{
 const {c,pool,owner,vault,register,rights}=await billingFixture();try{
  await c.exec('set role svitlo_stage_api');const purchase=await register('real-shaped-test-purchase');assert.equal(purchase.state,'pending_verification');assert.equal((await rights()).entitlement.maxAddresses,2);
  await assert.rejects(()=>c.query('select token_cipher from svitlo_billing.purchases'),e=>e.code==='42501');
  let state=evidence(vault,owner),ackCalls=0;const provider={configured:true,products:['premium'],lookup:async()=>state,acknowledge:async()=>{ackCalls++;state={...state,acknowledgementState:'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'};throw Error('Lost provider ACK response');}};
  await c.exec('set role svitlo_stage_worker');const worker=new BillingWorker({pool,provider,vault});await worker.tick();
  await c.exec('set role svitlo_stage_api');assert.equal((await rights()).entitlement.maxAddresses,10);assert.equal(ackCalls,1);
  await c.exec('reset role');await c.exec("update svitlo_events.deliveries set next_at=clock_timestamp()-interval '1 second' where consumer='billing-acknowledge-v1'");await c.exec('set role svitlo_stage_worker');await worker.tick();assert.equal(ackCalls,1);
  await c.exec('reset role');assert.equal((await c.query("select state from svitlo_events.deliveries where consumer='billing-acknowledge-v1'")).rows[0].state,'done');
  state={...state,subscriptionState:'SUBSCRIPTION_STATE_ON_HOLD'};await c.exec("update svitlo_billing.purchases set next_at=clock_timestamp()-interval '1 second'");await c.exec('set role svitlo_stage_worker');await worker.tick();await c.exec('set role svitlo_stage_api');assert.equal((await rights()).entitlement.maxAddresses,2);
  await c.exec('reset role');await c.exec("update svitlo_entitlements.grants set active=true,verified_until=clock_timestamp()-interval '1 second'");await c.exec('set role svitlo_stage_api');assert.equal((await rights()).code,'subscription_check_unavailable');
 }finally{await c.close();}
});
test('purchase token ownership is immutable; pending replacement keeps old rights; verified replacement prevents old-token reactivation',async()=>{
 const {c,pool,owner,vault,register,rights}=await billingFixture();try{
  const old=await register('original-purchase-token');let pending=true;const provider={configured:true,products:['premium'],lookup:async({token})=>evidence(vault,owner,token==='new-purchase-token'?{subscriptionState:pending?'SUBSCRIPTION_STATE_PENDING':'SUBSCRIPTION_STATE_ACTIVE',linkedPurchaseToken:'original-purchase-token'}:{}),acknowledge:async()=>{}};
  const worker=new BillingWorker({pool,provider,vault});await worker.tick();const newer=await register('new-purchase-token');await worker.tick();assert.equal((await rights()).entitlement.maxAddresses,10);assert.equal((await c.query('select replaced_by from svitlo_billing.purchases where id=$1',[old.purchaseId])).rows[0].replaced_by,null);
  pending=false;await c.query("update svitlo_billing.purchases set next_at=clock_timestamp()-interval '1 second' where id=$1",[newer.purchaseId]);await worker.tick();assert.equal((await c.query('select replaced_by from svitlo_billing.purchases where id=$1',[old.purchaseId])).rows[0].replaced_by,newer.purchaseId);
  await c.query("update svitlo_billing.purchases set next_at=clock_timestamp()-interval '1 second' where id=$1",[old.purchaseId]);await worker.tick();assert.equal((await register('original-purchase-token')).state,'purchase_replaced');
  const other=randomUUID();await c.query('insert into auth.users(id) values($1)',[other]);await c.query('update svitlo_identity.accounts set recoverable=true where id=$1',[other]);await c.query("select set_config('svitlo.owner_id',$1,false)",[other]);assert.equal((await register('new-purchase-token')).state,'purchase_in_use');assert.equal((await rights()).entitlement.maxAddresses,2);
 }finally{await c.close();}
});
test('RTDN durably deduplicates before ACK; old notifications query current provider state; forged package/proof never writes; grants and events roll back together',async()=>{
 const {c,pool,owner,vault,register,rights}=await billingFixture();try{
  const purchase=await register('rtdn-purchase-token'),pushProof={subscription:'projects/test/subscriptions/play',verify:async()=>true},service=new BillingService({bridge:c,vault,packageName:'ua.svitlo.reader',products:['premium'],pushProof});
  const envelope={subscription:pushProof.subscription,message:{messageId:'rtdn-message',data:Buffer.from(JSON.stringify({packageName:'ua.svitlo.reader',eventTimeMillis:String(Date.now()-3600000),subscriptionNotification:{purchaseToken:'rtdn-purchase-token',notificationType:2}})).toString('base64')}};
  await service.rtdn('proof',envelope);await service.rtdn('proof',envelope);assert.equal((await c.query('select count(*)::int n from svitlo_billing.inbox')).rows[0].n,1);
  const provider={configured:true,products:['premium'],lookup:async()=>evidence(vault,owner,{subscriptionState:'SUBSCRIPTION_STATE_EXPIRED'}),acknowledge:async()=>assert.fail('Expired purchase must not be acknowledged')};await new BillingWorker({pool,provider,vault}).tick();assert.equal((await rights()).entitlement.maxAddresses,2);
  pushProof.verify=async()=>{throw Error('Forged sender');};await assert.rejects(()=>service.rtdn('forged',{...envelope,message:{...envelope.message,messageId:'forged'}}));assert.equal((await c.query('select count(*)::int n from svitlo_billing.inbox')).rows[0].n,1);
  const claim=(await c.query('select svitlo_billing.claim_purchase($1) value',[purchase.purchaseId])).rows[0].value,events=(await c.query('select count(*)::int n from svitlo_events.domain_events')).rows[0].n;
  await c.exec('begin');await c.query("select svitlo_billing.apply_purchase($1,$2,'SUBSCRIPTION_STATE_ACTIVE',clock_timestamp()+interval '1 day',true,true,true,null)",[claim.id,claim.proof]);await c.exec('rollback');assert.equal((await rights()).entitlement.maxAddresses,2);assert.equal((await c.query('select count(*)::int n from svitlo_events.domain_events')).rows[0].n,events);
  assert.equal((await c.query("select svitlo_billing.apply_purchase($1,$2,'SUBSCRIPTION_STATE_ACTIVE',clock_timestamp()+interval '1 day',true,true,true,null) value",[claim.id,randomUUID()])).rows[0].value,false);
  await c.exec('set role svitlo_stage_worker');await assert.rejects(()=>c.query('update svitlo_billing.control set mode=\'live\''),e=>e.code==='42501');
 }finally{await c.close();}
});
