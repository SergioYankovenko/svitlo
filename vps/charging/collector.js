import {DomainJobs} from '../events/domain-jobs.js';
import {configuredOcm} from './catalog.js';
export class ChargingCollector {
 constructor({pool,source=configuredOcm(),jobs=new DomainJobs(pool),onError=()=>{}}){Object.assign(this,{pool,source,jobs,onError});}
 async tick(){
  if(!this.source.configured||!(await this.pool.query('select svitlo_charging.collection_allowed() enabled')).rows[0].enabled)return {state:'disabled'};
  await this.pool.query('select svitlo_charging.enqueue_refresh()');
  for(const job of await this.jobs.claim('charging-refresh-v1',1)){
   try{await this.jobs.external(job,({event})=>this.source.byId(event.payload.stationId),async({tx,result})=>{
    if(result.length)await tx.query('select svitlo_charging.apply_refresh($1)',[JSON.stringify(result)]);
   });}
   catch(e){await this.jobs.fail(job,e.code==='invalid_payload'?'invalid_payload':'dependency_unavailable').catch(()=>{});this.onError('charging_refresh_failed');return {state:'retry'};}
   return {state:'progress'};
  }
  return {state:'idle'};
 }
}
