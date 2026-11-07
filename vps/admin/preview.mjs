// Local synthetic browser fixture; never connects to VPS or upstream sources.
import {PGlite} from '@electric-sql/pglite';import {randomUUID,randomBytes,createHash} from 'node:crypto';import {writeFile} from 'node:fs/promises';import {adminFixture} from './fixture.mjs';import {createAdminServer} from './server.js';
if(process.env.ADMIN_LOCAL_QA!=='synthetic-only')throw Error('Explicit isolated fixture required');
const c=new PGlite();await adminFixture(c);const actor=randomUUID(),ticket='sa_'+randomBytes(32).toString('base64url'),proof=createHash('sha256').update(ticket).digest('hex');
await c.query("insert into svitlo_admin.principals(id,label,roles) values($1,'Локальна QA',array['owner'])",[actor]);await c.query("insert into svitlo_admin.tickets values($1,$2,now()+interval '5 minutes')",[proof,actor]);
await c.query("insert into svitlo_sources.registry(id,label,family,verification_state) values('fixture-source','Тестове джерело','synthetic','fixture')");await c.query("insert into svitlo_sources.state values('fixture-source',now(),now(),'accepted')");
await writeFile('../wave-02/admin-preview-ticket.json',JSON.stringify({ticket}),{mode:0o600});await c.exec('set role svitlo_stage_admin');
const server=createAdminServer({pool:c,secret:randomBytes(32).toString('hex'),origin:'http://localhost:18769'});server.listen(18769,'127.0.0.1',()=>console.log(JSON.stringify({localSyntheticPreview:'http://localhost:18769',credentialPrinted:false})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await c.close();process.exit(0);}));
