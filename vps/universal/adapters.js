import {rows} from '../../app/lib/parsers.js';
import {civil} from '../../app/lib/time.js';
import {CATEGORIES,universalEnvelope} from '../../app/lib/universal-contract.js';
import {normalizeLegacy,seal,dates} from './normalize.js';
import {DtekAdapter} from '../regions/service.js';
import {AlertsEnergyAdapter} from '../sources/alerts-energy.js';
import {AdapterRegistry} from './adapter-registry.js';
export class CherkasyAdapter {
 constructor({legacy,source}){Object.assign(this,{legacy,source});}
 async resolve(entity){const r=await this.legacy.queueResolution(entity.source_ref,Date.now());
  const excluded=r?.inclusion==='not_in_queue';return {state:r?.queue?'resolved':excluded?'excluded':'unknown',complete:!!r?.queue||excluded,checkedAt:Date.now(),
   lines:r?.queue||excluded?[{key:'main',label:excluded?'Основна лінія · не включена до ГПВ':'Основна лінія',groupCode:r?.queue||null,provenance:r}]:[],provenance:r||{}};
 }
 async snapshot(entity,resolution,range,previous){
  const signal=AbortSignal.timeout(20000),a=entity.source_ref,key=this.source.key(a),cached=this.source.accounts.get(key);
  if(!cached||cached.until<Date.now())try{
   const accounts=rows(await this.source.request({op:'ls_list_by_addr',street_id:a.streetId,house:a.house},signal));
   const ids=[...new Set(accounts.map(x=>String(x.LS)))];
   if(ids.length===1&&/^\d{11}$/.test(ids[0]))this.source.accounts.set(key,{account:ids[0],until:Date.now()+900000});
  }catch{/* Exact catalog address remains usable; never choose among multiple personal accounts. */}
  const prior=previous?universalEnvelope(previous,resolution.lines.find(l=>l.key==='main')?.id):{};
  const allocation=resolution.provenance;
  const groupSchedule=!!this.source.groupPlans&&resolution.state==='resolved'&&resolution.complete&&allocation?.source==='official_registry'&&
   allocation.estimated!==true&&!allocation.needsReview&&/^[1-6]\.[12]$/.test(allocation.queue||'');
  const {snapshot}=await this.legacy.prepareSnapshot({address:a,snapshot:prior,messages:[]},null,{signal,groupSchedule});
  return {legacy:snapshot,value:normalizeLegacy(entity,snapshot,resolution,range)};
 }
}
// Only explicitly marked staging test operators can instantiate these adapters.
export class QaAdapter {
 constructor({variant='grid'}={}){this.variant=variant;}
 async selectUnit(entity,resolution,unit){if(!/^\d{1,4}$/.test(unit))return null;return resolution.lines.find(l=>l.key===(Number(unit)%2?'north':'south'))?.id||null;}
 async resolve(entity){const scenario=entity.source_ref.scenario;
  const lines=scenario==='1'?[{key:'north',label:'Лінія А (тест)',groupCode:'7.2/A'},{key:'south',label:'Лінія Б (тест)',groupCode:'B-12'}]:scenario==='3'?[]:[{key:'direct',label:'Тестова лінія',groupCode:scenario==='2'?null:'QA.9'}];
  return {state:scenario==='1'?'ambiguous':scenario==='3'?'unknown':'resolved',complete:scenario!=='3',checkedAt:Date.now(),lines,provenance:{synthetic:true,adapter:this.variant}};
 }
 async snapshot(entity,resolution,range){const now=Date.now(),scenario=entity.source_ref.scenario;
  if(scenario==='6')throw Object.assign(Error('synthetic source failure'),{code:'synthetic_unavailable'});
  return {value:seal({schemaVersion:1,addressId:entity.id,operatorId:entity.operator_id,timeZone:'Europe/Kyiv',coverage:range,
   resolution:{state:resolution.state,complete:resolution.complete},lines:resolution.lines.map((l,index)=>({id:l.id,label:l.label,groupCode:l.groupCode,supportedCategories:CATEGORIES,
    categories:Object.fromEntries(CATEGORIES.map(k=>[k,{checkedAt:now,sourceUpdatedAt:now,freshUntil:now+300000,days:dates(range.fromDate,range.toDate).map(date=>({date,state:scenario==='4'?'not_published':scenario==='5'?'unknown':'published',
     intervals:k==='hourly'&&scenario!=='4'&&scenario!=='5'?[{start:civil(date,index?1200:600),end:civil(date,index?1260:660)}]:[]}))}]))})),
   notices:[],checkedAt:now,sourceUpdatedAt:now,freshUntil:now+300000,refreshAfter:now+60000,supportState:'available',provenance:[{synthetic:true,adapter:this.variant}],synthetic:true})};
 }
}
export function createAdapterRegistry(){return new AdapterRegistry()
 .register({key:'alerts-energy-v1',supports:(op,ctx)=>ctx.alertsEnergy?.configured===true,create:ctx=>new AlertsEnergyAdapter(ctx.alertsEnergy)})
 .register({key:'dtek-public-v1',supports:(op,ctx)=>!!ctx.regions?.handles(op.id),create:ctx=>new DtekAdapter(ctx.regions)})
 .register({key:'cherkasy-v1',operatorIds:['ua-cherkasy'],create:ctx=>new CherkasyAdapter(ctx)})
 .register({key:'qa-grid-v1',testOnly:true,create:()=>new QaAdapter()})
 .register({key:'qa-alt-v1',testOnly:true,create:()=>new QaAdapter({variant:'alternative-wire'})});}
const defaults=createAdapterRegistry();
export function adapterFor(operator,context){return (context.adapterRegistry||defaults).for(operator,context);}
