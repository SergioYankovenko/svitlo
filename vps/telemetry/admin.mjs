// SSH-only administrative interface. Never mount owner_password into a public API container.
import pg from 'pg';import {readFile} from 'node:fs/promises';
const [operation,argument]=process.argv.slice(2);
if(!['diagnostics','security','collection'].includes(operation))throw Error('Use diagnostics|security [1..100], or collection on|off');
const amount=argument===undefined?20:Number(argument);
if(operation==='collection'?!['on','off'].includes(argument):!Number.isInteger(amount)||amount<1||amount>100)throw Error('Invalid admin argument');
const c=new pg.Client({host:'postgres',user:'svitlo_owner',database:'svitlo_staging',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await c.connect();
try{
 const r=operation==='collection'?await c.query('select svitlo_telemetry.admin_collection($1) result',[argument==='on']):await c.query('select svitlo_telemetry.admin_read($1,$2) result',[operation,amount]);
 console.log(JSON.stringify({scope:'private-staging-admin',operation,result:r.rows[0].result}));
}finally{await c.end();}
