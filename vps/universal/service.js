import {retainPublishedDays} from '../../app/lib/universal-history.js';
import {failedPlanRead} from '../../app/lib/retained-plan.js';
import {Service,publicProfile,DEFAULT_PREFS,ApiError} from '../../server/service.js';
import {randomUUID} from 'node:crypto';
import {universalEnvelope,selectedLine} from '../../app/lib/universal-contract.js';
import {seal} from './normalize.js';
import {mergeHistory} from '../../app/lib/parsers.js';
import {messageTitle,preferences} from '../../app/lib/notifications.js';
import {dayKey} from '../../app/lib/time.js';
import {universalMessages} from './messages.js';
import {mapOnlySnapshot} from '../maps/service.js';
import {confirmedLines} from '../../app/lib/address-groups.js';
export function repairSnapshot(old,now){
 const value=old?.universal;
 const universal=value?seal({...value,supportState:'degraded',freshUntil:Math.min(value.freshUntil,now-1),refreshAfter:now+3600000,resolution:{...value.resolution,state:'unknown',complete:false}}):null;
 return {...old,...(universal?universalEnvelope(universal,old.selectedLineId):{}),feedFailed:true,failures:['address_requires_reselection'],addressRepair:{required:true,code:'address_requires_reselection'}};
}
export class UniversalService extends Service {
 constructor(options,reader){super(options);this.reader=reader;this.maps=options.maps;this.unresolvedLog=options.unresolvedLog;
 }
 async canonicalAddress(body){const r=await this.reader.resolve(body),a=r.address;
  if(r.resolution.provenance?.sourceUnavailable||['disabled','unsupported'].includes(r.operator.supportState))throw new ApiError(503,'Джерело цього регіону тимчасово недоступне');
  const lines=body.expandLines&&!body.allowUnresolved?confirmedLines(r):[],selected=r.selection.lineId||lines[0]?.id||null;
  if(!body.allowUnresolved&&!selected&&r.resolution.lines.length>1)throw new ApiError(409,'Оберіть лінію для цієї адреси');
  const e=await this.reader.catalog.entity(a.id);
  // Compatibility fields keep old staging cache consumers safe; provider routing uses canonical IDs exclusively.
  const address={...(e.operator_id==='ua-cherkasy'?e.source_ref:{department:'universal:'+e.operator_id,cityId:a.cityId,streetId:a.streetId,house:a.house,city:a.city,street:a.street}),
   canonicalAddressId:a.id,operatorId:a.operatorId,lineId:selected,lineLabel:r.resolution.lines.find(l=>l.id===selected)?.label||null,multipleLines:r.resolution.lines.length>1,label:a.label,synthetic:r.operator.synthetic,...(body.allowUnresolved&&!r.selection.lineId&&!['resolved','excluded'].includes(r.resolution.state)?{queueUnresolved:true,queueReason:r.resolution.state,queueCandidates:[...new Set(r.resolution.lines.map(l=>l.groupCode).filter(Boolean))].slice(0,32)}:{})};
  return lines.length>1?{...address,_lineAddresses:lines.map(l=>({...address,lineId:l.id,lineLabel:l.label}))}:address;
 }
 async resolveAddress(input){await this.reader.catalog.validateLegacy(input);const a=await super.resolveAddress(input);await this.reader.catalog.validateLegacy(a);return a;}
 async refresh(profile,...args){const now=this.now();let s;
  if(profile.address.mapOnly){const result=await this.db.commitProfile({...profile,snapshot:mapOnlySnapshot(profile.address,profile.snapshot),last_checked:now,next_check:now+86400000},profile.snapshot_revision||0);
   if(result.status==='missing')throw new ApiError(404,'Адресу не знайдено');return result.profile;}
  try{
   if(!profile.address.canonicalAddressId){await this.reader.catalog.validateLegacy(profile.address);return await super.refresh(profile,...args);}
   s=await this.reader.snapshot(profile.address.canonicalAddressId,this.reader.range({}));
  }catch(e){if(e.code!=='address_requires_reselection')throw e;
   const result=await this.db.commitProfile({...profile,snapshot:repairSnapshot(profile.snapshot||{},now),last_checked:now,next_check:now+3600000},profile.snapshot_revision||0);
   if(result.status==='missing')throw new ApiError(404,'Адресу не знайдено');return result.profile;
  }
  let lineId=profile.address.lineId;if(!lineId&&s.resolution.complete&&s.lines.length===1)lineId=s.lines[0].id;
  s=seal(retainPublishedDays(s,profile.snapshot?.universal,dayKey(now),now));
  if(!lineId&&failedPlanRead(s)&&s.addressId===profile.snapshot?.universal?.addressId&&s.operatorId===profile.snapshot?.universal?.operatorId&&s.lines.some(l=>l.id===profile.snapshot.selectedLineId))lineId=profile.snapshot.selectedLineId;
  const snapshot=universalEnvelope(s,lineId),updates=universalMessages(snapshot,profile.snapshot,now,profile.messages||[]),candidate={...profile,snapshot,last_checked:now,next_check:Math.max(now+60000,s.refreshAfter),messages:mergeHistory(profile.messages||[],updates,now)};
  const result=await this.db.commitProfile(candidate,profile.snapshot_revision||0);
  if(result.status==='missing')throw new ApiError(404,'Адресу не знайдено');
  if(result.status!=='conflict'&&profile.last_checked){const known=new Set((profile.messages||[]).map(m=>m.id)),prefs=preferences(result.profile.preferences);for(const m of updates){const channel=m.kind==='schedule'?m.revisionType:'address_emergency';if(!known.has(m.id)&&m.scope!=='region'&&m.date>=dayKey(now)&&prefs[m.kind==='schedule'?channel:'emergency'])await this.enqueue(result.profile,m.id,messageTitle(m),m.date,channel);}}
  return result.profile;
 }
 async handle(owner,body){
  if(body.action==='save'&&body.address?.mapCandidateToken){
   if(!owner)throw new ApiError(401,'Потрібне підключення');if(body.confirmed!==true)throw new ApiError(400,'Підтвердьте адресу');
   if(!await this.db.rate(owner,40,60000))throw new ApiError(429,'Забагато запитів');
   const created=await this.maps.save(owner,body.address.mapCandidateToken,body.name,this.defaultPreferences);
   if(created.status==='limit')throw new ApiError(409,'Можна зберегти до 10 адрес');
   if(created.profile.address?.queueUnresolved&&this.unresolvedLog)await this.unresolvedLog(created.profile.address,created.profile.id);
   const p=await this.refresh(created.profile);return {profile:publicProfile(p),created:created.created};
  }
  if(owner&&['save','preview','resolve_queue'].includes(body.action)&&body.address&&!body.address.canonicalAddressId)await this.reader.catalog.validateLegacy(body.address);
  if(body.action==='save'&&body.address?.canonicalAddressId){
   if(!owner)throw new ApiError(401,'Потрібне підключення');if(body.confirmed!==true)throw new ApiError(400,'Підтвердьте адресу');
   if(!await this.db.rate(owner,40,60000))throw new ApiError(429,'Забагато запитів');
   const address=await this.canonicalAddress({addressId:body.address.canonicalAddressId,lineId:body.address.lineId,allowUnresolved:body.address.queueUnresolved===true,expandLines:true});
   if(address._lineAddresses){
    const created=await this.db.result(this.db.c.rpc('svitlo_profile_group_create',{subject:owner,addresses:address._lineAddresses,display_name:typeof body.name==='string'?body.name:'',preference_data:this.defaultPreferences}));
    if(created.status==='limit')throw new ApiError(409,'Досягнуто ліміт адрес вашої підписки');
    if(created.status==='bound_unresolved')throw new ApiError(409,'Спочатку уточніть лінію підключеного датчика');
    const profiles=[];for(const p of created.profiles)profiles.push(publicProfile(await this.refresh(p)));
    return {profile:profiles[0],profiles,created:created.created,addressGroupId:address.canonicalAddressId};
   }
   const created=await this.db.result(this.db.c.rpc('svitlo_profile_create_universal',{subject:owner,profile_id:randomUUID(),address_data:address,display_name:typeof body.name==='string'?body.name:'',preference_data:this.defaultPreferences}));
   if(created.status==='limit')throw new ApiError(409,'Досягнуто ліміт адрес вашої підписки');
   if(created.status==='bound_unresolved')throw new ApiError(409,'Спочатку уточніть лінію підключеного датчика');
   if(created.profile.address?.queueUnresolved&&this.unresolvedLog)await this.unresolvedLog(created.profile.address,created.profile.id);
   const p=await this.refresh(created.profile);return {profile:publicProfile(p),created:created.created};
  }
  const result=await super.handle(owner,body);
  if(['sync','bootstrap'].includes(body.action)&&this.reader.bridge){result.addressQuota=await this.db.result(this.db.c.rpc('svitlo_address_quota',{subject:owner}));}
  if(body.action==='dictionary'&&['city','street'].includes(body.kind)){
   result.items=(await this.reader.bridge.query(`select item from jsonb_array_elements($1::jsonb) item where not svitlo_vps.catalog_service_label($2,item->>'name')
    and not($2='city' and $3='3' and item->>'id'='116')`,[JSON.stringify(result.items),body.kind,body.parent||''])).rows.map(r=>r.item);
  }
  return result;
 }
}
