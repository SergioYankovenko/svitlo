import {Registry,Counter,Histogram,Gauge,collectDefaultMetrics} from '@prometheus-io/client';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {routeTag} from '../telemetry/validation.js';
import sourceData from '../sources/registry.json' with {type:'json'};
export function metricsToken(secret){return createHmac('sha256',secret).update('internal-metrics-v1').digest('hex');}
export function permitsMetrics(header,secret){
 if(typeof header!=='string'||!/^Bearer [a-f0-9]{64}$/.test(header))return false;
 return timingSafeEqual(Buffer.from(header.slice(7)),Buffer.from(metricsToken(secret)));
}
export function createMetrics({defaults=false,sourceIds=sourceData.sources.map(s=>s.id)}={}){
 const knownSources=new Set(sourceIds);
 const registry=new Registry();
 if(defaults)collectDefaultMetrics({register:registry,prefix:'svitlo_'});
 const http=new Histogram({name:'svitlo_http_seconds',help:'HTTP completion latency; fixed routes only',labelNames:['route','status'],buckets:[.01,.05,.1,.2,.5,1,5,15,30],registers:[registry]});
 const sql=new Histogram({name:'svitlo_sql_seconds',help:'Database operation latency, no SQL text',labelNames:['role','outcome'],buckets:[.001,.005,.01,.05,.1,.5,1,5,15],registers:[registry]});
 const source=new Counter({name:'svitlo_source_operations_total',help:'Source results by configured source and phase',labelNames:['source','phase','outcome'],registers:[registry]});
 const queue=new Gauge({name:'svitlo_catalog_queue_jobs',help:'Durable catalogue jobs by state',labelNames:['state'],registers:[registry]});
 const lag=new Gauge({name:'svitlo_catalog_queue_oldest_seconds',help:'Age of oldest unfinished catalogue event',registers:[registry]});
 const heartbeat=new Gauge({name:'svitlo_catalog_projector_last_cycle_seconds',help:'Last successful projector cycle as Unix time; not source freshness',registers:[registry]});
 const generated=new Gauge({name:'svitlo_operations_generated_seconds',help:'Time operations snapshot was actually collected',registers:[registry]});
 return {registry,
  http(path,status,seconds){http.observe({route:routeTag(path),status:String(status>=100&&status<=599?status:500)},Math.max(0,seconds));},
  sql(role,outcome,seconds){sql.observe({role:['api','worker','session'].includes(role)?role:'other',outcome:outcome==='ok'?'ok':'error'},Math.max(0,seconds));},
  source(id,phase,outcome){source.inc({source:knownSources.has(id)?id:'unknown',phase:['fetch','parse','normalize'].includes(phase)?phase:'other',outcome:['ok','invalid','partial','forbidden','rate_limited','timeout','unavailable'].includes(outcome)?outcome:'unavailable'});},
  operations(value){for(const state of ['ready','running','dead'])queue.set({state},Number(value.jobs?.[state]||0));lag.set(Number(value.oldestPendingSeconds||0));heartbeat.set(Number(value.lastCycleSeconds||0));generated.set(Number(value.generatedSeconds));}
 };
}
export const metrics=createMetrics({defaults:process.env.NODE_ENV==='production'});

// Instrument actual client queries, including transactions acquired from a pool.
// Callback and promise forms retain their original behavior; queries are never
// used as labels or copied into logs.
export function observeClient(client,role,observer=metrics){
 if(client.__svitloObserved)return;Object.defineProperty(client,'__svitloObserved',{value:true});
 const original=client.query;
 client.query=function(...args){const start=performance.now();let finished=false;
  const finish=error=>{if(!finished){finished=true;observer.sql(role,error?'error':'ok',(performance.now()-start)/1000);}};
  const callback=args.at(-1);
  if(typeof callback==='function')args[args.length-1]=function(error,...rest){finish(error);return callback.call(this,error,...rest);};
  try{const result=original.apply(this,args);
   if(typeof callback!=='function'){
    if(result?.then)return result.then(value=>{finish();return value;},error=>{finish(error);throw error;});
    if(result?.once){result.once('end',()=>finish());result.once('error',finish);}else finish();
   }
   return result;
  }catch(error){finish(error);throw error;}
 };
}
