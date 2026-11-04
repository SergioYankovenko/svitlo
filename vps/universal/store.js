const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
export const apiError=(status,code,message=code)=>Object.assign(Error(message),{status,code});
export class Catalog {
 constructor(bridge,regions){this.db=bridge;this.regions=regions;}
 async operators(){return (await this.db.query("select * from svitlo_vps.operators where id<>'map-only' order by id")).rows;}
 async operator(id){return (await this.db.query('select * from svitlo_vps.operators where id=$1',[id])).rows[0];}
 async entity(id){if(!uuid(id))throw apiError(400,'invalid_id','Некоректний ідентифікатор');
  const seen=new Set();for(let n=0;n<8;n++){
   if(seen.has(id))throw apiError(503,'alias_cycle');seen.add(id);
   const r=(await this.db.query(`select e.*,s.label as street,s.metadata as street_metadata,c.label as city,c.id as city_id,c.metadata as city_metadata from svitlo_vps.catalog e
    left join svitlo_vps.catalog s on s.id=e.parent_id left join svitlo_vps.catalog c on c.id=s.parent_id where e.id=$1`,[id])).rows[0];
   if(!r)throw apiError(404,'address_not_found','Адресу не знайдено');
   if(r.metadata?.regionOperator&&(r.metadata.sourceActive===false||r.kind!=='city'&&r.street_metadata?.sourceActive===false||r.kind==='address'&&r.city_metadata?.sourceActive===false))throw apiError(409,'address_requires_reselection','Адресу більше не підтверджує джерело. Повторіть пошук');
   if(!r.redirect_to){if(!(await this.db.query('select svitlo_vps.catalog_allowed($1) allowed',[r.id])).rows[0].allowed){if(r.operator_id==='map-only')throw apiError(404,'address_not_found','Адресу не знайдено');throw apiError(409,'address_requires_reselection','Потрібно повторно обрати вулицю: цей запис є службовим');}return r;}id=r.redirect_to;
  }throw apiError(503,'alias_depth');
 }
 public(e){return {id:e.id,label:e.kind==='address'&&e.city?`${e.city}, ${e.street}${e.street_metadata?.districtVerified?' · '+e.street_metadata.district:''}, ${e.label}`:e.label,kind:e.kind,
  ...(e.kind==='address'?{cityId:e.city_id,city:e.city,streetId:e.parent_id,street:e.street,house:e.label,operatorId:e.operator_id}:{}),
  ...(e.metadata?.districtVerified?{district:e.metadata.district,districtVerified:true}:{}),synthetic:e.metadata?.synthetic===true};}
 async search({kind,parentId=null,q='',cursor=null,limit=50}={}){
  const map={cities:'city',streets:'street',houses:'address'};if(!map[kind]||typeof q!=='string'||q.length>120||!Number.isInteger(limit)||limit<1||limit>50)throw apiError(400,'invalid_search');
  if(kind!=='cities'&&!uuid(parentId))throw apiError(400,'invalid_parent');
  let source=null;if(kind!=='cities'){const parent=await this.entity(parentId);if(parent.kind!==(kind==='streets'?'city':'street'))throw apiError(400,'invalid_parent');parentId=parent.id;source=await this.regions?.ensureSearch(parent,kind);}
  let after=null;if(cursor){try{if(typeof cursor!=='string'||cursor.length>1024)throw Error();after=JSON.parse(Buffer.from(cursor,'base64url'));if(after.kind!==kind||after.parentId!==parentId||after.q!==q||!uuid(after.id)||typeof after.label!=='string')throw Error();}catch{throw apiError(400,'invalid_cursor');}}
  const text='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
  const r=await this.db.query(`select e.*,case when e.kind='city' then svitlo_vps.catalog_city_state(e.id) end as route_state from svitlo_vps.catalog e where e.kind=$1 and e.parent_id is not distinct from $2::uuid
   and e.redirect_to is null and e.label ilike $3 and coalesce(e.metadata->>'catalogStatus','')<>'service' and (e.metadata->>'regionOperator' is null or coalesce(e.metadata->>'sourceActive','true')<>'false') and e.operator_id is distinct from 'map-only'
   and (e.kind<>'city' or e.metadata->>'regionOperator' is null or e.source_ref->>'sourceName' ilike $3)
   and svitlo_vps.catalog_allowed(e.id) and (e.kind<>'city' or svitlo_vps.catalog_city_state(e.id)<>'empty')
   and ($1<>'street' or svitlo_vps.catalog_city_state($2::uuid)<>'empty')
   and ($4::text is null or (e.label collate "C",e.id)>($4 collate "C",$5::uuid))
   order by e.label collate "C",e.id limit $6`,[map[kind],parentId,text,after?.label||null,after?.id||null,limit+1]);
  const page=r.rows.slice(0,limit),last=page.at(-1),more=r.rows.length>limit;
  const coverage=kind==='streets'?(await this.db.query('select svitlo_vps.catalog_city_state($1) state',[parentId])).rows[0].state:'imported_subset';
  return {schemaVersion:1,items:page.map(e=>({...this.public(e),...(e.route_state?{routeState:e.route_state}:{})})),nextCursor:more?Buffer.from(JSON.stringify({kind,parentId,q,id:last.id,label:last.label})).toString('base64url'):null,complete:!more,coverage:source?.state==='cached'?'cached_subset':coverage,emptyConfirmed:!source&&page.length===0&&coverage==='empty',...(source?.state==='cached'?{sourceState:source.code,sourceCheckedAt:source.checkedAt,sourceFresh:false}:{})};
 }
 async legacy(ref){if(!ref||['department','cityId','streetId','house'].some(k=>typeof ref[k]!=='string'||!ref[k]||ref[k].length>120))throw apiError(400,'invalid_legacy');
  const r=(await this.db.query("select entity_id from svitlo_vps.catalog_aliases where operator_id='ua-cherkasy' and kind='address' and provider_key=$1::jsonb::text",[JSON.stringify([ref.department,ref.cityId,ref.streetId,ref.house])])).rows[0];
  if(!r)return {state:'needs_confirmation',address:null};
  try{return {state:'resolved',address:this.public(await this.entity(r.entity_id))};}catch(e){if(e.code==='address_requires_reselection')return {state:'needs_confirmation',reason:e.code,address:null};throw e;}
 }
 async validateLegacy(ref){if(!ref)return;
  const r=await this.db.query("select entity_id from svitlo_vps.catalog_aliases where operator_id='ua-cherkasy' and kind='street' and provider_key=$1::jsonb::text",[JSON.stringify([ref.department,ref.cityId,ref.streetId])]);
  if(r.rows[0])await this.entity(r.rows[0].entity_id);
  if(ref.street&&(await this.db.query("select svitlo_vps.catalog_service_label('street',$1) blocked",[ref.street])).rows[0].blocked)throw apiError(409,'address_requires_reselection','Потрібно повторно обрати вулицю');
 }
 async lines(addressId,result){
  let checkedAt=result.checkedAt||Date.now();
  // One transaction and address lock: partial replies merge, complete replies may retire old lines.
  const c=await this.db.pool.connect();try{await c.query('begin');await c.query("select pg_advisory_xact_lock(hashtextextended('universal-lines:'||$1,0))",[addressId]);
   const prior=(await c.query('select state,complete,checked_at,evidence from svitlo_vps.address_resolutions where address_id=$1',[addressId])).rows[0];
   const stale=prior&&prior.checked_at>checkedAt;
   if(stale){const unavailable=result.provenance?.source==='dtek-address'&&result.provenance.sourceUnavailable===true;result={...result,state:unavailable?'unknown':prior.state,complete:!unavailable&&prior.complete,provenance:unavailable?result.provenance:prior.evidence,lines:[]};checkedAt=prior.checked_at;}
   if(!stale){
   if(result.complete)await c.query('update svitlo_vps.address_lines set active=false where address_id=$1',[addressId]);
   for(const line of result.lines){await c.query(`insert into svitlo_vps.address_lines(address_id,source_key,label,group_code,evidence)
    values($1,$2,$3,$4,$5) on conflict(address_id,source_key) do update set label=excluded.label,group_code=excluded.group_code,evidence=excluded.evidence,active=true`,[addressId,line.key,line.label,line.groupCode??null,JSON.stringify(line.provenance||{})]);}
   await c.query(`insert into svitlo_vps.address_resolutions values($1,$2,$3,$4,$5) on conflict(address_id) do update set state=excluded.state,complete=excluded.complete,checked_at=excluded.checked_at,evidence=excluded.evidence`,[addressId,result.state,result.complete,checkedAt,JSON.stringify(result.provenance||{})]);
   }
   const rows=(await c.query('select id,source_key,label,group_code,evidence from svitlo_vps.address_lines where address_id=$1 and active order by id',[addressId])).rows;await c.query('commit');
   return {state:result.state,complete:result.complete,checkedAt,lines:rows.map(r=>({id:r.id,key:r.source_key,label:r.label,groupCode:r.group_code,provenance:r.evidence})),provenance:result.provenance||{}};
  }catch(e){await c.query('rollback');throw e;}finally{c.release();}
 }
}
