import {readFileSync,existsSync} from 'node:fs';import {houseKey} from '../catalog/identity.js';
import {createHash} from 'node:crypto';
const generationPattern=/^svitlo_(?:catalog|dictionary)_g_[a-z0-9]{8,32}$/;
export const searchError=code=>Object.assign(Error('Пошук тимчасово недоступний'),{status:503,code});
export function publicDocument(value){
 if(!value||typeof value.id!=='string'||!['city','street','address'].includes(value.kind)||typeof value.label!=='string')throw searchError('invalid_index_document');
 return {id:value.id,kind:value.kind,parentId:value.parentId||'',label:value.label,searchLabel:value.searchLabel||value.label,aliases:[...new Set(value.aliases||[])].sort(),operatorId:value.operatorId||'',geoCodes:[...new Set(value.geoCodes||[])].sort(),district:value.district||'',allowed:value.allowed===true,houseKey:value.kind==='address'?houseKey(value.label)||'':'',sortLabel:value.label.normalize('NFC').toLocaleLowerCase('uk-UA')};
}
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const anchorId=scope=>'scope_'+fingerprint(scope);
export function scopeKeys(rows){const keys=new Set();for(const {id,document:d} of rows){if(!d)continue;keys.add(d.kind+':'+(d.parentId||''));if(d.kind==='city')keys.add('street:'+id);if(d.kind==='street')keys.add('address:'+id);}return [...keys].sort();}
export class MeiliClient {
 constructor({url,key,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  const parsed=new URL(url);if(parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/'||parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['search','localhost','127.0.0.1'].includes(parsed.hostname)))throw Error('invalid_search_origin');
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,512}$/.test(key))throw Error('invalid_search_key');
  Object.assign(this,{url:parsed.origin,key,fetcher,now,sleep});this.retryAt=0;
 }
 index(name){if(!generationPattern.test(name))throw searchError('invalid_search_generation');return '/indexes/'+name;}
 async request(path,{method='GET',body,timeout=5000}={}){
  if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))throw searchError('invalid_search_path');
  let response;try{response=await this.fetcher(this.url+path,{method,headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(timeout)});}catch{throw searchError('search_unavailable');}
  const chunks=[];let size=0;for await(const chunk of response.body||[]){size+=chunk.byteLength;if(size>4000000)throw searchError('search_response_too_large');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw searchError('invalid_search_response');}
  if(!response.ok){const e=searchError('search_unavailable');e.httpStatus=response.status;throw e;}return value;
 }
 async wait(task,{timeout=30000,stopping=()=>false}={}){
  if(!Number.isSafeInteger(task?.taskUid))throw searchError('invalid_search_task');const end=this.now()+timeout;
  while(!stopping()&&this.now()<end){const r=await this.request('/tasks/'+task.taskUid);if(r.status==='succeeded')return r;if(['failed','canceled'].includes(r.status))throw searchError('index_task_failed');await this.sleep(100);}
  throw searchError(stopping()?'index_stopping':'index_task_timeout');
 }
 async drain(name,{stopping=()=>false}={}){
  this.index(name);const end=this.now()+30000;
  while(!stopping()&&this.now()<end){const r=await this.request('/tasks?indexUids='+encodeURIComponent(name)+'&statuses=enqueued,processing&limit=1');if(Array.isArray(r.results)&&r.results.length===0)return;await this.sleep(100);}
  throw searchError('index_drain_timeout');
 }
 async ensure(name){
  let created=false;const path=this.index(name);try{await this.request(path);}catch(e){if(e.httpStatus!==404)throw e;await this.wait(await this.request('/indexes',{method:'POST',body:{uid:name,primaryKey:'id'}}));created=true;}
  await this.wait(await this.request(path+'/settings',{method:'PATCH',body:{filterableAttributes:['kind','parentId','allowed','operatorId','geoCodes','houseKey'],sortableAttributes:['sortLabel','id'],searchableAttributes:['searchLabel','aliases'],displayedAttributes:['id','fingerprint','kind','scopeKey','scopeToken'],pagination:{maxTotalHits:20000},typoTolerance:{disableOnAttributes:['houseKey']}}}));
  return created;
 }
 async upsert(name,documents){if(documents.length)await this.wait(await this.request(this.index(name)+'/documents',{method:'POST',body:documents}));}
 async remove(name,ids){if(ids.length)await this.wait(await this.request(this.index(name)+'/documents/delete-batch',{method:'POST',body:ids}));}
 async anchor(name,scope,token){
  if(this.now()<this.retryAt)return false;
  try{const row=await this.request(this.index(name)+'/documents/'+anchorId(scope),{timeout:2000});return row.kind==='anchor'&&row.scopeKey===scope&&row.scopeToken===token;}
  catch(e){if(e.httpStatus!==404)this.retryAt=this.now()+10000;return false;}
 }
 async search(name,{kind,parentId,q='',offset=0,limit=50}){
  if(this.now()<this.retryAt)throw searchError('search_cooldown');
  // Meilisearch equality does not match an empty string. Cities are root
  // documents with an explicitly empty parentId.
  const filter=['kind = '+JSON.stringify(kind),parentId?'parentId = '+JSON.stringify(parentId):'parentId IS EMPTY','allowed = true'];
  if(kind==='address'&&q.trim()){const key=houseKey(q);if(key===null)return {ids:[],more:false,consumed:0};filter.push('houseKey = '+JSON.stringify(key));}
  try{const result=await this.request(this.index(name)+'/search',{method:'POST',timeout:2000,body:{q:kind==='address'?'':q,filter,sort:['sortLabel:asc','id:asc'],offset,limit:limit+1,attributesToRetrieve:['id','fingerprint']}});
   if(!Array.isArray(result.hits)||result.hits.length>limit+1||result.hits.some(h=>typeof h.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(h.id)))throw searchError('invalid_search_response');
   return {ids:result.hits.slice(0,limit).map(h=>h.id),fingerprints:Object.fromEntries(result.hits.map(h=>[h.id,h.fingerprint])),more:result.hits.length>limit,consumed:Math.min(result.hits.length,limit)};
  }catch(e){this.retryAt=this.now()+10000;throw e;}
 }
}
export function configuredMeili(role='read'){
 const file=role==='write'?'/run/search/write-key':'/run/search/read-key';if(!existsSync(file))return null;
 try{return new MeiliClient({url:process.env.MEILI_URL||'http://search:7700',key:readFileSync(file,'utf8').trim()});}catch{return null;}
}
