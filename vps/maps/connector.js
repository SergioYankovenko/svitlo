import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {candidates,finalCandidate,normalHouse,normalName,mapError} from './policy.js';
const spec=JSON.parse(readFileSync(new URL('./visicom-spec.json',import.meta.url),'utf8'));
let host,guestSession,guestUntil=0;
async function runtime(){
 if(!host)host=(async()=>{
  const dir=mkdtempSync(join(tmpdir(),'svitlo-visicom-'));process.env.API_ANYTHING_HOME=dir;
  mkdirSync(join(dir,'sites'),{mode:0o700});writeFileSync(join(dir,'sites',spec.name+'.json'),JSON.stringify(spec),{mode:0o600});
  writeFileSync(join(dir,'settings.json'),'{"share":false}',{mode:0o600});
  return import('api-anything/host');
 })();return host;
}
// No browser, learning, registry, personal cookies or customer data in shared agent configuration.
export async function callVisicom(op,args,timeoutMs=3500,fetcher=fetch){
 const api=await runtime(),deadline=Date.now()+timeoutMs;
 const allowlistedFetch=async(url,init)=>{
  const u=new URL(String(url));if(u.protocol!=='https:'||u.hostname!=='maps.visicom.ua'||u.port||u.username||u.password||!(/^(?:\/$|\/uk\/fts$|\/proxy\/uk\/feature\/[A-Z0-9]+$)/.test(u.pathname))||(init?.method||'GET')!=='GET')throw mapError('map_unavailable');
  const response=await fetcher(url,init);
  if(Number(response.headers.get('content-length'))>524288)throw mapError('map_unavailable');
  const body=await response.text();if(Buffer.byteLength(body)>524288)throw mapError('map_unavailable');
  return new Response(body,{status:response.status,headers:response.headers});
 };
 const run=async(name,values)=>{const plan=api.planCall(spec.name,name,values,{maxTier:1});if(!plan.ok||!plan.readOnly||plan.tier!==1)throw mapError('map_unavailable');
  const left=deadline-Date.now();if(left<100)throw mapError('map_unavailable');const result=await api.callPlanned(plan,{timeoutMs:left,fetchImpl:allowlistedFetch});
  if(!result.ok)throw mapError(result.class==='rate'?'map_rate_limited':'map_unavailable',result.class==='rate'?429:503);return result.data;
 };
 if(op==='searchAddress'&&guestUntil<Date.now()){
  if(!guestSession)guestSession=run('startSession',{}).then(()=>{guestUntil=Date.now()+900000;}).finally(()=>{guestSession=null;});
  await guestSession;
 }
 return run(op,args);
}
export class VisicomConnector {
 constructor({call=callVisicom,now=Date.now}={}){this.call=call;this.now=now;this.cities=new Map();}
 async lookup(input,city){
  const deadline=this.now()+11000;
  const request=(op,args)=>{const left=deadline-this.now();if(left<500)throw mapError('map_unavailable');return this.call(op,args,Math.min(3500,left));};
  const full=house=>`${input.street}, ${house}, ${city.name}, ${city.region}, Україна`;
  const queries=[full(input.house),...(normalHouse(input.house)!==input.house?[full(normalHouse(input.house))]:[]),`${city.name} ${input.street} ${input.house}`];
  let found=[];
  for(const query of [...new Set(queries)].slice(0,3)){
   found=candidates(await request('searchAddress',{query}),input,city);
   if(found.length)break;
  }
  const verified=[];
  for(const candidate of found){
   if(!city.settlementId){
    let place=this.cities.get(candidate.settlementId);
    if(!place||place.until<this.now()){
     const data=await request('getFeature',{featureId:candidate.settlementId});place={properties:data.properties,until:this.now()+3600000};
     if(this.cities.size>200)this.cities.clear();this.cities.set(candidate.settlementId,place);
    }
    const p=place.properties||{};
    if(p.country_code!=='ua'||normalName(p.name||'')!==normalName(city.name)||p.level1!==city.region||city.type&&p.type!==city.type)continue;
   }
   verified.push(finalCandidate(await request('getFeature',{featureId:candidate.featureId}),candidate,input,city,this.now()));
  }
  return verified;
 }
}
