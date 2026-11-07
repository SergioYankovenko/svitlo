import {readFile} from 'node:fs/promises';
export async function prepareSearchFixture(c,{createRoles=true,installSearch=true}={}){
 if(createRoles)await c.exec('create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session');
 await c.exec(`create schema svitlo_vps;create schema svitlo_geo;create schema svitlo_discovery;create table svitlo_geo.places(code text primary key);grant usage on schema svitlo_vps to svitlo_stage_api,svitlo_stage_worker`);
 const base=await readFile(new URL('../sql/universal.sql',import.meta.url),'utf8');const marker='create function public.svitlo_profile_create_universal(';if(!base.includes(marker))throw Error('Catalog fixture boundary changed');
 await c.exec(base.slice(0,base.indexOf(marker)));
 for(const f of ['catalog-quality.sql','canonical-catalog.sql',...(installSearch?['address-search.sql']:[])])await c.exec(await readFile(new URL('../sql/'+f,import.meta.url),'utf8'));
 await c.exec("insert into svitlo_vps.operators(id,adapter_key,label,state) values('fixture-op','fixture-v1','Synthetic operator','available')");
}
export function poolFor(c){return {query:(...args)=>c.query(...args),connect:async()=>({query:(...args)=>c.query(...args),release(){}})};}
