import {createHmac} from 'node:crypto';
import {SharedCategories} from '../../server/shared-categories.js';
import {dayKey,addDays,monday} from '../../app/lib/time.js';
import {validDate} from '../../app/lib/lifecycle.js';
import {validUniversal} from '../../app/lib/universal-contract.js';
import {Catalog,apiError} from './store.js';
import {adapterFor} from './adapters.js';
import {degraded,normalizeLegacy,retainPartial} from './normalize.js';
export class UniversalReader {
 constructor({db,bridge,legacy,source,secret,regions}){Object.assign(this,{db,bridge,legacy,source,secret,regions});this.catalog=new Catalog(bridge,regions);this.shared=new SharedCategories(db,secret,{ttl:300000});}
 async capabilities(){const operators=await this.catalog.operators();return {schemaVersion:1,apiVersion:'1.0.0',featureSet:'universal',timeZones:['Europe/Kyiv'],
  categories:['hourly','planned','unplanned','emergency'],limits:{search:50,batch:10,days:14},addressFallback:{source:'visicom',requiresSession:true,approximate:true,preserveHouse:true},operators:operators.map(o=>({id:o.id,label:o.label,supportState:adapterFor(o,this)?o.state:'unsupported',synthetic:o.is_test,coverage:o.config.coverage,unitSupported:o.config.unitSupported===true})),push:false,sensors:false};}
 checkVersion(body){if(body.schemaVersion!==undefined&&body.schemaVersion!==1)throw apiError(400,'unsupported_schema','Ця версія формату не підтримується');}
 range(body){const fromDate=body.fromDate??monday(dayKey()),toDate=body.toDate??addDays(fromDate,13);
  if(!validDate(fromDate)||!validDate(toDate)||toDate<fromDate||(Date.parse(toDate)-Date.parse(fromDate))/86400000>13||Math.abs(Date.parse(fromDate)-Date.parse(dayKey()))>31*86400000)throw apiError(400,'invalid_date_range');
  return {fromDate,toDate};
 }
 async resolveEntity(entity){
  const op=await this.catalog.operator(entity.operator_id),adapter=op&&adapterFor(op,this);
  if(!op||!adapter||op.state==='disabled')return {address:this.catalog.public(entity),operator:{id:entity.operator_id,label:op?.label||'',supportState:!adapter?'unsupported':'disabled',synthetic:!!op?.is_test},resolution:{state:'unknown',complete:false,lines:[],checkedAt:0,provenance:{}},unitSupported:false};
  const value=await adapter.resolve(entity);
  if(!Array.isArray(value.lines)||value.lines.length>32||new Set(value.lines.map(l=>l.key)).size!==value.lines.length||value.lines.some(l=>typeof l.key!=='string'||!l.key||l.key.length>120||typeof l.label!=='string'||l.groupCode!==null&&l.groupCode!==undefined&&(typeof l.groupCode!=='string'||l.groupCode.length>80))||!['resolved','excluded','ambiguous','unknown'].includes(value.state)||typeof value.complete!=='boolean')throw apiError(503,'invalid_adapter_resolution');
  const resolution=await this.catalog.lines(entity.id,value);
  return {address:this.catalog.public(entity),operator:{id:op.id,label:op.label,supportState:op.state,synthetic:op.is_test},resolution,unitSupported:op.config.unitSupported===true&&typeof adapter.selectUnit==='function'};
 }
 async resolve(body){this.checkVersion(body);const e=await this.catalog.entity(body.addressId);if(e.kind!=='address')throw apiError(400,'not_an_address');
  const result=await this.resolveEntity(e);let selected=null;
  if(body.unit!==undefined){if(!result.unitSupported||typeof body.unit!=='string'||!body.unit.trim()||body.unit.length>32||/[\u0000-\u001f]/.test(body.unit))throw apiError(400,'unit_not_supported');
   selected=await adapterFor(await this.catalog.operator(e.operator_id),this).selectUnit(e,result.resolution,body.unit.trim());
   if(!selected)throw apiError(409,'unit_not_resolved','Не вдалося визначити лінію за квартирою');
  }
  if(body.lineId){if(!result.resolution.lines.some(l=>l.id===body.lineId))throw apiError(409,'line_changed','Лінія недоступна. Перевірте адресу ще раз');selected=body.lineId;}
  if(!selected&&result.resolution.complete&&result.resolution.lines.length===1)selected=result.resolution.lines[0].id;
  return {schemaVersion:1,...result,selection:{lineId:selected,mode:body.unit?'upstream_unit':body.lineId?'user_selected':selected?'single_line':'required'}};
 }
 async snapshot(addressId,range){
  const entity=await this.catalog.entity(addressId);if(entity.kind!=='address')throw apiError(400,'not_an_address');
  const operator=await this.catalog.operator(entity.operator_id),adapter=operator&&adapterFor(operator,this);
  const scope=['universal-snapshot-v1',entity.operator_id,entity.id,range.fromDate,range.toDate];
  const key=createHmac('sha256',this.secret).update(JSON.stringify(scope)).digest('hex');
  const old=async()=>{const r=(await this.bridge.query('select value from public.svitlo_source_cache where key=$1',[key])).rows[0]?.value;return validUniversal(r)&&r.addressId===entity.id?r:null;};
  if(!adapter||operator.state==='disabled')return degraded(entity,range,await old(),!adapter?'adapter_unsupported':'operator_disabled',Date.now(),!adapter?'unsupported':'disabled');
  const cache=this.regions?.handles(entity.operator_id)?this.regions.snapshotCache:this.shared;
  return cache.load(scope,async()=>{
   const previous=await old();try{
    let resolution=(await this.resolveEntity(entity)).resolution;
    const result=await adapter.snapshot(entity,resolution,range,previous);
    if(result.legacy){const l=result.legacy,excluded=l.queueResolution?.inclusion==='not_in_queue';
     if(l.queue||excluded){resolution=await this.catalog.lines(entity.id,{state:excluded?'excluded':'resolved',complete:true,checkedAt:Date.now(),lines:[{key:'main',label:excluded?'Основна лінія · не включена до ГПВ':'Основна лінія',groupCode:l.queue||null,provenance:l.queueResolution}],provenance:l.queueResolution});}
     result.value=retainPartial(normalizeLegacy(entity,l,resolution,range),previous,l.failures||[]);
    }
    if(!validUniversal(result.value)||result.value.addressId!==entity.id||result.value.operatorId!==entity.operator_id)throw Error('invalid_adapter_snapshot');
    return result.value;
   }catch(e){return degraded(entity,range,previous,['forbidden','rate_limited','timeout','synthetic_unavailable'].includes(e.code)?e.code:'source_unavailable');}
  });
 }
 async batch(body){this.checkVersion(body);const range=this.range(body);
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>10||body.items.some(x=>!x||typeof x.addressId!=='string'||x.revision!==undefined&&(typeof x.revision!=='string'||x.revision.length>128)))throw apiError(400,'invalid_batch');
  const results=new Array(body.items.length);let next=0;
  await Promise.all(Array.from({length:2},async()=>{while(next<body.items.length){const index=next++,item=body.items[index];try{
   const value=await this.snapshot(item.addressId,range);
   results[index]=value.revision===item.revision&&value.freshUntil>Date.now()&&value.supportState==='available'?{addressId:item.addressId,status:'unchanged',revision:value.revision,refreshAfter:value.refreshAfter}:{addressId:item.addressId,status:'snapshot',snapshot:value};
  }catch(e){results[index]={addressId:item.addressId,status:'error',error:{code:e.code||'temporarily_unavailable',retryable:!e.status||e.status>=500}};}}}));
  return {schemaVersion:1,coverage:range,results};
 }
}
