import {loadBundle} from './bundle.mjs';
export async function importGeography(c){
 const {manifest:m,data:d}=await loadBundle();
 const old=(await c.query('select bundle_sha256,active from svitlo_geo.editions where version=$1',[m.bundleVersion])).rows[0];
 if(old){if(old.bundle_sha256!==m.sha256||!old.active)throw Error('Geography edition identity mismatch');return {unchanged:true,version:m.bundleVersion};}
 await c.query('begin');try{
  await c.query('select pg_advisory_xact_lock(311032029)');
  const concurrent=(await c.query('select bundle_sha256,active from svitlo_geo.editions where version=$1',[m.bundleVersion])).rows[0];
  if(concurrent){if(concurrent.bundle_sha256!==m.sha256||!concurrent.active)throw Error('Concurrent geography edition mismatch');await c.query('commit');return {unchanged:true,version:m.bundleVersion};}
  await c.query('insert into svitlo_geo.editions(version,edition_date,source_url,source_sha256,bundle_sha256,node_count,settlement_count,route_count,link_count) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[m.bundleVersion,m.editionDate,m.sourceUrl,m.sourceSha256,m.sha256,m.nodeCount,m.settlementCount,m.routeCount,m.linkCount]);
  // Defer parent FKs while atomically replacing only the public reference layer.
  await c.query('update svitlo_geo.places set active=false');
  for(let i=0;i<d.nodes.length;i+=1000){
   await c.query(`insert into svitlo_geo.aliases(code,alias,search_name,source_url,reason,version)
    select p.code,p.name,p.search_name,e.source_url,'previous_official_name_same_code',p.version from svitlo_geo.places p join svitlo_geo.editions e on e.version=p.version
    join jsonb_to_recordset($1::jsonb) as x("code" text,"searchName" text) on x."code"=p.code where x."searchName"<>p.search_name
    on conflict(code,search_name) do nothing`,[JSON.stringify(d.nodes.slice(i,i+1000))]);
   await c.query(`insert into svitlo_geo.places(code,parent_code,level,category,name,search_name,region_code,district_code,community_code,settlement_code,version)
    select x."code",x."parentCode",x."level",x."category",x."name",x."searchName",x."regionCode",x."districtCode",x."communityCode",x."settlementCode",$2
    from jsonb_to_recordset($1::jsonb) as x("code" text,"parentCode" text,"level" smallint,"category" text,"name" text,"searchName" text,"regionCode" text,"districtCode" text,"communityCode" text,"settlementCode" text)
    on conflict(code) do update set parent_code=excluded.parent_code,level=excluded.level,category=excluded.category,name=excluded.name,search_name=excluded.search_name,region_code=excluded.region_code,district_code=excluded.district_code,community_code=excluded.community_code,settlement_code=excluded.settlement_code,version=excluded.version,active=true`,[JSON.stringify(d.nodes.slice(i,i+1000)),m.bundleVersion]);
  }
  await c.query('update svitlo_geo.routes set active=false');
  for(let i=0;i<d.routes.length;i+=500){
   await c.query(`insert into svitlo_geo.routes(id,operator_id,branch_id,branch_name,provider_city_id,provider_city_name,region_code,source_observed_at,source_url,legacy_catalog_city_id,source_ref,evidence,version)
    select x."id",x."operatorId",x."branchId",x."branchName",x."providerCityId",x."providerCityName",x."regionCode",x."sourceObservedAt",x."sourceUrl",x."legacyCatalogCityId",x."sourceRef",x."evidence",$2
    from jsonb_to_recordset($1::jsonb) as x("id" text,"operatorId" text,"branchId" text,"branchName" text,"providerCityId" text,"providerCityName" text,"regionCode" text,"sourceObservedAt" timestamptz,"sourceUrl" text,"legacyCatalogCityId" uuid,"sourceRef" jsonb,"evidence" jsonb)
    on conflict(id) do update set branch_name=excluded.branch_name,provider_city_name=excluded.provider_city_name,source_observed_at=excluded.source_observed_at,source_url=excluded.source_url,legacy_catalog_city_id=excluded.legacy_catalog_city_id,source_ref=excluded.source_ref,evidence=excluded.evidence,version=excluded.version,active=true`,[JSON.stringify(d.routes.slice(i,i+500)),m.bundleVersion]);
  }
  await c.query('delete from svitlo_geo.route_places');
  await c.query(`insert into svitlo_geo.route_places(route_id,settlement_code,match_state,match_method,candidate_count)
   select x."routeId",x."settlementCode",x."matchState",x."matchMethod",x."candidateCount" from jsonb_to_recordset($1::jsonb) as x("routeId" text,"settlementCode" text,"matchState" text,"matchMethod" text,"candidateCount" integer)`,[JSON.stringify(d.links)]);
  const counts=(await c.query('select (select count(*)::int from svitlo_geo.places where active) places,(select count(*)::int from svitlo_geo.routes where active) routes,(select count(*)::int from svitlo_geo.route_places) links')).rows[0];
  if(counts.places!==m.nodeCount||counts.routes!==m.routeCount||counts.links!==m.linkCount)throw Error('Geography import reconciliation failed');
  await c.query('update svitlo_geo.editions set active=false where active');await c.query('update svitlo_geo.editions set active=true where version=$1',[m.bundleVersion]);
  await c.query('commit');return {version:m.bundleVersion,...counts};
 }catch(e){await c.query('rollback');throw e;}
}
