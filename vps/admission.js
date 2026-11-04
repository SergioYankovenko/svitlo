import {createHmac,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {problem} from './telemetry/validation.js';
export const proxyProof=secret=>createHmac('sha256',secret).update('edge-client-v1').digest('hex');
export function clientKey(req,secret){
 const proof=req.headers['x-svitlo-proxy-proof'],ip=req.headers['x-svitlo-client-ip'],expected=proxyProof(secret);
 const trusted=typeof proof==='string'&&/^[a-f0-9]{64}$/.test(proof)&&timingSafeEqual(Buffer.from(proof),Buffer.from(expected))&&typeof ip==='string'&&isIP(ip);
 return createHmac('sha256',secret).update('client:'+ (trusted?ip:req.socket.remoteAddress||'unknown')).digest('hex');
}
export class Admission {
 constructor({now=()=>Date.now(),rate=32,burst=64,concurrency=32,maxKeys=10000}={}){Object.assign(this,{now,rate,burst,concurrency,maxKeys});this.tokens=burst;this.at=now();this.active=0;this.quotas=new Map();}
 acquire(){const t=this.now();this.tokens=Math.min(this.burst,this.tokens+Math.max(0,t-this.at)*this.rate/1000);this.at=t;
  if(this.tokens<1||this.active>=this.concurrency)throw Object.assign(problem(429,'http_busy','rate'),{retryAfter:1});
  this.tokens--;this.active++;let released=false;return()=>{if(!released){released=true;this.active--;}};
 }
 budget(key,limit){const t=this.now(),v=this.quotas.get(key);if(v?.until>t)return ++v.count<=limit;
  if(this.quotas.size>=this.maxKeys)for(const [k,x] of this.quotas)if(x.until<=t)this.quotas.delete(k);
  if(!this.quotas.has(key)&&this.quotas.size>=this.maxKeys)return false;
  this.quotas.set(key,{count:1,until:t+3600000});return true;
 }
}
