import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes} from 'node:crypto';
import {SensorAccess,validateSensor,tokenHash,sensorCapabilities} from './service.js';
const req=(action,data={})=>({schemaVersion:1,action,...data});const token=prefix=>prefix+'_'+randomBytes(32).toString('base64url');
test('sensor capability is foundation/test-only and never claims power/ingest/recovery support',()=>{assert.equal(sensorCapabilities.foundationOnly,true);assert.equal(sensorCapabilities.testOnly,true);for(const k of ['ingest','observations','prediction','transfer','recovery'])assert.equal(sensorCapabilities[k],false);});
test('sensor packet allows exact actions, UUID/epoch and proof formats only',()=>{
 assert.deepEqual(validateSensor(req('list')),{action:'list',data:{}});
 for(const p of [req('claim',{requestId:randomUUID(),profileId:randomUUID(),claimToken:'DEMO-1'}),req('get',{sensorId:randomUUID(),bindingEpoch:0}),req('transfer'),req('list',{owner:'forged'}),req('invite_accept',{requestId:randomUUID(),profileId:randomUUID(),inviteToken:token('si'),role:'owner'})])assert.throws(()=>validateSensor(p),e=>e.status===400);
 assert.throws(()=>validateSensor(req('disconnect',{requestId:randomUUID(),sensorId:randomUUID(),bindingEpoch:1,confirmed:false})),e=>e.status===409);
});
test('wire secrets become hashes before any SQL call',()=>{
 const raw=token('sc'),value=validateSensor(req('claim',{requestId:randomUUID(),profileId:randomUUID(),claimToken:raw}));assert.equal(value.data.claimHash,tokenHash(raw));assert.equal(JSON.stringify(value).includes(raw),false);assert.equal(value.data.claimToken,undefined);
});
test('invite response retry recovers original token from nonce without exposing hashes or nonce',async()=>{
 const owner=randomUUID(),data={requestId:randomUUID(),sensorId:randomUUID(),bindingEpoch:1},nonce=randomUUID();let source;
 const s=new SensorAccess({secret:'test-only-independent-key',db:{rate:async()=>true},bridge:{query:async(sql,args)=>{source=JSON.parse(args[1]);return {rows:[{result:{http:200,schemaVersion:1,invitation:{sensorId:data.sensorId},privateNonce:nonce,privateHash:tokenHash(s.inviteToken(owner,data,nonce))}}]};}}});
 const one=await s.handle(owner,req('invite_create',data)),two=await s.handle(owner,req('invite_create',data));assert.equal(one.invitation.inviteToken,two.invitation.inviteToken);assert.equal(one.privateHash,undefined);assert.equal(one.privateNonce,undefined);assert.equal(source.tokenHash.length,64);
 assert.notEqual(s.inviteToken(owner,data,nonce),s.inviteToken(owner,data,randomUUID()));assert.notEqual(s.inviteToken(owner,data,nonce),s.inviteToken(randomUUID(),data,nonce));
});
test('sensor id/installation id never substitute for authentication or bootstrap proof',async()=>{
 const s=new SensorAccess({secret:'test',db:{rate:async()=>true},bridge:{query:async()=>{throw Error('must not reach SQL');}}});await assert.rejects(()=>s.handle(null,req('list')),e=>e.status===401);assert.throws(()=>validateSensor(req('claim',{requestId:randomUUID(),profileId:randomUUID(),sensorId:randomUUID(),installationId:randomUUID()})),e=>e.status===400);
});
test('missing/rotated invitation key fails closed instead of returning a bogus capability',async()=>{
 const s=new SensorAccess({secret:'changed',db:{rate:async()=>true},bridge:{query:async()=>({rows:[{result:{http:200,invitation:{},privateNonce:randomUUID(),privateHash:'0'.repeat(64)}}]})}});await assert.rejects(()=>s.handle(randomUUID(),req('invite_create',{requestId:randomUUID(),sensorId:randomUUID(),bindingEpoch:1})),e=>e.status===503);
});
