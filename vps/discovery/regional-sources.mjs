// Diagnostic collector only. These providers do not become user-facing adapters.
import {DtekClient,boundedBody,regionError} from '../regions/dtek.js';
import {resolveHouse,projectStreet} from '../regions/policy.js';
import {operatorFetch} from '../operator-fetch.js';
import {ZOE_DEPLOYMENT,ZOE_CITY_KEY,parseZoePublic,zoeResolution} from './zoe-public.mjs';
export const COLLECTOR_SOURCES=Object.freeze({
 'ua-chernihiv':{regionPrefix:'UA74',label:'Чернігівобленерго',family:'chernihiv',url:'https://chernihivoblenergo.com.ua/blackouts',origin:'https://interruptions.energy.cn.ua',capital:'Чернігів'},
 'ua-sumy':{regionPrefix:'UA59',label:'Сумиобленерго',family:'sumy',url:'https://www.soe.com.ua/consumers/shutdowns',origin:'https://www.soe.com.ua',capital:'Суми'},
 'ua-poltava':{regionPrefix:'UA53',label:'Полтаваобленерго',family:'poltava',url:'https://www.poe.pl.ua/disconnection/power-outages/',origin:'https://www.poe.pl.ua'},
 'ua-kharkiv':{regionPrefix:'UA63',label:'Харківобленерго',family:'kharkiv',url:'https://oblenergo.kharkiv.ua/uk/gaoinfo',origin:'https://pa.oblenergo.kharkiv.ua'},
 'ua-kirovohrad':{regionPrefix:'UA35',label:'Кіровоградобленерго',family:'kirovohrad',url:'https://kiroe.com.ua/electricity-blackout',origin:'https://kiroe.com.ua'},
 'ua-dnipro-dtek':{regionPrefix:'UA12',label:'ДТЕК Дніпровські електромережі',family:'dtek',url:'https://www.dtek-dnem.com.ua/ua/shutdowns',origin:'https://www.dtek-dnem.com.ua',cookie:'dnem'},
 'ua-zaporizhzhia':{regionPrefix:'UA23',label:'Запоріжжяобленерго',family:'zoe',url:'https://www.zoe.com.ua/outage/',origin:'https://www.zoe.com.ua'},
 'ua-donetsk-dtek':{regionPrefix:'UA14',label:'ДТЕК Донецькі електромережі',family:'dtek',url:'https://www.dtek-dem.com.ua/ua/shutdowns',origin:'https://www.dtek-dem.com.ua',cookie:'dem'}
});
const invalid=()=>{throw regionError('invalid_source');};
const label=v=>{if(typeof v!=='string'||!v.trim()||v.length>240||/[\x00-\x1f\x7f]/.test(v))invalid();return v;};
const id=v=>{v=String(v);if(!/^[0-9]{1,18}$/.test(v))invalid();return v;};
export const decodeEntities=s=>s.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[a-f\d]+);/gi,m=>{
 const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '};if(named[m])return named[m];let n=m[2].toLowerCase()==='x'?parseInt(m.slice(3),16):parseInt(m.slice(2),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'�';
});
const text=s=>label(decodeEntities(s.replace(/<[^>]*>/g,'')).trim());
export function selectOptions(html,selectId){
 const section=[...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].find(m=>new RegExp(`\\bid=["']${selectId}["']`,'i').test(m[1]));if(!section)invalid();
 const rows=[...section[2].matchAll(/<option\b[^>]*\bvalue=["']([0-9]+)["'][^>]*>([\s\S]*?)<\/option>/gi)].filter(m=>m[1]!=='0').map(m=>({key:id(m[1]),name:text(m[2])}));if(!rows.length||rows.length>100)invalid();return rows;
}
export function directoryRows(raw,{key,name,max=5000,house=false}={}){
 if(!Array.isArray(raw)||raw.length>max)invalid();const map=new Map();
 for(const r of raw){if(!r||typeof r!=='object')invalid();const value={key:id(r[key]),name:label(r[name])};
  if(house)value.name=value.name.replace(/\s+буд\.?$/u,'');label(value.name);
  if(map.has(value.key)&&map.get(value.key).name!==value.name)invalid();map.set(value.key,value);
 }return [...map.values()];
}
export function cnRows(raw){if(!raw||raw.status==='error'||!Array.isArray(raw.list))invalid();return directoryRows(raw.list.map(r=>({id:r[0],name:r[1]})),{key:'id',name:'name'});}
const unchecked={state:'unknown',status:'not_queried',complete:false,lines:[],provenance:{sourceUnavailable:true,sourceState:'queue_not_queried'}};
export class RegionalDiscoverySources {
 constructor({fetcher=operatorFetch,gate=async()=>{},finish=async()=>{},now=Date.now}={}){Object.assign(this,{fetcher,gate,finish,now});this.clients=new Map();this.sessions=new Map();this.indexes=new Map();}
 handles(op){return Object.hasOwn(COLLECTOR_SOURCES,op);}
 config(op){const c=COLLECTOR_SOURCES[op];if(!c)throw regionError('unsupported_operator',400);return c;}
 async request(op,path,{form,headers={},max=2500000,origin}={}){
  const c=this.config(op),base=origin||c.origin,url=new URL(path,base);
  // Callers use fixed public endpoints. No URL or host supplied by a user/catalog row.
  if(base!==c.origin&&!(op==='ua-zaporizhzhia'&&base==='https://script.google.com'))invalid();
  if(url.origin!==base||url.username||url.password)invalid();
  const ticket=await this.gate(op);let status=0,error=null,retry=0;
  try{const r=await this.fetcher(url.href,{method:form?'POST':'GET',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{accept:'application/json,text/html','user-agent':'Svitlo-public-discovery/1.0',...(form?{'content-type':'application/x-www-form-urlencoded; charset=UTF-8'}:{}),...headers},...(form?{body:new URLSearchParams(form).toString()}:{})});status=r.status;retry=Math.min(900000,Math.max(0,Number(r.headers.get('retry-after'))*1000||0));
   if(status===403||status===401){await r.body?.cancel();throw regionError('forbidden');}if(status===429){await r.body?.cancel();throw regionError('rate_limited',429);}if(status!==200){await r.body?.cancel();throw regionError('source_http_'+status);}
   const body=await boundedBody(r,max);if(/_Incapsula_Resource|<title>Just a moment|cf-chl-/i.test(body))throw regionError('forbidden');return {body,headers:r.headers};
  }catch(e){error=e.code||'source_unavailable';throw e;}finally{await this.finish(op,ticket,{status,error,retry}).catch(()=>{});}
 }
 async json(op,path,options){const {body}=await this.request(op,path,options);try{return JSON.parse(body);}catch{throw regionError('invalid_source');}}
 async kirovSession(op){let s=this.sessions.get(op);if(s?.until>this.now())return s;
  const {body,headers}=await this.request(op,'/electricity-blackout');const token=body.match(/ajaxToken:\s*["']([a-f0-9]{16,80})["']/)?.[1];if(!token)invalid();
  const cookie=(headers.getSetCookie?.()||[]).slice(0,16).map(x=>x.split(';',1)[0]).filter(x=>x.length<=4096).join('; ');s={token,cookie,html:body,until:this.now()+600000};this.sessions.set(op,s);return s;
 }
 async kirov(op,path){const s=await this.kirovSession(op),data=await this.json(op,'/electricity-blackout'+path,{form:{ajax:'1',token:s.token},headers:{cookie:s.cookie,'x-requested-with':'XMLHttpRequest'}});if(!data||!Array.isArray(data.data))invalid();return data.data;}
 async poltava(op,kind,branch,city='',street=''){return this.json(op,'/customs/search-disconnection-cabinet.php',{form:{disconn:JSON.stringify({operation_type:kind,filial_id:id(branch),city_id:city?id(city):'',street_id:street?id(street):''})}});}
 dtek(op){if(!this.clients.has(op)){const cfg=this.config(op),client=new DtekClient('ua-kyiv-region-dtek',{fetcher:this.fetcher,gate:()=>this.gate(op),finish:(_,ticket,result)=>this.finish(op,ticket,result),now:this.now});client.config={host:new URL(cfg.origin).hostname};client.csrfCookieName='_csrf-dtek-'+cfg.cookie;this.clients.set(op,client);}return this.clients.get(op);}
 async dtekIndex(op){const old=this.indexes.get(op);if(old&&old.until>this.now())return old.promise;const entry={until:this.now()+21600000};entry.promise=this.dtek(op).streets().then(cities=>({cities,checkedAt:this.now()})).catch(e=>{if(this.indexes.get(op)===entry)this.indexes.delete(op);throw e;});this.indexes.set(op,entry);return entry.promise;}
 async zoeIndex(){const op='ua-zaporizhzhia',old=this.indexes.get(op);if(old&&old.until>this.now())return old.promise;const entry={until:this.now()+21600000};entry.promise=this.request(op,'/macros/s/'+ZOE_DEPLOYMENT+'/callback?nocache_id=0',{origin:'https://script.google.com',form:{request:JSON.stringify(['getData','[]',null,[0],null,null])},headers:{'x-same-domain':'1',referer:'https://script.google.com/macros/s/'+ZOE_DEPLOYMENT+'/exec'}}).then(({body})=>({...parseZoePublic(body),checkedAt:this.now()})).catch(e=>{if(this.indexes.get(op)===entry)this.indexes.delete(op);throw e;});this.indexes.set(op,entry);return entry.promise;}
 async directory(op,{branch=null}={}){
  const cfg=this.config(op),family=cfg.family;let items,branches;
  if(family==='kharkiv')items=directoryRows(await this.json(op,'/frontend/web/index.php/uk/helper/get-villages'),{key:'adp_id',name:'aname'});
  else if(family==='poltava'){
   if(!branch){const {body}=await this.request(op,'/disconnection/power-outages/');branches=selectOptions(body,'input-filial-main');return {branches,complete:false};}
   items=directoryRows(await this.poltava(op,'city',branch),{key:'instance_id',name:'instance_name'});
  }else if(family==='kirovohrad'){
   if(!branch){branches=selectOptions((await this.kirovSession(op)).html,'fn_office');return {branches,complete:false};}
   items=directoryRows(await this.kirov(op,'/city/'+id(branch)),{key:'CityId',name:'CityName'});
  }else if(family==='chernihiv'){
   items=cnRows(await this.json(op,'/api/info_disable/?nq=city&q='+encodeURIComponent(cfg.capital)));return {items,complete:false,limitation:'capital_lookup_only'};
  }else if(family==='sumy'){
   const raw=await this.json(op,'/next-api/shutdowns/cities?search='+encodeURIComponent(cfg.capital),{headers:{'X-Source':'soe-website'}});
   // Never interpret opaque/error data as an empty authoritative directory.
   if(raw.payload)throw regionError('source_format_unsupported');items=directoryRows(raw.data||raw,{key:'id',name:'name'});return {items,complete:false,limitation:'capital_lookup_only'};
  }else if(family==='dtek'){
   const data=await this.dtekIndex(op);items=Object.keys(data.cities).map(name=>({key:label(name),name}));
  }else if(family==='zoe'){
   const index=await this.zoeIndex();return {items:[{key:ZOE_CITY_KEY,name:'м. Запоріжжя'}],complete:true,regionalComplete:false,directoryScope:'published_city_subset',acceptedRows:index.acceptedRows,skippedRows:index.skippedRows};
  }else invalid();
  return {items,complete:true};
 }
 async streets(r){const op=r.operator_id,cfg=this.config(op);let items;
  if(cfg.family==='poltava')items=directoryRows(await this.poltava(op,'street',r.branch_id,r.provider_city_id),{key:'instance_id',name:'instance_name'});
  else if(cfg.family==='kharkiv')items=directoryRows(await this.json(op,'/frontend/web/index.php/uk/helper/get-streets?adp_id='+id(r.provider_city_id)),{key:'adpid',name:'aname'});
  else if(cfg.family==='kirovohrad')items=(await this.kirov(op,'/street/'+id(r.provider_city_id))).map(x=>({key:id(x.StreetId),name:label([x.StreetType,x.StreetName].filter(Boolean).join(' '))}));
  else if(cfg.family==='chernihiv')throw regionError('public_directory_search_only');
  else if(cfg.family==='zoe'){if(r.provider_city_id!==ZOE_CITY_KEY)invalid();const index=await this.zoeIndex();return {items:[...index.streets.keys()].map(name=>({key:name,name})),checkedAt:index.checkedAt};}
  else if(cfg.family==='dtek'){const index=await this.dtekIndex(op),names=index.cities[r.provider_city_name];if(!Array.isArray(names)||names.length>5000)invalid();items=names.map(name=>({key:label(name),name}));return {items,checkedAt:index.checkedAt};}
  else throw regionError('public_directory_access_required');
  return {items,checkedAt:this.now()};
 }
 async houses(r,key){const op=r.operator_id,cfg=this.config(op);let items,resolutions=null;
  if(cfg.family==='poltava')items=directoryRows(await this.poltava(op,'building',r.branch_id,r.provider_city_id,key),{key:'instance_id',name:'instance_name'}).map(x=>({key:x.name,name:x.name}));
  else if(cfg.family==='kharkiv')items=directoryRows(await this.json(op,'/frontend/web/index.php/uk/helper/get-buildings?adp_id='+id(key)),{key:'adpid',name:'aname',house:true}).map(x=>({key:x.name,name:x.name}));
  else if(cfg.family==='kirovohrad')items=directoryRows(await this.kirov(op,'/house/'+id(key)),{key:'HouseId',name:'HouseName'}).map(x=>({key:x.name,name:x.name}));
  else if(cfg.family==='chernihiv')throw regionError('public_directory_search_only');
  else if(cfg.family==='zoe'){if(r.provider_city_id!==ZOE_CITY_KEY)invalid();const index=await this.zoeIndex(),houses=index.streets.get(key);if(!houses)invalid();return {items:[...houses.keys()].map(name=>({key:name,name})),checkedAt:index.checkedAt,resolution:house=>zoeResolution(houses.get(house),index.checkedAt)};}
  else if(cfg.family==='dtek'){const data=projectStreet(await this.dtek(op).houses(r.provider_city_name,key),this.now());items=Object.keys(data.houses).map(name=>({key:name,name}));resolutions=Object.fromEntries(items.map(x=>[x.key,resolveHouse(data,x.key)]));}
  else throw regionError('public_directory_access_required');
  if(items.length>5000)invalid();return {items,checkedAt:this.now(),resolution:key=>resolutions?.[key]||{...unchecked,checkedAt:this.now()}};
 }
}
