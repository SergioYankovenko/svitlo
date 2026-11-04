// Ephemeral CI PostgreSQL service, never a VPS database or credential.
import pg from 'pg';import {readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
if(process.env.CI!=='true')throw Error('GitHub Actions isolated PostgreSQL service required');
const database='svitlo_sources_qa_1012',config={host:'127.0.0.1',user:'svitlo_owner',password:'isolated-history-ci'};
const c=new pg.Client({...config,database:'postgres'});await c.connect();
let qa;
try{
 await c.query("create role svitlo_region_owner nologin nobypassrls;create role svitlo_stage_worker login password 'isolated-history-ci' nobypassrls;create role svitlo_stage_api login password 'isolated-history-ci' nobypassrls;");
 await c.query('create database '+database);qa=new pg.Client({...config,database});await qa.connect();
 await qa.query('create table public.svitlo_profiles(id uuid,owner uuid,address jsonb,name text,preferences jsonb)');
 await qa.query("insert into public.svitlo_profiles values(gen_random_uuid(),gen_random_uuid(),'{\"synthetic\":true}','isolated CI profile','{}')");
 await qa.query(await readFile(new URL('../sql/source-history.sql',import.meta.url),'utf8'));await qa.end();qa=null;
 const run=spawnSync(process.execPath,['vps/regions/source-history-integration.mjs'],{stdio:'inherit',env:{...process.env,PGHOST:'127.0.0.1',PGDATABASE:database,SOURCE_HISTORY_CI:'true'}});
 if(run.status!==0)process.exitCode=1;
}finally{await qa?.end();await c.query('drop database if exists '+database+' with (force)');await c.end();}
