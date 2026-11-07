import pg from 'pg';
import {spawnSync} from 'node:child_process';
if(process.env.CI!=='true')throw Error('Isolated CI required');
const database='svitlo_search_qa_20261107',c=new pg.Client({host:'127.0.0.1',user:'svitlo_owner',password:'isolated-history-ci',database:'postgres'});
await c.connect();
try{
 for(const name of ['svitlo_stage_api','svitlo_stage_worker','svitlo_stage_session'])await c.query(`do $$ begin if not exists(select from pg_roles where rolname='${name}') then create role ${name} nologin;end if;end $$`);
 await c.query('create database '+database);
 const r=spawnSync(process.execPath,['vps/search/integration.mjs'],{stdio:'inherit',env:{...process.env,PGHOST:'127.0.0.1',PGDATABASE:database,PGUSER:'svitlo_owner',PGPASSWORD:'isolated-history-ci',MEILI_URL:'http://127.0.0.1:7700',MEILI_MASTER_KEY:'isolated-search-ci-key'}});
 if(r.status!==0)process.exitCode=1;
}finally{await c.query('drop database if exists '+database+' with (force)');await c.end();}
