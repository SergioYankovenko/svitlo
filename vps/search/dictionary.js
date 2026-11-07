import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {houseKey} from '../catalog/identity.js';
const index='svitlo_dictionary_g_public01';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const dictionaryProof=(secret,scope,revision,row)=>createHmac('sha256',secret).update('dictionary-document-v1:'+JSON.stringify([scope,revision,row.id,row.name])).digest('hex');
const error=(status,code)=>Object.assign(Error('Повторіть пошук адреси'),{status,code});
export function dictionaryRows(rows){
 if(!Array.isArray(rows)||rows.length>25000)return null;
 const seen=new Set(),safe=[];
 for(const row of rows){if(typeof row?.id!=='string'||!row.id||row.id.length>150||typeof row.name!=='string'||!row.name.trim()||row.name.length>240||/[\x00-\x1f\x7f]/.test(row.id+row.name)||/^\s*(?:\[?невідом|невизначен|без вулиці|\*)/iu.test(row.name)||seen.has(row.id))continue;seen.add(row.id);safe.push({id:row.id,name:row.name});}
 return safe.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
export class DictionarySearch {
 constructor({bridge,client,secret}){Object.assign(this,{bridge,client,secret});}
 scope(route,settlement,kind,parent){return hash([route,settlement,kind,parent]);}
 signature(value){return createHmac('sha256',this.secret).update('dictionary-search-v1:'+JSON.stringify(value)).digest('hex');}
 cursor(value){return Buffer.from(JSON.stringify({...value,signature:this.signature(value)})).toString('base64url');}
 parse(cursor,query){if(!cursor)return null;let p;try{p=JSON.parse(Buffer.from(cursor,'base64url'));}catch{throw error(400,'invalid_settlement_catalog_cursor');}if(p.engine!=='dictionary')return null;
  const {signature,...value}=p;if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(this.signature(value)))||value.scope!==query.scope||value.q!==query.q||!Number.isInteger(value.offset)||value.offset<0||value.offset>20000)throw error(400,'invalid_settlement_catalog_cursor');return value;
 }
 async search({scope,q,limit,cursor,kind}){
  const after=this.parse(cursor,{scope,q});if(cursor&&!after||!this.client)return null;
  const state=async()=>(await this.bridge.query('select svitlo_search.dictionary_state($1) value',[scope])).rows[0].value;
  const before=await state();if(!before?.ready){if(after)throw error(409,'search_cursor_expired');return null;}
  if(after&&after.revision!==before.revision)throw error(409,'search_cursor_expired');
  try{
   const filter=['scope = '+JSON.stringify(scope),'revision = '+JSON.stringify(before.revision)];
   if(kind==='house'&&q.trim())filter.push('houseKey = '+JSON.stringify(houseKey(q)||''));
   const result=await this.client.request(this.client.index(index)+'/search',{method:'POST',timeout:2000,body:{q:kind==='house'?'':q,filter,sort:['sortName:asc','id:asc'],offset:after?.offset||0,limit:limit+1,attributesToRetrieve:['providerId','label','proof']}});
   if(!Array.isArray(result.hits)||result.hits.length>limit+1||result.hits.some(x=>typeof x.providerId!=='string'||typeof x.label!=='string'||typeof x.proof!=='string'||!/^[a-f0-9]{64}$/.test(x.proof)||!timingSafeEqual(Buffer.from(x.proof),Buffer.from(dictionaryProof(this.secret,scope,before.revision,{id:x.providerId,name:x.label})))))throw Object.assign(error(503,'invalid_search_response'),{indexCorrupt:true});
   const next=await state();if(!next?.ready||next.revision!==before.revision){if(after)throw error(409,'search_cursor_expired');return null;}
   if(!result.hits.length&&!after)return null;
   const more=result.hits.length>limit,offset=(after?.offset||0)+limit;
   if(more&&offset>=20000)throw error(409,'search_capacity_limited');
   return {page:result.hits.slice(0,limit).map(x=>({id:x.providerId,name:x.label})),more,nextCursor:more?this.cursor({engine:'dictionary',scope,q,revision:before.revision,offset}):null};
  }catch(e){if(e.httpStatus===404||e.indexCorrupt)await this.bridge.query('select svitlo_search.dictionary_repair($1,$2)',[scope,before.revision]).catch(()=>{});if(after||e.status===409)throw e;return null;}
 }
 async stage({route,settlement,kind,parent,rows}){
  if(!this.client)return;const safe=dictionaryRows(rows);if(!safe)return;
  // Only a public provider dictionary enters this projection. Source fetch time
  // is deliberately not represented as an accepted schedule/plan timestamp.
  await this.bridge.query('select svitlo_search.dictionary_stage($1,$2,$3,$4,$5,$6::jsonb)',[this.scope(route,settlement,kind,parent),route,settlement,kind,parent,JSON.stringify(safe)]).catch(()=>{});
 }
}
export class DictionaryIndexer {
 constructor({pool,client,secret}){Object.assign(this,{pool,client,secret});this.initialized=false;this.configuredAt=0;}
 async tick(){
  if(!this.initialized||Date.now()-this.configuredAt>=60000){try{await this.client.request(this.client.index(index));}catch(e){if(e.httpStatus!==404)throw e;await this.client.wait(await this.client.request('/indexes',{method:'POST',body:{uid:index,primaryKey:'id'}}));}
   await this.client.wait(await this.client.request(this.client.index(index)+'/settings',{method:'PATCH',body:{searchableAttributes:['label'],filterableAttributes:['scope','revision','houseKey'],sortableAttributes:['sortName','id'],displayedAttributes:['providerId','label','proof'],pagination:{maxTotalHits:20000}}}));this.initialized=true;this.configuredAt=Date.now();}
  const jobs=(await this.pool.query('select svitlo_search.dictionary_claim() value')).rows[0].value;if(!jobs)return {state:'idle'};
  try{
   // Same partition has a fenced lease; revision filters also isolate a stale
   // sender whose engine task finishes after the lease was lost.
   const docs=jobs.rows.map(r=>({id:hash([jobs.scope,jobs.revision,r.id]),providerId:r.id,label:r.name,scope:jobs.scope,revision:jobs.revision,proof:dictionaryProof(this.secret,jobs.scope,jobs.revision,r),houseKey:jobs.kind==='house'?houseKey(r.name)||'':'',sortName:r.name.normalize('NFC').toLocaleLowerCase('uk-UA')}));
   for(let i=0;i<docs.length;i+=200)await this.client.upsert(index,docs.slice(i,i+200));
   // Delete only captured obsolete revisions. A late worker must never delete
   // a newer revision that was staged after its own lease expired.
   if(jobs.obsolete.length)await this.client.wait(await this.client.request(this.client.index(index)+'/documents/delete',{method:'POST',body:{filter:['scope = '+JSON.stringify(jobs.scope),'revision IN '+JSON.stringify(jobs.obsolete)]}}));
   await this.pool.query('select svitlo_search.dictionary_finish($1,$2,$3)',[jobs.scope,jobs.token,jobs.revision]);
   return {state:'progress'};
  }catch(e){if(e.httpStatus===404)this.initialized=false;await this.pool.query('select svitlo_search.dictionary_fail($1,$2)',[jobs.scope,jobs.token]);throw e;}
 }
 async loop({stopping=()=>false,onError=()=>{}}={}){while(!stopping()){let progress=false;try{progress=(await this.tick()).state==='progress';}catch{onError('dictionary_index_error');}await new Promise(r=>setTimeout(r,progress?25:1000));}}
}
