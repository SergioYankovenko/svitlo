import {dayKey} from './time.js';
export const SYNC_KEY='svitlo-sync-v1', HOUR=3600000;
export const cityKey=a=>JSON.stringify([a.department,a.cityId,a.city]);
export function legacyEnvelope(owner,profiles,weather,now=Date.now()) {
  const owned=(Array.isArray(profiles)?profiles:[]).filter(p=>p.owner===owner&&p.address&&p.snapshot);
  if(!owned.length)return null;
  const cities={};
  for(const p of owned)if(weather?.[p.id]?.city===p.address.city)cities[cityKey(p.address)]=weather[p.id];
  return {owner,profiles:owned,weather:cities,at:0,day:dayKey(now),vapid:'',pushReady:false,invalidations:{}};
}
export function dataUntil(p, now) {
  const s=p?.snapshot, stamps=[s?.checkedAt,s?.feedCheckedAt,
    ...['hourly','planned','emergency'].flatMap(k=>[s?.categories?.[k]?.checkedAt,s?.categories?.[k]?.sourceAt])];
  if(!s || s.failures?.length || s.feedFailed || stamps.some(t=>!Number.isFinite(t)||t>now+300000))return 0;
  return Math.min(...stamps)+HOUR;
}
export class SyncClient {
  constructor({request,owner,storage=localStorage,now=()=>Date.now(),locks=globalThis.navigator?.locks,invalidation=async()=>null}) {
    Object.assign(this,{request,owner,storage,now,locks,invalidation});this.pending=null;this.generation=0;
  }
  read(owner) {try {const v=JSON.parse(this.storage.getItem(SYNC_KEY));return v?.owner===owner&&Array.isArray(v.profiles)?v:null;}catch{return null;}}
  clear() {this.generation++;this.storage.setItem('svitlo-cache-epoch',globalThis.crypto.randomUUID());this.storage.removeItem(SYNC_KEY);}
  write(value) {this.storage.setItem(SYNC_KEY,JSON.stringify(value));}
  async needed(value,id,reason,subscription) {
    if(!value || value.day!==dayKey(this.now()) || ['manual','rollover'].includes(reason))return true;
    const p=id ? value.profiles.find(p=>p.id===id) : value.profiles[0];
    if(id&&!p)return true;
    if(value.retryAt>this.now()) {
      const marker=p?await this.invalidation(p.id):null;
      if(!marker || marker===value.retryInvalidations?.[p.id])return false;
    }
    if((value.errors?.profile || value.errors?.subscription) && (id||p?.id)===value.active && this.now()-(value.at||0)<300000)return false;
    if(subscription && (value.subscription!==JSON.stringify([id||value.profiles[0]?.id,subscription,value.vapid]) || this.now()-(value.subscriptionAt||0)>86400000))return true;
    if(p) {
      const marker=await this.invalidation(p.id);
      if(marker && marker!==value.invalidations?.[p.id])return true;
      const weather=value.weather?.[cityKey(p.address)];
      // Failed/partial responses retry after five minutes without re-stamping source data.
      const due=dataUntil(p,this.now());
      if(!due || due<=this.now() || !weather || this.now()-weather.checkedAt>=HOUR)
        return this.now()-(value.at||0)>=300000;
    }
    return this.now()-(value.at||0)>=HOUR;
  }
  async sync({id,reason='auto',subscription=null}={}) {
    if(this.pending) {await this.pending;return this.sync({id,reason:reason==='manual'?'auto':reason,subscription});}
    const task=this.run({id,reason,subscription,generation:this.generation,epoch:this.storage.getItem('svitlo-cache-epoch')});this.pending=task;
    try{return await task;}finally{if(this.pending===task)this.pending=null;}
  }
  async run(args) {
    const owner=await this.owner();if(!owner)throw Error('Потрібне підключення');
    const load=async()=>{
      if(args.generation!==this.generation || args.epoch!==this.storage.getItem('svitlo-cache-epoch'))return null;
      const cached=this.read(owner);
      if(!await this.needed(cached,args.id,args.reason,args.subscription))return args.epoch===this.storage.getItem('svitlo-cache-epoch') ? cached : null;
      const generation=args.generation, markers={...(cached?.invalidations||{})};
      for(const p of cached?.profiles||[])markers[p.id]=await this.invalidation(p.id);
      if(args.id)markers[args.id]=await this.invalidation(args.id);
      const fingerprint=JSON.stringify([args.id||cached?.profiles[0]?.id,args.subscription,cached?.vapid]);
      const send=args.subscription && (cached?.subscription!==fingerprint || this.now()-(cached.subscriptionAt||0)>86400000);
      let r;
      try {r=await this.request('sync',{id:args.id,reason:args.reason,...(send?{subscription:args.subscription}:{})});}
      catch(error) {
        if(generation===this.generation && args.epoch===this.storage.getItem('svitlo-cache-epoch') && owner===await this.owner()) {
          this.write({...cached,owner,profiles:cached?.profiles||[],day:dayKey(this.now()),at:cached?.at||0,
            retryAt:this.now()+300000,retryInvalidations:markers});
        }
        throw error;
      }
      if(generation!==this.generation || args.epoch!==this.storage.getItem('svitlo-cache-epoch') || owner!==await this.owner())return null;
      const weather={...(cached?.weather||{})};if(r.weather&&r.weatherKey)weather[r.weatherKey]=r.weather;
      const value={owner,at:this.now(),day:dayKey(this.now()),profiles:r.profiles,active:r.active||args.id||r.profiles[0]?.id,weather,vapid:r.vapid,pushReady:r.pushReady,
        errors:r.errors||{},invalidations:markers,subscription:cached?.subscription,subscriptionAt:cached?.subscriptionAt};
      if(r.subscription) {value.subscription=JSON.stringify([r.active||args.id,args.subscription,r.vapid]);value.subscriptionAt=this.now();}
      this.write(value);return value;
    };
    if(this.locks)return this.locks.request('svitlo-sync:'+owner,load);
    return this.lease(owner,load);
  }
  async lease(owner,load) {
    const key='svitlo-sync-lease:'+owner,token=globalThis.crypto.randomUUID();
    for(let i=0;i<650;i++) {
      let current;try{current=JSON.parse(this.storage.getItem(key));}catch{}
      if(!current || current.until<this.now()) {
        this.storage.setItem(key,JSON.stringify({token,until:this.now()+125000}));
        await new Promise(r=>setTimeout(r,20));
        if(JSON.parse(this.storage.getItem(key)||'{}').token===token) {
          try{return await load();}finally{if(JSON.parse(this.storage.getItem(key)||'{}').token===token)this.storage.removeItem(key);}
        }
      }
      await new Promise(r=>setTimeout(r,200));
    }
    throw Error('Синхронізація вже триває. Спробуйте пізніше.');
  }
}
