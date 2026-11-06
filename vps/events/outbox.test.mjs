import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {verifyOutbox} from './assertions.mjs';
export const fixture=`create role svitlo_stage_api;create role svitlo_stage_session;create role svitlo_stage_worker;
create schema svitlo_vps;create table svitlo_vps.catalog(id uuid primary key,kind text default 'address',parent_id uuid,label text,operator_id text,redirect_to uuid,metadata jsonb default '{}',source_ref jsonb default '{}');`;
test('transactional events, leases, fencing, retries, projection ordering and role boundaries',async()=>{
 const c=new PGlite();try{await c.exec(fixture);await c.exec(await readFile(new URL('../sql/modular-outbox.sql',import.meta.url),'utf8'));await verifyOutbox(c);}finally{await c.close();}
});
