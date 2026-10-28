import {appStorage,safeStorage} from './storage.js';
export class DictionaryCache {
  constructor(request,storage=appStorage,now=()=>Date.now()) {Object.assign(this,{request,now});this.storage=safeStorage(storage);this.pending=new Map();}
  async load(body,force=false) {
    const key='svitlo-dict-v1:'+JSON.stringify([body.kind,body.parent||'']);
    let old;try{old=JSON.parse(this.storage.getItem(key));}catch{}
    if(!force&&old&&Number.isFinite(old.at)&&Array.isArray(old.items)&&old.items.every(x=>x&&typeof x.id==='string'&&typeof x.name==='string')&&this.now()>=old.at&&this.now()-old.at<86400000)return {items:old.items};
    if(this.pending.has(key))return this.pending.get(key);
    const job=this.request('dictionary',body).then(r=>{
      if(!Array.isArray(r.items))throw Error('Не вдалося завантажити довідник');
      if(r.items.length)try{this.storage.setItem(key,JSON.stringify({at:this.now(),items:r.items}));}catch{}
      return r;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,job);return job;
  }
}
