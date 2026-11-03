import {Service,publicProfile,DEFAULT_PREFS,ApiError} from '../../server/service.js';
import {randomUUID} from 'node:crypto';
import {universalEnvelope,selectedLine} from '../../app/lib/universal-contract.js';
import {seal} from './normalize.js';
import {mapOnlySnapshot} from '../maps/service.js';
export function repairSnapshot(old,now){
 const value=old?.universal;
 const universal=value?seal({...value,supportState:'degraded',freshUntil:Math.min(value.freshUntil,now-1),refreshAfter:now+3600000,resolution:{...value.resolution,state:'unknown',complete:false}}):null;
 return {...old,...(universal?universalEnvelope(universal,old.selectedLineId):{}),feedFailed:true,failures:['address_requires_reselection'],addressRepair:{required:true,code:'address_requires_reselection'}};
}
export class UniversalService extends Service {
 constructor(options,reader){super(options);this.reader=reader;this.maps=options.maps;
  const oldWeather=this.sync.weatherFor.bind(this.sync);this.sync.weatherFor=a=>a.canonicalAddressId&&a.operatorId!=='ua-cherkasy'?Promise.reject(Error('weather_not_supported')):oldWeather(a);
 }
 async canonicalAddress(body){const r=await this.reader.resolve(body),a=r.address;
  if(['disabled','unsupported'].includes(r.operator.supportState))throw new ApiError(503,'Джерело цього регіону тимчасово недоступне');
  if(!r.selection.lineId&&r.resolution.lines.length>1)throw new ApiError(409,'Оберіть лінію для цієї адреси');
  const e=await this.reader.catalog.entity(a.id);
  // Compatibility fields keep old staging cache consumers safe; provider routing uses canonical IDs exclusively.
  return {...(e.operator_id==='ua-cherkasy'?e.source_ref:{department:'universal:'+e.operator_id,cityId:a.cityId,streetId:a.streetId,house:a.house,city:a.city,street:a.street}),
   canonicalAddressId:a.id,operatorId:a.operatorId,lineId:r.selection.lineId,lineLabel:r.resolution.lines.find(l=>l.id===r.selection.lineId)?.label||null,multipleLines:r.resolution.lines.length>1,label:a.label,synthetic:r.operator.synthetic};
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
  const snapshot=universalEnvelope(s,lineId),candidate={...profile,snapshot,last_checked:now,next_check:Math.max(now+60000,s.refreshAfter),messages:profile.messages||[]};
  const result=await this.db.commitProfile(candidate,profile.snapshot_revision||0);
  if(result.status==='missing')throw new ApiError(404,'Адресу не знайдено');return result.profile;
 }
 async handle(owner,body){
  if(body.action==='save'&&body.address?.mapCandidateToken){
   if(!owner)throw new ApiError(401,'Потрібне підключення');if(body.confirmed!==true)throw new ApiError(400,'Підтвердьте адресу');
   if(!await this.db.rate(owner,40,60000))throw new ApiError(429,'Забагато запитів');
   const created=await this.maps.save(owner,body.address.mapCandidateToken,body.name,DEFAULT_PREFS);
   if(created.status==='limit')throw new ApiError(409,'Можна зберегти до 10 адрес');
   const p=await this.refresh(created.profile);return {profile:publicProfile(p),created:created.created};
  }
  if(owner&&['save','preview','resolve_queue'].includes(body.action)&&body.address&&!body.address.canonicalAddressId)await this.reader.catalog.validateLegacy(body.address);
  if(body.action==='save'&&body.address?.canonicalAddressId){
   if(!owner)throw new ApiError(401,'Потрібне підключення');if(body.confirmed!==true)throw new ApiError(400,'Підтвердьте адресу');
   if(!await this.db.rate(owner,40,60000))throw new ApiError(429,'Забагато запитів');
   const address=await this.canonicalAddress({addressId:body.address.canonicalAddressId,lineId:body.address.lineId});
   const created=await this.db.result(this.db.c.rpc('svitlo_profile_create_universal',{subject:owner,profile_id:randomUUID(),address_data:address,display_name:typeof body.name==='string'?body.name:'',preference_data:DEFAULT_PREFS}));
   if(created.status==='limit')throw new ApiError(409,'Можна зберегти до 10 адрес');
   const p=await this.refresh(created.profile);return {profile:publicProfile(p),created:created.created};
  }
  const result=await super.handle(owner,body);
  if(body.action==='dictionary'&&['city','street'].includes(body.kind)){
   result.items=(await this.reader.bridge.query(`select item from jsonb_array_elements($1::jsonb) item where not svitlo_vps.catalog_service_label($2,item->>'name')
    and not($2='city' and $3='3' and item->>'id'='116')`,[JSON.stringify(result.items),body.kind,body.parent||''])).rows.map(r=>r.item);
  }
  return result;
 }
}
