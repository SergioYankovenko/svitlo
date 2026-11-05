import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
export const TERRITORY_SOURCE='https://map-api.minre.gov.ua/map-state';
export const TERRITORY_SOURCE_PAGE='https://dp-reintegration.gov.ua/mapa-terytorij';
const flags=['statusWarfare','statusWarfareWithResources','statusFinishedWarfare','statusPossibleWarfare','statusFinishedPossibleWarfare','statusTemporaryOccupation','statusLiberated'];
const sha=v=>createHash('sha256').update(v).digest('hex');
const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function compileTerritories(records,nodes,{checkedAt=new Date().toISOString(),sourceSha256=null,minRows=10000}={}){
 if(!Array.isArray(records)||records.length<minRows||records.length>100000)throw Error('Invalid territory source volume');
 if(!Number.isFinite(Date.parse(checkedAt)))throw Error('Invalid territory source time');
 const asOfDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(checkedAt));
 const official=new Map(nodes.map(n=>[n.code,n])),current=new Map(),ids=new Set();
 const diagnostics={historicalInvalidIntervals:0,unmatchedCodes:0,overlappingCurrentCodes:0,conflictingStatuses:0,sourceLevelDifferences:0};
 let updatedAt=null;
 for(const r of records){
  if(!Number.isSafeInteger(r.id)||r.id<1||ids.has(r.id)||!/^UA\d{17}$/.test(r.katottgCode)||flags.some(f=>typeof r[f]!=='boolean')||!validDate(r.dateOfChange)||(r.endOrderDate!=null&&!validDate(r.endOrderDate)))throw Error('Invalid territory source row');
  ids.add(r.id);
  if(typeof r.updatedAt!=='string'||!Number.isFinite(Date.parse(r.updatedAt)))throw Error('Invalid territory source update time');
  if(!updatedAt||r.updatedAt>updatedAt)updatedAt=r.updatedAt;
  if(r.endOrderDate&&r.endOrderDate<r.dateOfChange){diagnostics.historicalInvalidIntervals++;continue;}
  // A completed occupation interval must never suppress collection after liberation.
  if(r.dateOfChange>asOfDate||(r.endOrderDate&&r.endOrderDate<=asOfDate))continue;
  const n=official.get(r.katottgCode);if(!n){diagnostics.unmatchedCodes++;continue;}
  if(n.level!==r.katottgLevel)diagnostics.sourceLevelDifferences++;
  const occupied=r.statusTemporaryOccupation;
  const conflicting=occupied&&(r.statusLiberated||r.statusWarfare||r.statusWarfareWithResources||r.statusPossibleWarfare);
  let status=conflicting?'ambiguous':occupied?'occupied':r.statusLiberated?'liberated':r.statusWarfare||r.statusWarfareWithResources?'active_combat':r.statusPossibleWarfare?'possible_combat':r.statusFinishedWarfare||r.statusFinishedPossibleWarfare?'ended':'unknown';
  if(conflicting)diagnostics.conflictingStatuses++;
  if(current.has(r.katottgCode)){diagnostics.overlappingCurrentCodes++;status='ambiguous';}
  current.set(r.katottgCode,{status,sourceCode:r.katottgCode,effectiveFrom:r.dateOfChange,sourceRecordId:r.id});
 }
 if(diagnostics.unmatchedCodes>Math.max(10,current.size*.01))throw Error('Territory KATOTTG join exceeds unmatched allowance');
 const places=[],effective=new Map();
 for(const n of [...nodes].sort((a,b)=>a.level-b.level||a.code.localeCompare(b.code))){
  const own=current.get(n.code),parent=effective.get(n.parentCode);
  // The most specific current record wins; a liberated child overrides a broader old status.
  const evidence=own||parent||{status:'unlisted',sourceCode:null,effectiveFrom:null,sourceRecordId:null};
  const row={...evidence,code:n.code};effective.set(n.code,row);places.push(row);
 }
 const sourceHash=sourceSha256||sha(JSON.stringify(records)),editionHash=sha(JSON.stringify({sourceHash,asOfDate,places}));
 return {schemaVersion:1,sourceUrl:TERRITORY_SOURCE,sourcePage:TERRITORY_SOURCE_PAGE,checkedAt,asOfDate,sourceUpdatedAt:updatedAt,sourceSha256:sourceHash,editionHash,sourceRows:records.length,currentRecords:current.size,diagnostics,places};
}
export async function fetchTerritories(nodes,{fetcher=fetch,now=Date.now}={}){
 const r=await fetcher(TERRITORY_SOURCE,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{accept:'application/json','user-agent':'Svitlo-public-geography/1.0'}});
 if(!r.ok)throw Error('Territory source HTTP '+r.status);
 if(Number(r.headers.get('content-length'))>32000000)throw Error('Territory source too large');
 const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>32000000)throw Error('Territory source too large');chunks.push(chunk);}
 const body=Buffer.concat(chunks);return compileTerritories(JSON.parse(body.toString('utf8')),nodes,{checkedAt:new Date(now()).toISOString(),sourceSha256:sha(body)});
}
export async function loadTerritorySnapshot(){
 const m=JSON.parse(await readFile(new URL('./data/territory-manifest.json',import.meta.url),'utf8'));
 const compressed=await readFile(new URL('./data/territory-status.json.gz',import.meta.url));
 if(sha(compressed)!==m.compressedSha256)throw Error('Territory compressed snapshot mismatch');
 const body=gunzipSync(compressed);if(sha(body)!==m.sha256)throw Error('Territory snapshot mismatch');
 const s=JSON.parse(body);if(s.schemaVersion!==1||s.places.length!==m.placeCount||s.sourceUrl!==TERRITORY_SOURCE)throw Error('Invalid territory snapshot');return s;
}
export async function importTerritories(c,snapshot){
 const s=snapshot||await loadTerritorySnapshot();
 if(s.schemaVersion!==1||s.sourceUrl!==TERRITORY_SOURCE||!/^\d{4}-\d{2}-\d{2}T/.test(s.checkedAt)||!/^[a-f0-9]{64}$/.test(s.sourceSha256)||!/^[a-f0-9]{64}$/.test(s.editionHash))throw Error('Invalid territory import');
 await c.query('begin');
 try{
  await c.query('select pg_advisory_xact_lock(20261105,1022)');
  const current=(await c.query('select checked_at from svitlo_discovery.territory_current where id')).rows[0];
  if(current&&new Date(current.checked_at)>=new Date(s.checkedAt)){await c.query('commit');return {status:'newer_snapshot_retained'};}
  const state={sourceUrl:s.sourceUrl,sourcePage:s.sourcePage,sourceUpdatedAt:s.sourceUpdatedAt,asOfDate:s.asOfDate,sourceRows:s.sourceRows,currentRecords:s.currentRecords,diagnostics:s.diagnostics};
  await c.query('insert into svitlo_discovery.territory_editions(hash,source_hash,first_checked_at,last_checked_at,metadata) values($1,$2,$3,$3,$4) on conflict(hash) do update set last_checked_at=excluded.last_checked_at,metadata=excluded.metadata',[s.editionHash,s.sourceSha256,s.checkedAt,state]);
  await c.query('delete from svitlo_discovery.territory_places');
  await c.query(`insert into svitlo_discovery.territory_places(code,status,source_code,effective_from,source_record_id)
   select code,status,"sourceCode","effectiveFrom"::date,"sourceRecordId" from jsonb_to_recordset($1::jsonb) x(code text,status text,"sourceCode" text,"effectiveFrom" text,"sourceRecordId" bigint)`,[JSON.stringify(s.places)]);
  await c.query(`insert into svitlo_discovery.territory_current(id,edition_hash,checked_at,expires_at) values(true,$1,$2,$2::timestamptz+interval '7 days') on conflict(id) do update set edition_hash=excluded.edition_hash,checked_at=excluded.checked_at,expires_at=excluded.expires_at`,[s.editionHash,s.checkedAt]);
  await c.query('delete from svitlo_discovery.territory_routes');
  await c.query(`insert into svitlo_discovery.territory_routes(route_id,held,occupied_candidates,total_candidates)
   select r.id,count(l.settlement_code)>0 and bool_and(coalesce(p.status='occupied',false)),count(*) filter(where p.status='occupied'),count(l.settlement_code)
   from svitlo_geo.routes r left join svitlo_geo.route_places l on l.route_id=r.id left join svitlo_discovery.territory_places p on p.code=l.settlement_code where r.active group by r.id`);
  const held=(await c.query('select count(*)::int n from svitlo_discovery.territory_routes where held')).rows[0].n;
  await c.query('commit');return {status:'imported',places:s.places.length,heldRoutes:held,checkedAt:s.checkedAt,sourceUpdatedAt:s.sourceUpdatedAt};
 }catch(e){await c.query('rollback');throw e;}
}
