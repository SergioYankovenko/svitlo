import { SourceError } from './source-errors.js';
// Service-only HMAC keys prevent account enumeration even in a cache-key dump.
// Values contain parsed events/queue and original source timestamps, never raw provider rows.
export class SharedCategories {
  constructor(db, secret, {now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),ttl=600000,boundFreshUntil=false}={}) {
    Object.assign(this,{db,now,sleep,ttl,boundFreshUntil});
    this.key=crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    this.pending=new Map();
  }
  async load(scope,loader,signal) {
    const key=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',await this.key,new TextEncoder().encode(JSON.stringify(scope)))),x=>x.toString(16).padStart(2,'0')).join('');
    if(this.pending.has(key)) return structuredClone(await this.pending.get(key));
    const promise=this.run(key,loader,signal);this.pending.set(key,promise);
    try{return structuredClone(await promise);}finally{this.pending.delete(key);}
  }
  async run(key,loader,signal) {
    const end=this.now()+22000;
    while(true) {
      signal?.throwIfAborted();
      const c=await this.db.sourceClaim(key,this.now());
      if(c.state==='fresh')return c.value;
      if(c.state==='owner') {
        try {
          const value=await loader();
          const finishedAt=this.now(),remaining=value?.freshUntil-finishedAt;
          // A fresh region snapshot may reuse an older street/status fetch. Its
          // cache must expire no later than that underlying evidence. Retained
          // degraded evidence still uses the normal bounded retry cache.
          const ttl=this.boundFreshUntil&&Number.isFinite(remaining)&&remaining>0?Math.min(this.ttl,remaining):this.ttl;
          await this.db.sourceFinish(key,c.token,value,finishedAt,ttl).catch(()=>{});
          return value;
        } catch(error) {
          await this.db.sourceFinish(key,c.token,null,this.now(),0).catch(()=>{});throw error;
        }
      }
      if(this.now()>=end)throw new SourceError('timeout');
      await this.sleep(200);
    }
  }
}
