import test from 'node:test';
import assert from 'node:assert/strict';
import {post,sessionRejected} from '../app/api.js';
import {sensorConnectError} from '../app/lib/sensor-errors.js';
test('network failure is localized without falsely diagnosing no internet',async()=>{await assert.rejects(()=>post('https://test',{},async()=>{throw new TypeError('Failed to fetch')}),e=>e.message==='Оновлення тимчасово недоступне. Спробуйте пізніше.');});
test('non-JSON service outage is localized',async()=>{await assert.rejects(()=>post('https://test',{},async()=>new Response('<h1>Unavailable</h1>',{status:503})),/Оновлення тимчасово недоступне/);});
test('server validation error is retained',async()=>{await assert.rejects(()=>post('https://test',{},async()=>Response.json({error:'Підтвердьте адресу'},{status:400})),/Підтвердьте адресу/);});

test('public server code and bounded retry interval survive without copying response details',async()=>{
 await assert.rejects(()=>post('/test',{},async()=>Response.json({error:'Denied',code:'subscription_required',proof:'must not escape',details:'private'},{status:403,headers:{'Retry-After':'30'}})),e=>{
  assert.equal(e.code,'subscription_required');assert.equal(e.status,403);assert.equal(e.retryAfter,30);assert.equal(e.proof,undefined);assert.equal(e.details,undefined);assert.equal(sessionRejected(e),false);return true;
 });
 for(const code of ['<script>','__proto__','a'.repeat(81),null])await assert.rejects(()=>post('/test',{},async()=>Response.json({error:'Denied',code},{status:400})),e=>e.code===undefined);
});

test('entitlement and ownership refusals do not destroy the anonymous identity',()=>{
 for(const code of ['subscription_required','sensor_owner_required','invitation_not_allowed'])assert.equal(sessionRejected({status:403,code}),false);
 for(const e of [{status:401},{status:403},{status:403,code:'request_rejected'},{status:403,code:'sensor_session_required'},{status:403,code:'csrf_rejected'}])assert.equal(sessionRejected(e),true);
});

test('QR refusal messages distinguish proof, access and temporary failures without reflecting raw data',()=>{
 assert.match(sensorConnectError({code:'owner_qr_not_available'}),/новий QR/);
 assert.match(sensorConnectError({code:'owner_qr_already_used'}),/уже використано/);
 assert.match(sensorConnectError({code:'subscription_required'}),/підписка/);
 assert.match(sensorConnectError({status:429}),/Забагато/);
 for(const code of ['__proto__','constructor','unknown'])assert.equal(typeof sensorConnectError({code,message:'secret-proof'}),'string');
 assert.ok(!sensorConnectError({message:'secret-proof'}).includes('secret-proof'));
});
