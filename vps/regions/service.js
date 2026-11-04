import {SharedCategories} from '../../server/shared-categories.js';
import {DtekClient,REGIONS,regionError,boundedBody} from './dtek.js';
import {projectStreet,resolveHouse,dtekSnapshot} from './policy.js';
import {projectYasno} from './yasno.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export class Regions {
 constructor({db,bridge,secret,fetcher=fetch,now=Date.now}){
  Object.assign(this,{db,bridge,fetcher,now});this.indexCache=new SharedCategories(db,secret,{ttl:86400000,now});this.streetCache=new SharedCategories(db,secret,{ttl:120000,now});this.snapshotCache=new SharedCategories(db,secret,{ttl:60000,now});this.statusCache=new SharedCategories(db,secret,{ttl:120000,now});this.clients=new Map();
 }
 handles(op){return Object.hasOwn(REGIONS,op);}
 async gate(op){const deadline=Date.now()+6000;while(true){const r=(await this.bridge.query('select svitlo_regions.acquire($1) result',[op])).rows[0].result;if(r.granted)return r.ticket;if(r.reason==='cooldown')throw regionError(r.code==='forbidden'?'forbidden':'rate_limited',r.code==='forbidden'?503:429);if(Date.now()>=deadline)throw regionError('rate_limited',429);await pause(Math.min(500,r.waitMs||100));}}
 async finish(op,ticket,{status,error,retry}){await this.bridge.query('select svitlo_regions.finish($1,$2,$3,$4,$5)',[op,ticket,status,error,retry]);}
 client(op){if(!this.handles(op))throw regionError('unsupported_operator',400);if(!this.clients.has(op))this.clients.set(op,new DtekClient(op,{fetcher:this.fetcher,gate:op=>this.gate(op),finish:(...args)=>this.finish(...args),now:this.now}));return this.clients.get(op);}
 async index(op){return this.indexCache.load(['dtek-index-v1',op],async()=>({checkedAt:this.now(),cities:await this.client(op).streets()}));}
 async import(op,kind,parent,labels,checkedAt){return (await this.bridge.query('select svitlo_regions.import_entries($1,$2,$3,$4::jsonb,$5) result',[op,kind,parent,JSON.stringify(labels),checkedAt])).rows[0].result;}
 async seed(){const result=[];for(const op of Object.keys(REGIONS)){const index=await this.index(op);result.push({operator:op,...await this.import(op,'city',null,Object.keys(index.cities),index.checkedAt),settlements:Object.keys(index.cities).length,streetNames:Object.values(index.cities).reduce((n,a)=>n+a.length,0)});}return result;}
 async ensureSearch(parent,kind){
  const op=parent.metadata?.regionOperator;if(!this.handles(op))return;
  try{
  if(kind==='streets'){const index=await this.index(op),labels=index.cities[parent.source_ref.city];if(!labels)throw regionError('address_requires_reselection',409);await this.import(op,'street',parent.id,labels,index.checkedAt);}
  else if(kind==='houses'){const data=await this.street(op,parent.source_ref.city,parent.source_ref.street);await this.import(op,'address',parent.id,Object.keys(data.houses),data.checkedAt);}
  }catch(e){if(!this.unavailable(e))throw e;const old=(await this.bridge.query("select max((metadata->>'sourceCheckedAt')::bigint) checked from svitlo_vps.catalog where parent_id=$1 and kind=$2 and metadata->>'regionOperator'=$3 and metadata->>'sourceActive'='true'",[parent.id,kind==='streets'?'street':'address',op])).rows[0]?.checked;if(!old)throw e;return {state:'cached',code:e.code||'source_unavailable',checkedAt:old};}
 }
 unavailable(e){return e?.status>=500||['forbidden','rate_limited','timeout'].includes(e?.code)||['EAI_AGAIN','ENOTFOUND','ECONNRESET','ETIMEDOUT'].includes(e?.cause?.code);}
 async street(op,city,street){return this.streetCache.load(['dtek-street-v2',op,city,street],async()=>projectStreet(await this.client(op).houses(city,street),this.now()));}
 async address(entity){if(!this.handles(entity.operator_id)||entity.kind!=='address')throw regionError('unsupported_operator',400);return this.street(entity.operator_id,entity.source_ref.city,entity.source_ref.street);}
 async resolve(entity){try{return resolveHouse(await this.address(entity),entity.source_ref.house);}catch(e){if(!this.unavailable(e))throw e;return {state:'unknown',complete:false,checkedAt:entity.metadata?.sourceCheckedAt||1,lines:[],provenance:{source:'dtek-address',sourceUnavailable:true,sourceState:e.code||'source_unavailable',sourceCheckedAt:entity.metadata?.sourceCheckedAt||null,attemptedAt:this.now()}};}}
 async cityStatus(){
  return this.statusCache.load(['yasno-kyiv-plan-v2'],async()=>{
   const op='yasno-kyiv',ticket=await this.gate(op);let status=0,error=null,retry=0;
   try{const r=await this.fetcher('https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(8000),headers:{accept:'application/json','user-agent':'Svitlo-private-staging/1.0'}});status=r.status;retry=Math.min(900000,Math.max(0,Number(r.headers.get('retry-after'))*1000||0));if(!r.ok){await r.body?.cancel();throw regionError(status===403?'forbidden':status===429?'rate_limited':'source_unavailable');}
    return projectYasno(JSON.parse(await boundedBody(r,500000)),this.now());
   }catch(e){error=e.code||'source_unavailable';throw e;}finally{await this.finish(op,ticket,{status,error,retry}).catch(()=>{});}
  });
 }
 async snapshot(entity,resolution,range){const data=await this.address(entity);let cityStatus=null;if(REGIONS[entity.operator_id]?.city)try{cityStatus=await this.cityStatus();}catch{/* Missing emergency state must not become a confirmed clear schedule. */}return {value:dtekSnapshot(entity,resolution,range,data,cityStatus,this.now())};}
}
export class DtekAdapter {
 constructor(regions){this.regions=regions;}
 resolve(entity){return this.regions.resolve(entity);}
 snapshot(entity,resolution,range){return this.regions.snapshot(entity,resolution,range);}
}
