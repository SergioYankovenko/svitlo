import {createHash} from 'node:crypto';import {geoProblem,normalizeName} from '../geography/service.mjs';
const code=/^UA[0-9]{17}$/,uuid=/^[a-f0-9-]{36}$/i;
export function packet(p,fields){if(!p||Array.isArray(p)||typeof p!=='object'||p.schemaVersion!==1||Object.keys(p).some(k=>!fields.includes(k))||!code.test(p.settlementCode)||typeof p.routeId!=='string'||p.routeId.length>350||/[\x00-\x1f\x7f]/.test(p.routeId))throw geoProblem(400,'invalid_settlement_route_packet');}
export class DiscoveryCatalog {
 constructor({bridge,source,reader,regions}){Object.assign(this,{bridge,source,reader,regions});}
 async route(p){const r=(await this.bridge.query(`select r.*,l.match_state,l.candidate_count from svitlo_geo.routes r join svitlo_geo.route_places l on l.route_id=r.id join svitlo_vps.operators o on o.id=r.operator_id where r.id=$1 and l.settlement_code=$2 and r.active and not o.is_test and o.state<>'disabled'`,[p.routeId,p.settlementCode])).rows[0];if(!r)throw geoProblem(404,'settlement_route_not_found');return r;}
 async cityId(r,p){
  if(r.operator_id==='ua-cherkasy')return (await this.bridge.query("select svitlo_discovery.catalog_entry($1,$2,'city',null,'',$3) id",[r.id,p.settlementCode,r.provider_city_name])).rows[0].id;
  if(!this.regions.handles(r.operator_id)||!r.legacy_catalog_city_id)throw geoProblem(409,'settlement_catalog_unavailable');
  return (await this.reader.catalog.entity(r.legacy_catalog_city_id)).id;
 }
 async city(p){packet(p,['schemaVersion','settlementCode','routeId']);const r=await this.route(p);
  if(r.operator_id==='ua-cherkasy'&&!r.legacy_catalog_city_id){const cities=await this.source.dictionary('city',{parent:r.branch_id});if(!cities.some(c=>c.id===r.provider_city_id))throw geoProblem(409,'provider_city_missing');}
  const id=await this.cityId(r,p),city=await this.reader.catalog.entity(id);return {schemaVersion:1,city:this.reader.catalog.public(city),routeId:r.id,matchState:r.match_state,addressCheckRequired:true};
 }
 async search(p){
  packet(p,['schemaVersion','settlementCode','routeId','kind','parentId','q','limit','cursor']);
  const q=p.q??'',limit=p.limit??50;if(!['streets','houses'].includes(p.kind)||typeof q!=='string'||q.length>120||/[\x00-\x1f\x7f]/.test(q)||!Number.isInteger(limit)||limit<1||limit>50||typeof p.parentId!=='string'||!uuid.test(p.parentId))throw geoProblem(400,'invalid_settlement_catalog_search');
  const r=await this.route(p),cityId=await this.cityId(r,p),parent=await this.reader.catalog.entity(p.parentId);
  if(p.kind==='streets'&&(parent.kind!=='city'||parent.id!==cityId)||p.kind==='houses'&&(parent.kind!=='street'||parent.parent_id!==cityId))throw geoProblem(400,'foreign_settlement_parent');
  if(this.regions.handles(r.operator_id))return this.reader.catalog.search({kind:p.kind,parentId:parent.id,q,limit,cursor:p.cursor??null});
  if(r.operator_id!=='ua-cherkasy')throw geoProblem(409,'settlement_catalog_unavailable');
  let sourceParent=r.provider_city_id;
  if(p.kind==='houses'){
   const aliases=(await this.bridge.query("select provider_key from svitlo_vps.catalog_aliases where operator_id='ua-cherkasy' and kind='street' and entity_id=$1",[parent.id])).rows;
   const refs=aliases.map(x=>{try{return JSON.parse(x.provider_key);}catch{return [];}}).filter(a=>a[0]===r.branch_id&&a[1]===r.provider_city_id);
   if(refs.length!==1)throw geoProblem(400,'foreign_settlement_street');sourceParent=refs[0][2];
  }
  const kind=p.kind==='streets'?'street':'house',rows=await this.source.dictionary(kind,{parent:sourceParent});
  const term=normalizeName(q),signature=createHash('sha256').update(JSON.stringify([r.id,p.settlementCode,p.kind,parent.id,term])).digest('hex');let after=null;
  if(p.cursor!==undefined)try{if(typeof p.cursor!=='string'||p.cursor.length>1500)throw Error();after=JSON.parse(Buffer.from(p.cursor,'base64url'));if(after.signature!==signature||typeof after.key!=='string'||typeof after.name!=='string')throw Error();}catch{throw geoProblem(400,'invalid_settlement_catalog_cursor');}
  const sorted=rows.filter(x=>typeof x.id==='string'&&typeof x.name==='string'&&x.name.length<=240&&normalizeName(x.name).includes(term)&&!/[\x00-\x1f]/.test(x.name)&&!/^\s*(?:\[?невідом|невизначен|без вулиці|\*)/iu.test(x.name)).map(x=>({...x,sortName:normalizeName(x.name)})).sort((a,b)=>a.sortName<b.sortName?-1:a.sortName>b.sortName?1:a.id<b.id?-1:a.id>b.id?1:0).filter(x=>!after||x.sortName>after.name||x.sortName===after.name&&x.id>after.key);
  const page=sorted.slice(0,limit),items=[];
  for(const x of page){const id=(await this.bridge.query('select svitlo_discovery.catalog_entry($1,$2,$3,$4,$5,$6) id',[r.id,p.settlementCode,kind==='house'?'address':'street',parent.id,x.id,x.name])).rows[0].id;try{items.push(this.reader.catalog.public(await this.reader.catalog.entity(id)));}catch(e){if(e.status!==409)throw e;}}
  const last=page.at(-1),more=sorted.length>limit;
  return {schemaVersion:1,items,nextCursor:more?Buffer.from(JSON.stringify({signature,name:last.sortName,key:last.id})).toString('base64url'):null,complete:!more,coverage:'provider_dictionary',addressCheckRequired:true};
 }
}
