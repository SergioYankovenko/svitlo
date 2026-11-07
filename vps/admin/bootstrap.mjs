// SSH/owner-only. Ticket goes to an explicit protected handoff file, never logs.
import pg from 'pg';import {readFile,writeFile} from 'node:fs/promises';import {randomBytes,createHash} from 'node:crypto';
const [principalId,role,file]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/i.test(principalId||'')||!['owner','read-only','operator','support','billing-admin'].includes(role)||!/^\/run\/admin-handoff\/[a-z0-9-]+\.json$/.test(file||''))throw Error('Use <principal UUID> <role> /run/admin-handoff/<name>.json');
const c=new pg.Client({host:'postgres',user:'svitlo_owner',database:'svitlo_staging',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await c.connect();
try{
 const ticket='sa_'+randomBytes(32).toString('base64url'),proof=createHash('sha256').update(ticket).digest('hex');
 await c.query('begin');await c.query("insert into svitlo_admin.principals(id,label,roles) values($1,'SSH administrator',array[$2]) on conflict(id) do nothing",[principalId,role]);
 // Existing principal roles never change implicitly on a new login.
 await c.query("insert into svitlo_admin.tickets values($1,$2,clock_timestamp()+interval '5 minutes')",[proof,principalId]);await c.query('commit');
 await writeFile(file,JSON.stringify({ticket,expiresAt:new Date(Date.now()+300000).toISOString()}),{mode:0o600,flag:'wx'});console.log(JSON.stringify({issued:true,handoffFile:file,expiresInSeconds:300}));
}finally{await c.end();}
