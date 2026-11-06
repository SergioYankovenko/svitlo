import pg from 'pg';
import {spawnSync} from 'node:child_process';
if(process.env.CI!=='true')throw Error('Isolated CI PostgreSQL required');
const database='svitlo_modular_qa_1026',config={host:'127.0.0.1',user:'svitlo_owner',password:'isolated-history-ci',database:'postgres'};
const c=new pg.Client(config);await c.connect();
try{
 await c.query("do $$ begin if not exists(select from pg_roles where rolname='svitlo_stage_session') then create role svitlo_stage_session nologin;end if;end $$");
 await c.query('create database '+database);
 const r=spawnSync(process.execPath,['vps/events/pg-integration.mjs'],{stdio:'inherit',env:{...process.env,PGHOST:'127.0.0.1',PGDATABASE:database}});if(r.status!==0)process.exitCode=1;
}finally{await c.query('drop database if exists '+database+' with (force)');await c.end();}
