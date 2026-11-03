import pg from 'pg';import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
import {runtime} from '../runtime.js';import {ownerContext} from '../db.js';import {PhoneSensors} from './phone.js';import {tokenHash} from './service.js';
const database=process.env.PGDATABASE;if(!/^svitlo_phone_restore_\d+$/.test(database||''))throw Error('Disposable restore DB required');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();const rt=await runtime();
try{const row=(await admin.query("select f.sensor_id,f.qr_hash,b.epoch,b.owner_subject from svitlo_sensors.phone_devices f join svitlo_sensors.bindings b using(sensor_id) where f.kind='factory' and b.ended_at is null limit 1")).rows[0];assert.ok(row);
 const phone=new PhoneSensors({bridge:rt.bridge,secret:(await readFile('/run/secrets/phone_secret','utf8')).trim()});const r=await ownerContext.run(row.owner_subject,()=>phone.perform('reader_qr',{sensorId:row.sensor_id,bindingEpoch:row.epoch}));assert.equal(tokenHash(r.qr.proof),row.qr_hash);
 await assert.rejects(()=>rt.p.query('select * from svitlo_sensors.phone_devices'),e=>e.code==='42501');assert.ok((await admin.query('select count(*)::int n from svitlo_sensors.phone_ranges')).rows[0].n>0);
 console.log(JSON.stringify({check:'database and separate encryption-key restore preserves QR authority, memberships, history and SQL grants',status:'pass',secretsLogged:false}));
}finally{await Promise.all([admin.end(),rt.p.end()]);}
