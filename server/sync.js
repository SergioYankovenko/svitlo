import { SharedCategories } from './shared-categories.js';
// Exact provider city IDs and type-bearing name prevent city/village collisions.
export const cityKey = a => JSON.stringify([a.department,a.cityId,a.city]);
export class SyncService {
  constructor(service) { this.service=service; this.pending=new Map(); this.weather=new Map(); this.weatherPending=new Map(); }
  async weatherFor(address) {
    const {db,source,now}=this.service, key=cityKey(address), old=this.weather.get(key);
    if(old && now()-old.checkedAt<3600000) return old;
    if(this.weatherPending.has(key))return this.weatherPending.get(key);
    if(!this.shared && db.sourceClaim) this.shared=new SharedCategories(db,'svitlo-public-weather-v1',{now,ttl:3600000});
    const load=()=>source.weather(address.city);
    const pending=(this.shared ? this.shared.load(['weather-v1',key],load) : load()).then(value=>{this.weather.set(key,value);return value;}).finally(()=>this.weatherPending.delete(key));
    this.weatherPending.set(key,pending);return pending;
  }
  run(owner, body, list) {
    // Only identical requests coalesce; a changed subscription cannot disappear.
    const key=JSON.stringify([owner,body]);
    if(this.pending.has(key))return this.pending.get(key);
    const task=this.load(owner,body,list).finally(()=>this.pending.delete(key));
    this.pending.set(key,task);return task;
  }
  async load(owner,body,list) {
    const s=this.service, now=s.now(), profiles=await list();
    let active=body.id ? profiles.find(p=>p.id===body.id) : profiles[0];
    if(body.id && !active) { const e=Error('Адресу не знайдено');e.status=404;throw e; }
    const errors={};
    if(active) {
      const interval=body.reason==='manual'||body.reason==='push'||body.reason==='rollover' ? 60000 : 3600000;
      if(!active.last_checked || now-active.last_checked>=interval || (body.reason!=='manual' && now>=active.next_check && now-active.last_checked>=60000)) {
        try { active=await s.refresh(active); }
        catch(e) { if(e.status===404)throw e; errors.profile='Оновлення тимчасово недоступне'; }
      }
    }
    let weather=null, subscription=null;
    await Promise.all([
      active ? this.weatherFor(active.address).then(w=>weather=w).catch(()=>errors.weather='Погода поки недоступна') : null,
      body.subscription ? (async()=>{
        if(!s.vapid || !s.validSubscription(body.subscription)) {errors.subscription='Некоректна підписка';return;}
        try {await s.db.subscribe(owner,body.subscription,active?.id||null);subscription=true;}
        catch {errors.subscription='Не вдалося зберегти підписку';}
      })() : null,
    ]);
    // Re-read after refresh: deleted profiles and concurrent preference writes win.
    const current=await list();
    if(active && !current.some(p=>p.id===active.id)) {const e=Error('Адресу не знайдено');e.status=404;throw e;}
    return {profiles:current.map(s.publicProfile),active:active?.id||null,vapid:s.vapid,pushReady:!!s.vapid,
      weather,weatherKey:active ? cityKey(active.address):null,subscription,errors,serverTime:now};
  }
}
