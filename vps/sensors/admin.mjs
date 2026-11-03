// Explicit SSH administration only. Claim tokens are secrets; do not capture provision output in reports.
import pg from 'pg';import {readFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';import {tokenHash} from './service.js';
const [action,sensor]=process.argv.slice(2);if(!['provision','reissue','purge','list'].includes(action))throw Error('Use provision, reissue <inactive-test-id>, purge <inactive-test-id>, list');
if(['reissue','purge'].includes(action)&&!/^[a-f0-9-]{36}$/i.test(sensor||''))throw Error('Valid test sensor UUID required');
const c=new pg.Client({host:'postgres',user:'svitlo_owner',database:'svitlo_staging',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await c.connect();
try{
 if(action==='provision'||action==='reissue'){const code='sc_'+randomBytes(32).toString('base64url'),r=await c.query('select svitlo_sensors.admin_provision($1,$2) result',[tokenHash(code),sensor||null]);console.log(JSON.stringify({...r.rows[0].result,claimToken:code,warning:'TEST IDENTITY ONLY; keep this bootstrap secret private'}));}
 else if(action==='purge'){await c.query('select svitlo_sensors.admin_purge_test($1)',[sensor]);console.log(JSON.stringify({purgedTestIdentity:true}));}
 else console.log(JSON.stringify({testOnly:true,devices:(await c.query('select sensor_id,status,current_epoch,created_at from svitlo_sensors.devices order by created_at limit 100')).rows}));
}finally{await c.end();}
