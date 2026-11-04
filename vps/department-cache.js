import {createHmac} from 'node:crypto';
import {SharedCategories} from '../server/shared-categories.js';
import {addressNorm} from '../server/source.js';
import {parseOutages,rows} from '../app/lib/parsers.js';

// Private-stage adapter only. Persist public catalog address hashes and parsed
// intervals; raw rows, HTML, personal accounts and names never enter this cache.
export class DepartmentSchedules {
 constructor({db,bridge,secret,now=()=>Date.now(),ttl=300000,maxEntries=6,maxBytes=4000000,shared}={}){
  Object.assign(this,{bridge,secret,now,ttl,maxEntries,maxBytes});
  this.shared=shared||new SharedCategories(db,secret,{now,ttl});this.memo=new Map();this.pending=new Map();
 }
 supports(a){return a.department==='18';}
 hash(parts){return createHmac('sha256',this.secret).update(JSON.stringify(parts)).digest('hex');}
 async compile(department,category,raw,checkedAt){
  const parsed=parseOutages(raw,category,checkedAt),sourceRows=rows(raw.DISCONNECTIONS).filter(x=>!/скасован|відмін|cancelled|canceled/i.test(x.STATE_CHAR||''));
  const known=(await this.bridge.query('select distinct city,street from public.svitlo_effective_address_queues where department=$1',[department])).rows;
  const cities=new Map(),covered=new Set(),invalid=new Set(),events=Object.create(null);
  for(const a of known){const city=addressNorm(a.city),street=addressNorm(a.street);if(!cities.has(city))cities.set(city,new Set());cities.get(city).add(street);covered.add(this.hash([city,street]));}
  for(let n=0;n<sourceRows.length;n++){
   const html=sourceRows[n].ADDRESS;
   if(typeof html!=='string')throw Error('Немає адреси');
   const sections=[...html.matchAll(/<strong\b[^>]*>(.*?)<\/strong>/gis)];
   if(!sections.length||html.slice(0,sections[0].index).trim())throw Error('Невідомий формат адреси');
   for(let i=0;i<sections.length;i++){
    const city=addressNorm(sections[i][1]),streets=cities.get(city);if(!streets)continue;
    const lines=html.slice(sections[i].index+sections[i][0].length,sections[i+1]?.index??html.length).split(/<br\s*\/?>/i).map(addressNorm).filter(Boolean);
    for(const line of lines)for(const street of streets){
     const prefix=street+' ';if(!line.startsWith(prefix))continue;
     const houses=line.slice(prefix.length).split(',').map(x=>x.replace(/\s/g,''));
     if(houses.some(x=>!/^\d+[\p{L}]?(?:[/-][\d\p{L}]+)?$/u.test(x)||/^\d+-\d+$/.test(x))){invalid.add(this.hash([city,street]));continue;}
     for(const house of houses){const key=this.hash([city,street,house]);(events[key]??=[]).push(parsed.events[n]);}
    }
   }
  }
  const value={version:1,checkedAt:parsed.checkedAt,sourceAt:parsed.sourceAt,covered:[...covered],invalid:[...invalid],events,...(category==='planned'?{outageTypesVersion:parsed.outageTypesVersion}:{})};
  if(Buffer.byteLength(JSON.stringify(value))>this.maxBytes)throw Error('Завеликий розібраний графік філії');
  return value;
 }
 async value(a,category,base,checkedAt,fetcher,signal){
  const scope=['department-parsed-v1',a.department,category,base.n_date,base.k_date],key=JSON.stringify(scope),t=this.now(),cached=this.memo.get(key);
  if(cached&&cached.expires>t&&cached.value.checkedAt<=t)return cached;
  // A caller's cancellation cannot cancel another address's shared refresh.
  if(!this.pending.has(key)){
   const controller=AbortSignal.timeout(20000);
   const load=this.shared.load(scope,async()=>this.compile(a.department,category,await fetcher(controller),checkedAt),controller).then(value=>{
    if(value.version!==1||!Number.isFinite(value.checkedAt)||value.checkedAt>this.now()||!Array.isArray(value.covered)||!Array.isArray(value.invalid)||!value.events)throw Error('Некоректний кеш філії');
    const result={value,covered:new Set(value.covered),invalid:new Set(value.invalid),expires:value.checkedAt+this.ttl};
    if(result.expires>this.now()){
     if(this.memo.size>=this.maxEntries)this.memo.delete(this.memo.keys().next().value);
     this.memo.set(key,result);
    }
    return result;
   }).finally(()=>this.pending.delete(key));
   this.pending.set(key,load);
  }
  const pending=this.pending.get(key);
  if(!signal)return pending;
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});
   pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
 }
 async address(a,category,base,checkedAt,fetcher,signal){
  signal?.throwIfAborted();const cached=await this.value(a,category,base,checkedAt,fetcher,signal);
  signal?.throwIfAborted();const city=addressNorm(a.city),street=addressNorm(a.street),house=addressNorm(a.house).replace(/\s/g,''),streetKey=this.hash([city,street]);
  if(!cached.covered.has(streetKey))return null;
  if(cached.invalid.has(streetKey))throw Error('Неоднозначний перелік будинків');
  const v=cached.value;
  return {events:structuredClone(v.events[this.hash([city,street,house])]||[]),checkedAt:v.checkedAt,sourceAt:v.sourceAt,queue:null,
   ...(category==='hourly'?{queueStatus:'queue_missing'}:{}),...(category==='planned'?{outageTypesVersion:v.outageTypesVersion}:{})};
 }
}
