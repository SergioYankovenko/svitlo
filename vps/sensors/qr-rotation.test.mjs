import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {PhoneSensors,normalizeManualCode,validateQr} from './phone.js';
test('native rotate requires exact UUID request identity and control credential',async()=>{
 let queries=0;const p=new PhoneSensors({secret:'a'.repeat(64),bridge:{query:async()=>{queries++;throw Error('unexpected query');}}}),header='Bearer '+p.token('sd'),base={schemaVersion:1,action:'rotate_owner_qr',sensorId:randomUUID(),requestId:randomUUID()};
 for(const value of [{...base,requestId:'invalid'},(({requestId,...x})=>x)(base),{...base,proof:p.token('sp')},{...base,schemaVersion:2}])await assert.rejects(()=>p.control(header,value),e=>e.status===400);
 await assert.rejects(()=>p.control('Bearer '+p.token('st'),base),e=>e.status===401);assert.equal(queries,0);
});
test('rotation uses distinct SQL operation and returns no cipher or secret hash DTO',async()=>{
 const requestId=randomUUID(),sensorId=randomUUID();let captured;
 const p=new PhoneSensors({secret:'a'.repeat(64),bridge:{query:async(sql,args)=>{captured={sql,data:JSON.parse(args[0])};return {rows:[{result:{http:200,schemaVersion:1,kind:'phone_owner',requestId,expiresAt:'2026-11-05T00:15:00.000Z',duplicate:false,privateCipher:captured.data.qrCipher,privateHash:captured.data.qrHash,manualCipher:captured.data.manualCipher,manualHash:captured.data.manualHash}}]};}}});
 const result=await p.control('Bearer '+p.token('sd'),{schemaVersion:1,action:'rotate_owner_qr',sensorId,requestId});
 assert.ok(captured.sql.includes('phone_qr_rotate'));assert.equal(captured.data.requestId,requestId);assert.equal(result.requestId,requestId);
 assert.ok(result.qr.kind==='phone_owner'&&result.qr.sensorId===sensorId&&result.qr.proof.startsWith('sp_'));
 assert.ok(/^[0-9]{6}$/.test(result.manualCode));assert.ok(['privateCipher','privateHash','manualCipher','manualHash'].every(k=>!Object.hasOwn(result,k)));
});
test('six ASCII digits remain a string including leading zero',()=>{
 assert.equal(normalizeManualCode(' 042715 '),'042715');assert.equal(validateQr({version:1,kind:'phone_code',code:'042715'}).code,'042715');
 for(const value of [42715,123456,'12345','1234567','１２３４５６','12 3456'])assert.throws(()=>normalizeManualCode(value),e=>e.status===400);
 assert.throws(()=>validateQr({version:1,kind:'phone_code',code:'042715',proof:'extra'}),e=>e.status===400);
});
test('manual lookup uses keyed hash and never sends plain code to SQL',async()=>{
 let packet;const p=new PhoneSensors({secret:'a'.repeat(64),bridge:{query:async(sql,args)=>{packet=JSON.parse(args[0]);assert.ok(sql.includes('phone_code_connect'));return {rows:[{result:{http:200,outcome:'already_owner'}}]};}}});
 await p.reader(randomUUID(),{schemaVersion:1,action:'connect_qr',requestId:randomUUID(),qr:{version:1,kind:'phone_code',code:'042715'}});
 assert.ok(packet.codeHash===p.manualHash('042715')&&!JSON.stringify(packet).includes('042715'));
 assert.notEqual(p.manualHash('042715'),new PhoneSensors({secret:'b'.repeat(64)}).manualHash('042715'));
});
test('collision retry uses the same request identity with new candidate',async()=>{
 const ids=[],hashes=[];let n=0;const p=new PhoneSensors({secret:'a'.repeat(64),bridge:{query:async(sql,args)=>{const d=JSON.parse(args[0]);ids.push(d.requestId);hashes.push(d.manualHash);return {rows:[{result:++n<3?{http:409,code:'phone_manual_code_collision'}:{http:200,kind:'phone_owner',privateCipher:d.qrCipher,privateHash:d.qrHash,manualCipher:d.manualCipher,manualHash:d.manualHash}}]};}}});
 const id=randomUUID(),r=await p.control('Bearer '+p.token('sd'),{schemaVersion:1,action:'rotate_owner_qr',sensorId:randomUUID(),requestId:id});
 assert.equal(ids.length,3);assert.ok(ids.every(x=>x===id)&&new Set(hashes).size>=2&&/^[0-9]{6}$/.test(r.manualCode));
});
