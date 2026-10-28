import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {Database} from '../../server/database.js';
export async function scalingDatabase() {
 const sql=new PGlite();
 await sql.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['20261023225141_svitlo_pwa.sql','20261026193707_server_concurrency.sql','20261026221004_server_scaling.sql','20261026221349_server_scaling_edges.sql']) {
  if(name.includes('server_concurrency'))await sql.exec('alter table public.svitlo_profiles add column next_check bigint not null default 0;');
  await sql.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 const rpc=async(name,args={})=>{
  const fields=Object.keys(args),params=fields.map((x,i)=>`${x}=>$${i+1}`).join(',');
  if(['svitlo_profiles_read','svitlo_due_v2'].includes(name))return {data:(await sql.query(`select * from public.${name}(${params})`,Object.values(args))).rows,error:null};
  return {data:(await sql.query(`select public.${name}(${params}) as v`,Object.values(args))).rows[0].v,error:null};
 };
 const db=new Database({rpc});
 return {sql,db,rpc:async(name,args)=>(await rpc(name,args)).data};
}
