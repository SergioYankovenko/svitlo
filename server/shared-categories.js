import { SourceError } from './source-errors.js';
// Service-only HMAC keys prevent account enumeration even in a cache-key dump.
// Values contain parsed events/queue and original source timestamps, never raw provider rows.
export class SharedCategories {
  constructor(db, secret, {now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),ttl=600000}={}) {
    Object.assign(this,{db,now,sleep,ttl});
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
          await this.db.sourceFinish(key,c.token,value,this.now(),this.ttl).catch(()=>{});
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
