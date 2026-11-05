import {COLLECTOR_SOURCES} from './regional-sources.mjs';
import {normalizeName} from '../geography/service.mjs';
import {seedDiscovery} from './seed.mjs';

export function sourceCityIdentity(raw){
 let name=raw.replace(/\s*\([^)]*\)\s*$/u,'').trim(),category=null;
 for(const [pattern,type] of [[/^(?:місто\s+|м\.\s*)/u,'M'],[/^(?:село\s+|с\.\s*)/u,'C'],[/^(?:селище(?: міського типу)?\s+|смт\.?\s*|с-ще\.?\s*)/u,'X']]){
  if(pattern.test(name)){name=name.replace(pattern,'');category=type;break;}
 }
 if(!category)for(const [pattern,type] of [[/\s+м\.?$/u,'M'],[/\s+с\.?$/u,'C'],[/\s+(?:смт\.?|с-ще\.?)$/u,'X']])if(pattern.test(name)){name=name.replace(pattern,'');category=type;break;}
 return {name:normalizeName(name),category};
}
export function matchSourceCity(raw,places){const q=sourceCityIdentity(raw);return places.filter(p=>p.active!==false&&(p.level===4||p.category==='K')&&p.search_name===q.name&&(!q.category||p.category===q.category||q.category==='M'&&p.category==='K'));}
export async function initializeRegionalSources(c){
 for(const [op,cfg]of Object.entries(COLLECTOR_SOURCES)){
  const regions=(await c.query('select code from svitlo_geo.places where active and level=1 and code like $1',[cfg.regionPrefix+'%'])).rows;if(regions.length!==1)throw Error('Regional source KATOTTG identity mismatch');
  await c.query('insert into svitlo_discovery.regional_sources(operator_id,region_code,source_url) values($1,$2,$3) on conflict(operator_id) do nothing',[op,regions[0].code,cfg.url]);
 }
 await c.query('insert into svitlo_discovery.operator_turn(operator_id) select operator_id from svitlo_discovery.regional_sources on conflict do nothing');
}
export async function importRegionalRoutes(c,op,items,{branch=null,branchName=null,checkedAt=new Date().toISOString()}={}){
 const cfg=COLLECTOR_SOURCES[op];if(!cfg||!Array.isArray(items)||!items.length||items.length>5000||!Number.isFinite(Date.parse(checkedAt)))throw Error('Invalid regional directory packet');
 const source=(await c.query('select region_code,enabled from svitlo_discovery.regional_sources where operator_id=$1',[op])).rows[0];if(!source?.enabled)throw Error('Regional source is disabled');
 const places=(await c.query('select code,level,category,search_name,active from svitlo_geo.places where active and region_code=$1 and (level=4 or category=\'K\')',[source.region_code])).rows;
 const edition=(await c.query('select version from svitlo_geo.editions where active')).rows[0]?.version;if(!edition)throw Error('Missing geography edition');
 const routes=items.map(item=>{
  if(typeof item.key!=='string'||!item.key||item.key.length>240||typeof item.name!=='string'||!item.name||item.name.length>240||/[\x00-\x1f]/.test(item.key+item.name))throw Error('Invalid source city');
  const routeId=op+':'+(branch||'-')+':'+item.key;if(routeId.length>350)throw Error('Source route identity too long');return {routeId,item,matches:matchSourceCity(item.name,places)};
 });if(new Set(routes.map(r=>r.routeId)).size!==routes.length)throw Error('Duplicate source route');
 await c.query('begin');try{
  await c.query('select pg_advisory_xact_lock(20261105,1023)');
  for(const r of routes){
   const prior=(await c.query('select operator_id,region_code,provider_city_name,evidence from svitlo_geo.routes where id=$1',[r.routeId])).rows[0];
   if(prior&&(prior.operator_id!==op||prior.region_code!==source.region_code||prior.evidence?.origin!=='regional_collector'))throw Error('Regional route identity collision');
   if(prior){const old=(await c.query('select settlement_code from svitlo_geo.route_places where route_id=$1 order by settlement_code',[r.routeId])).rows.map(x=>x.settlement_code),next=r.matches.map(x=>x.code).sort();
    if(prior.provider_city_name!==r.item.name||JSON.stringify(old)!==JSON.stringify(next))throw Object.assign(Error('Existing route binding requires review'),{code:'mapping_review_required'});}
   await c.query(`insert into svitlo_geo.routes(id,operator_id,branch_id,branch_name,provider_city_id,provider_city_name,region_code,source_observed_at,source_url,source_ref,evidence,version)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do update set branch_name=excluded.branch_name,provider_city_name=excluded.provider_city_name,source_observed_at=excluded.source_observed_at,source_ref=excluded.source_ref,active=true`,
    [r.routeId,op,branch,branchName,r.item.key,r.item.name,source.region_code,checkedAt,cfg.url,{cityId:r.item.key,branchId:branch},{origin:'regional_collector',collectorOnly:true,directoryObserved:true},edition]);
   // Human-reviewed links, if introduced later, take precedence over name matching.
   const reviewed=(await c.query("select exists(select 1 from svitlo_geo.route_places where route_id=$1 and match_state='reviewed') ok",[r.routeId])).rows[0].ok;
   if(!reviewed){await c.query('delete from svitlo_geo.route_places where route_id=$1',[r.routeId]);
    for(const p of r.matches)await c.query("insert into svitlo_geo.route_places(route_id,settlement_code,match_state,match_method,candidate_count) values($1,$2,'candidate',$3,$4)",[r.routeId,p.code,r.matches.length===1?'unique_name_type_region':'ambiguous_name_type_region',r.matches.length]);}
  }
  // Apply the current administrative mask immediately, without extending its TTL
  // or pretending that a new source import is a new occupation-status observation.
  await c.query(`insert into svitlo_discovery.territory_routes(route_id,held,occupied_candidates,total_candidates)
   select r.id,count(l.settlement_code)>0 and bool_and(coalesce(p.status='occupied',false)),count(*) filter(where p.status='occupied'),count(l.settlement_code)
   from svitlo_geo.routes r left join svitlo_geo.route_places l on l.route_id=r.id left join svitlo_discovery.territory_places p on p.code=l.settlement_code
   where r.id=any($1::text[]) group by r.id on conflict(route_id) do update set held=excluded.held,occupied_candidates=excluded.occupied_candidates,total_candidates=excluded.total_candidates`,[routes.map(r=>r.routeId)]);
  await c.query('commit');
 }catch(e){await c.query('rollback');throw e;}
 const jobs=await seedDiscovery(c,{routeIds:routes.map(r=>r.routeId)});return {routes:routes.length,mapped:routes.filter(r=>r.matches.length).length,ambiguous:routes.filter(r=>r.matches.length>1).length,jobsSeeded:jobs};
}
