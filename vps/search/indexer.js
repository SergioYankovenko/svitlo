import {randomBytes} from 'node:crypto';
import {publicDocument,fingerprint,scopeKeys,anchorId} from './meili.js';
export class SearchIndexer {
 constructor({pool,client,onError=()=>{}}){Object.assign(this,{pool,client,onError});this.initialized=new Set();}
 async generations(c){return (await c.query("select * from svitlo_search.generations where state in ('active','standby','building','ready') order by created_at")).rows;}
 async readBatch(c,{checkpoint=null,root=null,kind=null,extraScopes=[]}={}){
  await c.query('begin isolation level repeatable read read only');try{
   const rows=(await c.query('select svitlo_search.page($1,$2,200,$3) value',[checkpoint,root,kind])).rows[0].value;
   const scopes=[...new Set([...scopeKeys(rows),...extraScopes])].sort();
   const tokens=scopes.length?(await c.query("select x.scope,coalesce(t.token::text,'') token from unnest($1::text[]) x(scope) left join svitlo_search.scope_tokens t on t.scope=x.scope",[scopes])).rows:[];
   const rootExists=root?(await c.query('select exists(select from svitlo_vps.catalog where id=$1) value',[root])).rows[0].value:true;
   await c.query('commit');return {rows,tokens,rootExists};
  }catch(e){await c.query('rollback');throw e;}
 }
 async writeBatch(c,targets,batch,{deletedRoot=null,rootKind=null}={}){
  const records=batch.rows.map(({id,document})=>{
   if(!document)return {id,kind:batch.work?.find(w=>w.entity_id===id)?.kind||rootKind||'address',allowed:false,parentId:'',label:'',searchLabel:'',aliases:[],houseKey:'',sortLabel:'',fingerprint:fingerprint('deleted')};
   const doc=publicDocument(document);return {...doc,fingerprint:fingerprint(doc)};
  });
  if(deletedRoot)records.push({id:deletedRoot,kind:rootKind,allowed:false,parentId:'',label:'',searchLabel:'',aliases:[],houseKey:'',sortLabel:'',fingerprint:fingerprint('deleted')});
  // Scope markers travel in the same atomic indexing task as the documents.
  // A late request from a lost writer therefore advertises its old scope token.
  const anchors=batch.tokens.map(t=>({id:anchorId(t.scope),kind:'anchor',allowed:false,parentId:'',label:'',searchLabel:'',aliases:[],houseKey:'',sortLabel:'',scopeKey:t.scope,scopeToken:t.token}));
  for(const target of targets){
   await c.query('select pg_backend_pid()'); // Stop a lost SQL writer before posting another target.
   await this.client.upsert(target.name,[...records,...anchors]);
   if(records.length)await c.query(`insert into svitlo_search.receipts(generation,entity_id,fingerprint)
    select $1,x.id,x.fingerprint from jsonb_to_recordset($2::jsonb) x(id uuid,fingerprint text)
    on conflict(generation,entity_id) do update set fingerprint=excluded.fingerprint,indexed_at=clock_timestamp()`,[target.name,JSON.stringify(records.map(r=>({id:r.id,fingerprint:r.fingerprint})))]);
  }
 }
 async readLeaves(c){
  await c.query('begin isolation level repeatable read read only');try{
   const work=(await c.query("select * from svitlo_search.work w where kind in ('city','street','address') and cursor is null and not exists(select from svitlo_vps.catalog e where e.parent_id=w.entity_id) order by changed_at,entity_id limit 200")).rows;
   const rows=work.length?(await c.query("select jsonb_agg(jsonb_build_object('id',x,'document',svitlo_search.document(x))) value from unnest($1::uuid[]) x",[work.map(w=>w.entity_id)])).rows[0].value:[];
   const extra=[];for(const w of work){if(w.kind==='city')extra.push('city:','street:'+w.entity_id);if(w.kind==='street')extra.push('address:'+w.entity_id);for(const parent of w.affected_parents)if(['street','address'].includes(w.kind))extra.push(w.kind+':'+parent);}
   const scopes=[...new Set([...scopeKeys(rows),...extra])],tokens=scopes.length?(await c.query("select x.scope,coalesce(t.token::text,'') token from unnest($1::text[]) x(scope) left join svitlo_search.scope_tokens t on t.scope=x.scope",[scopes])).rows:[];
   await c.query('commit');return {work,rows,tokens};
  }catch(e){await c.query('rollback');throw e;}
 }
 async tick(){
  const c=await this.pool.connect();let locked=false;try{
   locked=(await c.query('select pg_try_advisory_lock(311032031) value')).rows[0].value;if(!locked)return {state:'other_writer'};
   let targets=await this.generations(c);
   if(!targets.length){await c.query('select svitlo_search.create_generation($1)',['svitlo_catalog_g_'+randomBytes(6).toString('hex')]);targets=await this.generations(c);}
   for(const target of targets)if(!this.initialized.has(target.name)){
    const created=await this.client.ensure(target.name);await this.client.drain(target.name);this.initialized.add(target.name);
    if(created&&target.backfill_complete){await c.query("update svitlo_search.generations set state='building',backfill_complete=false,checkpoint=null where name=$1",[target.name]);target.state='building';target.backfill_complete=false;target.checkpoint=null;}
   }
   const leaves=await this.readLeaves(c);
   if(leaves.work.length){
    await this.writeBatch(c,targets,leaves);
    await c.query('delete from svitlo_search.work w using jsonb_to_recordset($1::jsonb) x(id uuid,token uuid) where w.entity_id=x.id and w.token=x.token',[JSON.stringify(leaves.work.map(w=>({id:w.entity_id,token:w.token})))]);
    return {state:'projected',documents:leaves.rows.length};
   }
   const work=(await c.query('select * from svitlo_search.work order by changed_at,entity_id limit 1')).rows[0];
   if(work){
    const extraScopes=work.kind==='city'?['city:','street:'+work.entity_id]:work.kind==='street'?['address:'+work.entity_id]:work.kind==='global_city'?['city:']:[];
    for(const parent of work.affected_parents)if(['street','address'].includes(work.kind))extraScopes.push(work.kind+':'+parent);
    const batch=await this.readBatch(c,{checkpoint:work.cursor,root:work.kind==='global_city'?null:work.entity_id,kind:work.kind==='global_city'?'city':null,extraScopes});
    await this.writeBatch(c,targets,batch,{deletedRoot:!batch.rootExists?work.entity_id:null,rootKind:work.kind});
    if(batch.rows.length===200)await c.query('update svitlo_search.work set cursor=$3 where entity_id=$1 and token=$2',[work.entity_id,work.token,batch.rows.at(-1).id]);
    else await c.query('delete from svitlo_search.work where entity_id=$1 and token=$2',[work.entity_id,work.token]);
    return {state:'projected',documents:batch.rows.length};
   }
   const building=targets.find(t=>t.state==='building');
   if(building){
    const batch=await this.readBatch(c,{checkpoint:building.checkpoint});await this.writeBatch(c,[building],batch);
    if(batch.rows.length)await c.query('update svitlo_search.generations set checkpoint=$2 where name=$1',[building.name,batch.rows.at(-1).id]);
    else await c.query("update svitlo_search.generations set backfill_complete=true,state='ready' where name=$1",[building.name]);
    return {state:'backfilling',documents:batch.rows.length};
   }
   const ready=targets.find(t=>t.state==='ready');if(ready)return {state:(await c.query('select svitlo_search.activate($1) value',[ready.name])).rows[0].value?'activated':'catching_up'};
   return {state:'idle'};
  }finally{if(locked)await c.query('select pg_advisory_unlock(311032031)').catch(()=>{});c.release();}
 }
 async loop({stopping=()=>false,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  let lastError=0;while(!stopping()){
   let delay=1000;try{const result=await this.tick();if(result.documents>0)delay=25;}catch{if(Date.now()-lastError>60000){lastError=Date.now();this.onError('search_indexer_error');}}
   if(!stopping())await sleep(delay);
  }
 }
}
