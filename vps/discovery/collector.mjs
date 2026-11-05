import {createHash} from 'node:crypto';import {rows} from '../../app/lib/parsers.js';import {projectStreet,resolveHouse} from '../regions/policy.js';import {addressResolution} from '../../server/address-registry.js';import {registryMatch} from '../../server/queue-registry.js';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sourceError=code=>Object.assign(Error('Discovery source unavailable'),{code});
export function transportOutcome(e){const c=e?.code;if(c==='forbidden'||e?.status===403)return {outcome:'upstream_forbidden',error:'forbidden',retrySeconds:1800};if(c==='rate_limited'||e?.status===429)return {outcome:'upstream_rate_limited',error:'rate_limited',retrySeconds:900};if(c==='invalid_source'||String(c).startsWith('invalid_')||e instanceof SyntaxError)return {outcome:'invalid_source',error:'invalid_source',retrySeconds:3600};return {outcome:'upstream_unavailable',error:'source_unavailable',retrySeconds:900};}
export function queueOutcome(r){if(r.provenance?.externalOperator)return 'provider_external';if(['unavailable','incomplete_address'].includes(r.status)||r.provenance?.sourceUnavailable)return 'queue_unchecked';if(r.state==='ambiguous'||r.lines?.length>1||r.status==='ambiguous')return 'queue_ambiguous';if(r.inclusion==='not_in_queue'||r.state==='excluded')return 'queue_not_in_schedule';if(r.inclusion==='service')return 'queue_unchecked';if(r.queue&&r.estimated===true)return 'queue_estimated';if(r.provenance?.partial)return 'queue_partial';if(r.queue||r.complete&&r.lines?.some(l=>l.groupCode))return 'queue_confirmed';return 'queue_missing';}
function list(raw,house=false){const result=rows(raw).map(r=>({key:String(house?r.HOUSE:r.ID),name:String(house?r.HOUSE:r.NAME)}));if(result.length>5000||result.some(r=>!r.key||r.key==='undefined'||r.name==='undefined'||r.key.length>(house?120:100)||r.name.length>240||/[\x00-\x1f]/.test(r.key+r.name)))throw sourceError('invalid_source');return [...new Map(result.map(r=>[r.key,r])).values()];}
const usable=items=>items.filter(x=>!/^\s*(?:\[?невідом|невизначен|без вулиці|\*)/iu.test(x.name));
export class DiscoveryCollector {
 constructor(rt,{now=Date.now}={}){Object.assign(this,{...rt,now});}
 async known(r,kind,streetKey){
  if(r.operator_id==='ua-cherkasy'){
   const q=await this.bridge.query(`select a.provider_key,c.label from svitlo_vps.catalog_aliases a join svitlo_vps.catalog c on c.id=a.entity_id where a.operator_id='ua-cherkasy' and a.kind=$1 and (a.provider_key::jsonb)->>0=$2 and (a.provider_key::jsonb)->>1=$3 and ($4::text is null or (a.provider_key::jsonb)->>2=$4) order by a.provider_key limit 5001`,[kind,r.branch_id,r.provider_city_id,streetKey??null]);if(q.rows.length>5000)throw sourceError('invalid_source');return q.rows.map(x=>({key:JSON.parse(x.provider_key)[kind==='street'?2:3],name:x.label}));
  }
  const q=await this.bridge.query("select source_ref,label from svitlo_vps.catalog where kind=$1 and metadata->>'regionOperator'=$2 and source_ref->>'city'=$3 and ($4::text is null or source_ref->>'street'=$4) order by id limit 5001",[kind,r.operator_id,r.provider_city_name,streetKey??null]);if(q.rows.length>5000)throw sourceError('invalid_source');return q.rows.map(x=>({key:x.source_ref[kind==='street'?'street':'house'],name:x.label}));
 }
 async streets(r){
  if(r.operator_id==='ua-cherkasy')return {items:usable(list(await this.source.request({op:'street_list',city_id:r.provider_city_id,search_name:''},AbortSignal.timeout(22000)))),checkedAt:this.now()};
  const data=await this.regions.index(r.operator_id),items=data.cities[r.provider_city_name];if(!Array.isArray(items))throw sourceError('invalid_source');if(items.length>5000)throw sourceError('invalid_source');return {items:usable(items.map(name=>({key:name,name}))),checkedAt:data.checkedAt};
 }
 async houses(r,key){
  if(r.operator_id==='ua-cherkasy')return {items:list(await this.source.request({op:'house_list',street_id:key,search_name:''},AbortSignal.timeout(22000)),true),checkedAt:this.now()};
  const raw=await this.regions.client(r.operator_id).houses(r.provider_city_name,key),at=this.now();
  if(raw?.data&&typeof raw.data==='object'&&!Array.isArray(raw.data)&&Object.keys(raw.data).length===0)return {items:[],checkedAt:at,data:{checkedAt:at,houses:{}}};
  const data=projectStreet(raw,at),keys=Object.keys(data.houses);if(keys.length>5000)throw sourceError('invalid_source');return {items:keys.map(key=>({key,name:key})),checkedAt:at,data};
 }
 async cherResolver(){const [registry,metadata]=await Promise.all([this.db.registry(),this.db.registryMetadata()]);return async a=>{const record=await this.db.addressQueue(a);return record?addressResolution(record,metadata,this.now()):registryMatch(registry,a,this.now());};}
 async process(job){
  const r=(await this.bridge.query('select r.*,exists(select 1 from svitlo_geo.route_places l where l.route_id=r.id) mapped from svitlo_geo.routes r where r.id=$1',[job.routeId])).rows[0];if(!r)throw sourceError('invalid_source');
  if(!r.active||!r.mapped)return {events:[{subjectKey:'city',kind:'city',outcome:'route_unmatched',basis:'katottg_mapping',sourceCheckedAt:r.source_observed_at,detail:{mappingState:r.active?'unmatched':'inactive'}}],children:[],checkpoint:{},complete:true};
  const events=[],children=[],started=this.now();
  if(job.kind==='city'){
   const data=await this.streets(r),known=await this.known(r,'street'),keys=new Set(data.items.map(x=>x.key)),fresh=this.now()-data.checkedAt<86400000,missing=fresh?known.filter(x=>!keys.has(x.key)):[],hash=digest([data.items.map(x=>x.key).sort(),missing.map(x=>x.key).sort()]),offset=job.checkpoint.digest===hash?job.checkpoint.offset||0:0;
   const common={kind:'city',basis:'provider_dictionary',sourceCheckedAt:new Date(data.checkedAt).toISOString()};events.push({...common,subjectKey:'city',outcome:!fresh?'source_stale':data.items.length?'streets_listed':'streets_empty',detail:{count:data.items.length,localCount:known.length,fresh}});
   for(const x of missing.slice(offset,offset+200))events.push({...common,subjectKey:'street:'+x.key,kind:'street',streetKey:x.key,streetName:x.name,outcome:'street_absent',detail:{complete:true}});
   children.push(...data.items);if(!fresh)return {events,children,checkpoint:{},complete:false,error:'source_unavailable',retrySeconds:900};const complete=offset+200>=missing.length;return {events,children,checkpoint:complete?{}:{digest:hash,offset:offset+200},complete};
  }
  const data=await this.houses(r,job.sourceKey),known=await this.known(r,'address',job.sourceKey),keys=new Set(data.items.map(x=>x.key)),missing=known.filter(x=>!keys.has(x.key)),subjects=[...data.items.map(x=>({...x,present:true})),...missing.map(x=>({...x,present:false}))].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const hash=digest(subjects.map(x=>[x.key,x.present])),offset=job.checkpoint.digest===hash?job.checkpoint.offset||0:0;
  const common={streetKey:job.sourceKey,streetName:job.sourceName,sourceCheckedAt:new Date(data.checkedAt).toISOString()};
  events.push({...common,subjectKey:'street:'+job.sourceKey,kind:'street',outcome:data.items.length?'houses_listed':'houses_empty',basis:'provider_dictionary',detail:{count:data.items.length,localCount:known.length,fresh:true}});
  const resolve=r.operator_id==='ua-cherkasy'?await this.cherResolver():null;
  let processed=0;for(const x of subjects.slice(offset,offset+50)){
   if(this.now()-started>45000)break;processed++;
   if(!x.present){events.push({...common,subjectKey:'house:'+job.sourceKey+':'+x.key,kind:'house',house:x.key,outcome:'house_absent',basis:'provider_dictionary',detail:{complete:true}});continue;}
   const q=resolve?await resolve({department:r.branch_id,cityId:r.provider_city_id,streetId:job.sourceKey,house:x.key,city:r.provider_city_name,street:job.sourceName}):resolveHouse(data.data,x.key);
   const groups=q.queue?[q.queue]:(q.lines||[]).map(l=>l.groupCode).filter(Boolean);
   const reviewed=Date.parse(q.addressReviewedAt||''),sourceAt=resolve?(Number.isFinite(reviewed)?new Date(reviewed).toISOString():Number.isFinite(q.checkedAt)?new Date(q.checkedAt).toISOString():null):common.sourceCheckedAt;
   events.push({...common,sourceCheckedAt:sourceAt,subjectKey:'house:'+job.sourceKey+':'+x.key,kind:'house',house:x.key,outcome:queueOutcome(q),basis:resolve?'service_registry':'provider_address',detail:{groups,sourceState:String(q.status||q.state||'unknown').slice(0,40),resolutionState:q.state||'unknown',complete:q.complete===true,...(resolve?{registryVersion:String(q.version||q.addressRegistryVersion||'').slice(0,240),estimated:q.estimated===true,reviewedAt:Number.isFinite(reviewed)?new Date(reviewed).toISOString():null}:{})}});
  }
  const complete=offset+processed>=subjects.length;return {events,children,checkpoint:complete?{}:{digest:hash,offset:offset+processed},complete};
 }
 async runDue(){
  const job=(await this.bridge.query('select svitlo_discovery.claim() result')).rows[0].result;if(job.state!=='claimed')return job;
  let packet;
  try{packet=await this.process(job);}catch(e){const error=transportOutcome(e);packet={events:[{subjectKey:job.kind+':'+job.sourceKey,kind:job.kind,...(job.kind==='street'?{streetKey:job.sourceKey,streetName:job.sourceName}:{}),outcome:error.outcome,basis:'transport',detail:{sourceState:error.error}}],children:[],checkpoint:job.checkpoint,complete:false,error:error.error,retrySeconds:error.retrySeconds};}
  const accepted=(await this.bridge.query('select svitlo_discovery.finish($1,$2,$3::jsonb) accepted',[job.id,job.token,JSON.stringify(packet)])).rows[0].accepted;
  return {state:accepted?'recorded':'lease_lost',jobKind:job.kind,clusterCode:job.clusterCode,clusterLevel:job.clusterLevel,settlementCode:job.settlementCode,scopeStatus:job.scopeStatus,observations:packet.events.length,children:packet.children.length,complete:packet.complete,error:packet.error??null};
 }
}
