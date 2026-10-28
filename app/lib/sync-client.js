import {dayKey} from './time.js';
import {appStorage,safeStorage} from './storage.js';
import {envelopeData,validProfile,normalizeProfile,validWeather} from './cache-data.js';
export const SYNC_KEY='svitlo-sync-v1',HOUR=3600000;
export const cityKey=a=>JSON.stringify([a.department,a.cityId,a.city]);
const token=()=>globalThis.crypto.randomUUID();
export function legacyEnvelope(owner,profiles,weather,now=Date.now()) {
  const owned=(Array.isArray(profiles)?profiles:[]).filter(p=>validProfile(p,owner)).map(normalizeProfile);
  if(!owned.length)return null;
  const cities={};
  for(const p of owned){const w=weather?.[cityKey(p.address)]||weather?.[p.id];if(validWeather(w,now)&&w.city===p.address.city)cities[cityKey(p.address)]=w;}
  return {version:1,owner,profiles:owned,weather:cities,at:0,day:dayKey(now),vapid:'',pushReady:false,invalidations:{}};
}
export function dataUntil(p,now) {
  const s=p?.snapshot,stamps=[s?.checkedAt,s?.feedCheckedAt,...['hourly','planned','emergency'].flatMap(k=>[s?.categories?.[k]?.checkedAt,s?.categories?.[k]?.sourceAt])];
  if(!s||s.failures?.length||s.feedFailed||stamps.some(t=>!Number.isFinite(t)||t<0||t>now+300000))return 0;
  return Math.min(...stamps)+HOUR;
}
export class SyncClient {
  constructor({request,owner,storage=appStorage,now=()=>Date.now(),locks=globalThis.navigator?.locks,invalidation=async()=>null}) {
    Object.assign(this,{request,owner,now,locks,invalidation});this.storage=safeStorage(storage);this.pending=null;this.generation=0;
  }
  read(owner){try{return envelopeData(JSON.parse(this.storage.getItem(SYNC_KEY)),owner,this.now());}catch{return null;}}
  stamp(){return {generation:this.generation,epoch:this.storage.getItem('svitlo-cache-epoch')};}
  current(stamp){return stamp.generation===this.generation&&stamp.epoch===this.storage.getItem('svitlo-cache-epoch');}
  async owned(stamp,owner){const actual=await this.owner();return this.current(stamp)&&actual===owner;}
  invalidate(){this.generation++;this.storage.setItem('svitlo-cache-epoch',token());}
  external(key){this.storage.external(key);if(key==='svitlo-cache-epoch')this.generation++;}
  clear(){this.invalidate();this.storage.removeItem(SYNC_KEY);}
  write(value){const clean=envelopeData(value,value.owner,this.now());if(!clean)return null;this.storage.setItem(SYNC_KEY,JSON.stringify(clean));return clean;}
  patch(owner,update){
    const previous=this.read(owner)||{owner,profiles:[],weather:{},at:0,day:dayKey(this.now()),invalidations:{}};
    this.invalidate();return this.write({...update(previous),owner,revision:token()});
  }
  async needed(value,id,reason,subscription) {
    if(!value||value.day!==dayKey(this.now())||['manual','rollover'].includes(reason))return true;
    const p=id?value.profiles.find(p=>p.id===id):value.profiles[0];if(id&&!p)return true;
    if(value.retryAt>this.now()&&value.retryAt<=this.now()+300000){const marker=p?await this.invalidation(p.id):null;if(!marker||marker===value.retryInvalidations?.[p.id])return false;}
    const age=this.now()-(value.at||0);if(age<0)return true;
    if((value.errors?.profile||value.errors?.subscription)&&(id||p?.id)===value.active&&age<300000)return false;
    if(subscription&&(value.subscription!==JSON.stringify([id||p?.id,subscription,value.vapid])||this.now()-(value.subscriptionAt||0)>86400000))return true;
    if(p){
      const marker=await this.invalidation(p.id);if(marker&&marker!==value.invalidations?.[p.id])return true;
      const weather=value.weather?.[cityKey(p.address)],due=dataUntil(p,this.now());
      if(!due||due<=this.now()||!weather||weather.checkedAt>this.now()+300000||this.now()-weather.checkedAt>=HOUR)return age>=300000;
    }
    return age>=HOUR;
  }
  async sync({id,reason='auto',subscription=null}={}) {
    const stamp=this.stamp();
    while(this.pending){try{await this.pending;}catch{}if(!this.current(stamp))return null;}
    const task=this.run({id,reason,subscription,...stamp});this.pending=task;
    try{return await task;}finally{if(this.pending===task)this.pending=null;}
  }
  async run(args) {
    const owner=await this.owner();if(!this.current(args))return null;if(!owner)throw Error('Не вдалося відновити підключення. Спробуйте ще раз.');
    const load=async()=>{
      if(!this.current(args))return null;
      const cached=this.read(owner),needed=await this.needed(cached,args.id,args.reason,args.subscription);
      if(!needed)return await this.owned(args,owner)?cached:null;
      const markers={...(cached?.invalidations||{})};
      for(const p of cached?.profiles||[])markers[p.id]=await this.invalidation(p.id);
      if(args.id)markers[args.id]=await this.invalidation(args.id);
      if(!this.current(args))return null;
      const fingerprint=JSON.stringify([args.id||cached?.profiles[0]?.id,args.subscription,cached?.vapid]);
      const send=args.subscription&&(cached?.subscription!==fingerprint||this.now()-(cached.subscriptionAt||0)>86400000);
      try {
        const r=await this.request('sync',{id:args.id,reason:args.reason,...(send?{subscription:args.subscription}:{})});
        if(!await this.owned(args,owner))return null;
        const weather={...(cached?.weather||{})};if(r.weather&&r.weatherKey&&validWeather(r.weather,this.now()))weather[r.weatherKey]=r.weather;
        const value=envelopeData({version:1,owner,at:this.now(),day:dayKey(this.now()),profiles:r.profiles,
          active:r.active||args.id||r.profiles?.[0]?.id,weather,vapid:r.vapid,pushReady:r.pushReady,errors:r.errors||{},
          invalidations:markers,subscription:cached?.subscription,subscriptionAt:cached?.subscriptionAt,revision:token()},owner,this.now());
        if(!value)throw Error('Не вдалося прочитати отримані дані. Спробуйте ще раз.');
        if(r.subscription){value.subscription=JSON.stringify([r.active||args.id,args.subscription,r.vapid]);value.subscriptionAt=this.now();}
        // No await between this fence, persistence and return.
        if(!this.current(args))return null;
        this.write(value);return value;
      }catch(error){
        if(!await this.owned(args,owner))return null;
        if(cached)this.write({...cached,owner,day:dayKey(this.now()),at:cached.at||0,retryAt:this.now()+300000,retryInvalidations:markers});
        throw error;
      }
    };
    if(this.locks){let entered=false;try{return await this.locks.request('svitlo-sync:'+owner,()=>{entered=true;return load();});}catch(e){if(entered)throw e;}}
    return this.lease(owner,load,args);
  }
  async lease(owner,load,stamp) {
    const key='svitlo-sync-lease:'+owner,id=token();
    if(!this.storage.persistent)return this.current(stamp)?load():null;
    for(let i=0;i<650;i++){
      if(!this.current(stamp))return null;
      let current;try{current=JSON.parse(this.storage.getItem(key));}catch{}
      if(!current||!Number.isFinite(current.until)||current.until<this.now()||current.until>this.now()+125000){
        if(!this.storage.setItem(key,JSON.stringify({token:id,until:this.now()+125000})))return load();
        await new Promise(r=>setTimeout(r,20));
        let held;try{held=JSON.parse(this.storage.getItem(key)||'{}');}catch{}
        if(held?.token===id){try{return this.current(stamp)?await load():null;}finally{try{if(JSON.parse(this.storage.getItem(key)||'{}').token===id)this.storage.removeItem(key);}catch{}}}
      }
      await new Promise(r=>setTimeout(r,200));
    }
    throw Error('Синхронізація вже триває. Спробуйте пізніше.');
  }
}
