import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';
import {metrics} from '../observability/metrics.js';
export const sourceRegistry=JSON.parse(readFileSync(new URL('./registry.json',import.meta.url),'utf8'));
const sources=new Map(sourceRegistry.sources.map(s=>[s.id,s]));
const hosts=new Map(sourceRegistry.sources.map(s=>[new URL(s.scheduleUrl).hostname,s.id]));
hosts.set('cabinet.cherkasyoblenergo.com','ua-cherkasy');hosts.set('www.cherkasyoblenergo.com','ua-cherkasy');
hosts.set('oblenergo.kharkiv.ua','ua-kharkiv');hosts.set('pa.oblenergo.kharkiv.ua','ua-kharkiv');hosts.set('interruptions.energy.cn.ua','ua-chernihiv');
export function fetchSource(url){return sources.get(hosts.get(new URL(url).hostname))||null;}
export function publicSource(url){
 const u=new URL(url),id=hosts.get(u.hostname);if(!id)return null;
 if(u.protocol!=='https:'||u.username||u.password)return null;
 if(u.hostname==='cabinet.cherkasyoblenergo.com'&&!['department_list','city_list','street_list','house_list','disconn_by_dept'].includes(u.searchParams.get('op')))return null;
 if(u.hostname==='alerts.energy'&&!u.pathname.startsWith('/api/v1/source-registry/'))return null;
 if(u.hostname==='app.yasno.ua'&&!u.pathname.startsWith('/api/blackout-service/public/'))return null;
 return sources.get(id);
}
const outcome=(status,complete)=>status===403?'forbidden':status===429?'rate_limited':status>=500?'unavailable':!complete?'partial':'observed';
export function observedPublicFetch(fetcher,record,allowed=async()=>true){return async(url,options)=>{
 const configured=fetchSource(url);if(configured&&!await allowed(configured.id))throw Object.assign(Error('Source paused'),{status:503,code:'operator_paused'});
 const spec=publicSource(url);if(!spec)return fetcher(url,options);
 const observe=async value=>{try{await record(value);}catch{/* Optional diagnostics cannot alter the source wire contract. */}};
 let response;try{response=await fetcher(url,options);}catch(e){await observe({sourceId:spec.id,phase:'fetch',outcome:e.name==='TimeoutError'?'timeout':'unavailable',status:0,contentHash:null,bytes:0,parserVersion:spec.parserVersion});throw e;}
 const status=response.status,type=response.headers.get('content-type')||'';let bytes=0,finished=false;const hash=createHash('sha256');
 const finish=async complete=>{if(finished)return;finished=true;await observe({sourceId:spec.id,phase:'fetch',outcome:outcome(status,complete),status,contentHash:complete?hash.digest('hex'):null,bytes,parserVersion:spec.parserVersion,format:/json/i.test(type)?'json':/pdf/i.test(type)?'pdf':/image/i.test(type)?'image':/html/i.test(type)?'html':'other'});};
 if(!response.body){await finish(true);return response;}
 const reader=response.body.getReader(),stream=new ReadableStream({
  async pull(controller){try{const next=await reader.read();if(next.done){await finish(true);controller.close();}else{bytes+=next.value.byteLength;hash.update(next.value);controller.enqueue(next.value);}}catch(e){await finish(false);controller.error(e);}},
  async cancel(reason){try{await reader.cancel(reason);}finally{await finish(false);}}
 });
 const wrapped=new Response(stream,{status,statusText:response.statusText,headers:response.headers});
 Object.defineProperties(wrapped,{url:{value:response.url},redirected:{value:response.redirected}});return wrapped;
};}
export class SourceEvidence {
 constructor(bridge,{now=Date.now,onError=()=>{}}={}){Object.assign(this,{bridge,now,onError});this.lastError=0;}
 async record(value){
  const spec=sources.get(value.sourceId);if(!spec)return;
  metrics.source(spec.id,value.phase,value.outcome==='observed'||value.outcome==='accepted'?'ok':value.outcome);
  try{await this.bridge.query('select svitlo_sources.record($1::jsonb)',[JSON.stringify({...value,observedAt:this.now()})]);}
  catch{if(this.now()-this.lastError>60000){this.lastError=this.now();this.onError('source_evidence_write_failed');}}
 }
 async accepted(snapshot,parserVersion){
  const sourceId=parserVersion==='alerts-energy-v1'?'aux-alerts-energy':snapshot.operatorId;if(!sources.has(sourceId))return;
  const value={coverage:snapshot.coverage,resolution:snapshot.resolution,lines:snapshot.lines.map(l=>({id:l.id,groupCode:l.groupCode,categories:Object.fromEntries(Object.entries(l.categories).map(([k,c])=>[k,c.days]))}))};
  const fresh=snapshot.supportState==='available'&&snapshot.resolution.complete&&snapshot.freshUntil>this.now();
  await this.record({sourceId,phase:'normalize',outcome:fresh?'accepted':'partial',status:200,
   contentHash:createHash('sha256').update(JSON.stringify(value)).digest('hex'),bytes:Buffer.byteLength(JSON.stringify(value)),parserVersion,
   checkedAt:Math.min(snapshot.checkedAt,snapshot.sourceUpdatedAt??snapshot.checkedAt)});
 }
 async rejected(sourceId,code,parserVersion){
  if(parserVersion==='alerts-energy-v1')sourceId='aux-alerts-energy';
  const spec=sources.get(sourceId);if(!spec)return;
  await this.record({sourceId,phase:'normalize',outcome:['forbidden','rate_limited','timeout'].includes(code)?code:/^invalid_/.test(code||'')?'invalid':'unavailable',status:0,contentHash:null,bytes:0,parserVersion:spec.parserVersion});
 }
}
export async function seedSourceRegistry(c){
 for(const s of sourceRegistry.sources)await c.query(`insert into svitlo_sources.registry(id,operator_id,label,schedule_url,family,parser_version,verification_state,metadata)
  values($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict(id) do update set label=excluded.label,schedule_url=excluded.schedule_url,family=excluded.family,parser_version=excluded.parser_version,verification_state=excluded.verification_state,metadata=excluded.metadata`,
  [s.id,s.operatorId,s.label,s.scheduleUrl,s.family,s.parserVersion,s.verificationState,JSON.stringify({evidence:s.registryEvidence,endpointVerified:s.endpointVerified,userFacing:s.userFacing})]);
}
