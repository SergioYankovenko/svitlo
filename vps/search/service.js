import {createHmac,timingSafeEqual} from 'node:crypto';import {sameHouse} from '../catalog/identity.js';
import {publicDocument,fingerprint} from './meili.js';
const cursorError=()=>Object.assign(Error('Пошук змінився. Повторіть запит'),{status:409,code:'search_cursor_expired'});
const invalidCursor=()=>Object.assign(Error('Некоректний курсор пошуку'),{status:400,code:'invalid_cursor'});
export class AddressSearch {
 constructor({bridge,client,secret}){Object.assign(this,{bridge,client,secret});}
 signature(value){return createHmac('sha256',this.secret).update('address-search-cursor-v1:'+JSON.stringify(value)).digest('hex');}
 cursor(value){return Buffer.from(JSON.stringify({...value,signature:this.signature(value)})).toString('base64url');}
 parse(cursor,query){if(!cursor)return null;let value;try{value=JSON.parse(Buffer.from(cursor,'base64url'));}catch{throw invalidCursor();}if(!value||typeof value!=='object'||!['meili','exact'].includes(value.engine))return null;
  const {signature,...data}=value;if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(this.signature(data)))||data.kind!==query.kind||data.parentId!==query.parentId||data.q!==query.q||data.engine==='meili'&&(!Number.isInteger(data.offset)||data.offset<0||data.offset>20000)||data.engine==='exact'&&(typeof data.lastLabel!=='string'||typeof data.lastId!=='string'))throw invalidCursor();return data;
 }
 async exact(query,limit,after){
  const rows=(await this.bridge.query(`select e.*,case when e.kind='city' then svitlo_vps.catalog_city_state(e.id) end route_state
   from svitlo_vps.catalog e where e.kind=$1 and e.parent_id is not distinct from $2::uuid and e.redirect_to is null
    and (svitlo_search.search_key(e.label)=svitlo_search.search_key($3) or ($1<>'address' and exists(select from svitlo_catalog.name_aliases a where a.entity_id=e.id and a.reviewed and a.valid_from<=now() and (a.valid_until is null or a.valid_until>now()) and svitlo_search.search_key(a.label)=svitlo_search.search_key($3))))
    and e.operator_id is distinct from 'map-only' and svitlo_vps.catalog_allowed(e.id)
    and (e.metadata->>'regionOperator' is null or coalesce(e.metadata->>'sourceActive','true')<>'false')
    and (e.kind<>'city' or svitlo_vps.catalog_city_state(e.id)<>'empty')
    and ($4::text is null or (e.label collate "C",e.id)>($4 collate "C",$5::uuid))
   order by e.label collate "C",e.id limit $6`,[query.kind,query.parentId,query.q,after?.lastLabel||null,after?.lastId||null,limit+1])).rows;
  if(!rows.length&&!after)return null;
  const page=rows.slice(0,limit),last=page.at(-1),more=rows.length>limit;
  return {rows:page,nextCursor:more?this.cursor({engine:'exact',...query,lastId:last.id,lastLabel:last.label}):null,complete:!more};
 }
 async search({kind,parentId,q,cursor,limit}){
  const query={kind,parentId,q},after=this.parse(cursor,query);if(cursor&&!after)return null; // Keep legacy keyset pagination on its original path.
  if(after?.engine==='exact')return this.exact(query,limit,after);
  if(!this.client){if(after)throw cursorError();return null;}
  // Exact names/numbers use an indexed authoritative lookup, also while the
  // derived index catches up. Fuzzy matching remains in the search engine.
  if(!cursor&&q.trim()){const exact=await this.exact(query,limit,null);if(exact)return exact;}
  const state=async()=>(await this.bridge.query('select svitlo_search.scope_state($1,$2) value',[kind,parentId])).rows[0].value;
  const before=await state();if(!before?.ready){if(after)throw cursorError();return null;}
  if(after&&after.generation!==before.generation)throw cursorError();
  const scope=kind+':'+(parentId||''),repair=async()=>this.bridge.query('select svitlo_search.request_repair($1,$2)',[kind,parentId]).catch(()=>{});
  if(!await this.client.anchor(before.generation,scope,before.scopeToken)){await repair();if(after)throw cursorError();return null;}
  let page;try{page=await this.client.search(before.generation,{kind,parentId,q,limit,offset:after?.offset||0});}
  catch(e){if(after)throw e;return null;}
  if(!page.ids.length&&!after)return null;
  const rows=page.ids.length?(await this.bridge.query(`select e.*,svitlo_search.document(e.id) search_document,case when e.kind='city' then svitlo_vps.catalog_city_state(e.id) end route_state from svitlo_vps.catalog e
   where e.id=any($1::uuid[]) and e.kind=$2 and e.parent_id is not distinct from $3::uuid and e.redirect_to is null
    and e.operator_id is distinct from 'map-only' and svitlo_vps.catalog_allowed(e.id)
    and (e.metadata->>'regionOperator' is null or coalesce(e.metadata->>'sourceActive','true')<>'false')
    and (e.kind<>'city' or svitlo_vps.catalog_city_state(e.id)<>'empty') order by array_position($1::uuid[],e.id)`,[page.ids,kind,parentId])).rows:[];
  const afterState=await state();if(!afterState?.ready||afterState.generation!==before.generation||afterState.scopeToken!==before.scopeToken||!await this.client.anchor(before.generation,scope,before.scopeToken)){if(after)throw cursorError();return null;}
  if(rows.some(r=>!r.search_document||fingerprint(publicDocument(r.search_document))!==page.fingerprints[r.id])){await repair();if(after)throw cursorError();return null;}
  const safe=kind==='address'&&q.trim()?rows.filter(r=>sameHouse(r.label,q)):rows;
  if(page.more&&(after?.offset||0)+limit>=20000)throw Object.assign(Error('Уточніть пошук'),{status:409,code:'search_capacity_limited'});
  return {rows:safe,nextCursor:page.more?this.cursor({engine:'meili',...query,generation:before.generation,offset:(after?.offset||0)+page.consumed}):null,complete:!page.more};
 }
}
