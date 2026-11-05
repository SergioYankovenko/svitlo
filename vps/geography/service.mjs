import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const expectedEdition=JSON.parse(readFileSync(new URL('./data/manifest.json',import.meta.url),'utf8'));
const code=/^UA[0-9]{17}$/;
export const geoProblem=(status,value)=>Object.assign(Error('Некоректний запит до довідника населених пунктів'),{status,code:value,reason:'schema'});
export const normalizeName=s=>s.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[’ʼ`]/g,"'").replace(/\s+/gu,' ').trim();
const prefixes=/^(?:(?:місто|село|селище(?: міського типу)?)(?:\s+|$)|(?:м\.|с\.|смт\.?|с-ще\.?)(?:\s*))/u;
const searchName=s=>normalizeName(s).replace(prefixes,'').trim();
function exact(p,allowed){if(!p||Array.isArray(p)||typeof p!=='object'||Object.keys(p).some(k=>!allowed.includes(k))||p.schemaVersion!==1)throw geoProblem(400,'invalid_settlement_packet');}
const kinds={regions:'p.level=1',districts:'p.level=2',communities:'p.level=3',settlements:"(p.level=4 or p.category='K')",urbanDistricts:'p.level=5'};
const select=`select p.*,r.name region_name,r.category region_category,d.name district_name,c.name community_name
 from svitlo_geo.places p join svitlo_geo.places r on r.code=p.region_code
 left join svitlo_geo.places d on d.code=p.district_code left join svitlo_geo.places c on c.code=p.community_code`;
function publicPlace(p){
 const type={O:'region',P:'district',H:'community',M:'city',K:'city',C:'village',X:'settlement',B:'urban_district'}[p.category];
 const region={code:p.region_code,name:p.region_name};
 return {code:p.code,name:p.name,type,category:p.category,level:p.level,parentCode:p.parent_code,region,
  district:p.district_code?{code:p.district_code,name:p.district_name}:null,community:p.community_code?{code:p.community_code,name:p.community_name}:null};
}
export class Geography {
 constructor(bridge){this.db=bridge;}
 async ready(){return (await this.db.query('select exists(select 1 from svitlo_geo.editions where active and version=$1 and bundle_sha256=$2 and node_count=$3 and settlement_count=$4 and route_count=$5) ok',[expectedEdition.bundleVersion,expectedEdition.sha256,expectedEdition.nodeCount,expectedEdition.settlementCount,expectedEdition.routeCount])).rows[0]?.ok===true;}
 async edition(){const e=(await this.db.query('select version,edition_date::text,source_url,node_count,settlement_count,route_count from svitlo_geo.editions where active')).rows[0];if(!e)throw geoProblem(503,'settlement_directory_unavailable');return {version:e.version,editionDate:e.edition_date,sourceUrl:e.source_url,nodeCount:e.node_count,settlementCount:e.settlement_count,routeCount:e.route_count};}
 async search(p){
  exact(p,['schemaVersion','kind','q','regionCode','districtCode','communityCode','parentCode','limit','cursor']);
  const kind=p.kind??'settlements',q=p.q??'',limit=p.limit??30;
  if(!Object.hasOwn(kinds,kind)||typeof q!=='string'||q.length>120||/[\u0000-\u001f\u007f]/u.test(q)||!Number.isInteger(limit)||limit<1||limit>50)throw geoProblem(400,'invalid_settlement_search');
  for(const key of ['regionCode','districtCode','communityCode','parentCode'])if(p[key]!==undefined&&(typeof p[key]!=='string'||!code.test(p[key])))throw geoProblem(400,'invalid_administrative_filter');
  const needle=searchName(q),hasFilter=Boolean(p.parentCode||p.regionCode||p.districtCode||p.communityCode),directory=await this.edition();
  // Empty editor never launches a national scan. Explicit region/parent browsing is bounded.
  if(needle.length<2&&kind!=='regions'&&!hasFilter)return {schemaVersion:1,directory,items:[],nextCursor:null,complete:true};
  const signature=createHash('sha256').update(JSON.stringify([directory.version,kind,needle,p.regionCode??null,p.districtCode??null,p.communityCode??null,p.parentCode??null])).digest('hex');
  let after=null;if(p.cursor!==undefined){try{if(typeof p.cursor!=='string'||p.cursor.length>1000)throw Error();after=JSON.parse(Buffer.from(p.cursor,'base64url').toString());if(after.signature!==signature||typeof after.name!=='string'||after.name.length>240||!code.test(after.code))throw Error();}catch{throw geoProblem(400,'invalid_settlement_cursor');}}
  const params=[];const bind=v=>{params.push(v);return '$'+params.length;};const where=['p.active',kinds[kind]];
  for(const [field,col,level] of [['regionCode','region_code',1],['districtCode','district_code',2],['communityCode','community_code',3],['parentCode','parent_code',null]])if(p[field]){
   const parent=(await this.db.query('select level from svitlo_geo.places where code=$1 and active',[p[field]])).rows[0];
   if(!parent||level!==null&&parent.level!==level)throw geoProblem(400,'invalid_administrative_filter');where.push(`p.${col}=${bind(p[field])}`);
  }
  if(needle){const term=bind(needle.replace(/[\\%_]/g,'\\$&')+'%');where.push(`(p.search_name like ${term} escape '\\' or exists(select 1 from svitlo_geo.aliases a where a.code=p.code and a.search_name like ${term} escape '\\'))`);}
  if(after)where.push(`(p.search_name collate "C",p.code)>(${bind(after.name)} collate "C",${bind(after.code)})`);
  const rows=(await this.db.query(select+' where '+where.join(' and ')+` order by p.search_name collate "C",p.code limit ${bind(limit+1)}`,params)).rows;
  const page=rows.slice(0,limit),last=page.at(-1),more=rows.length>limit;
  return {schemaVersion:1,directory,items:page.map(publicPlace),nextCursor:more?Buffer.from(JSON.stringify({signature,name:last.search_name,code:last.code})).toString('base64url'):null,complete:!more};
 }
 async routes(p){
  exact(p,['schemaVersion','settlementCode']);if(typeof p.settlementCode!=='string'||!code.test(p.settlementCode))throw geoProblem(400,'invalid_settlement_code');
  const place=(await this.db.query(select+" where p.code=$1 and p.active and (p.level=4 or p.category='K')",[p.settlementCode])).rows[0];if(!place)throw geoProblem(404,'settlement_not_found');
  const rows=(await this.db.query(`select r.*,l.match_state,l.match_method,l.candidate_count,o.label operator_label,o.adapter_key,o.state operator_state
   from svitlo_geo.route_places l join svitlo_geo.routes r on r.id=l.route_id join svitlo_vps.operators o on o.id=r.operator_id
   where l.settlement_code=$1 and r.active and not o.is_test order by case l.match_state when 'reviewed' then 0 else 1 end,r.operator_id,r.branch_id collate "C",r.provider_city_id collate "C"`,[p.settlementCode])).rows;
  const routes=rows.map(r=>({routeId:r.id,operator:{id:r.operator_id,label:r.operator_label,adapter:r.adapter_key,state:r.operator_state},branch:r.branch_id?{id:r.branch_id,name:r.branch_name}:null,
   providerCity:{id:r.provider_city_id,name:r.provider_city_name},providerRef:r.source_ref,legacyCatalogCityId:r.legacy_catalog_city_id,
   matchState:r.match_state,matchMethod:r.match_method,candidateSettlements:r.candidate_count,addressCheckRequired:true,
   provenance:{sourceUrl:r.source_url,observedAt:new Date(r.source_observed_at).toISOString()},networkCoverageConfirmed:false}));
  const opByRegion={'UA71000000000010357':'ua-cherkasy','UA32000000000030281':'ua-kyiv-region-dtek','UA80000000000093317':'ua-kyiv-dtek'};
  const hint=!routes.length&&opByRegion[place.region_code]?[{operatorId:opByRegion[place.region_code],basis:'administrative_region_candidate',branchConfirmed:false,addressCheckRequired:true}]:[];
  return {schemaVersion:1,directory:await this.edition(),settlement:publicPlace(place),routeState:!routes.length?'unknown':routes.length>1?'multiple':routes[0].matchState,
   routes,operatorHints:hint,queue:null,lineId:null,addressCheckRequired:true};
 }
}
