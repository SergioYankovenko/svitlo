// Persistence is optional. Failed writes stay authoritative in this tab's memory.
export class SafeStorage {
  constructor(provider=()=>globalThis.localStorage) {
    this.provider=typeof provider==='function'?provider:()=>provider;
    this.memory=new Map();this.persistent=true;this.listeners=new Set();
  }
  failed() {
    if(!this.persistent)return;
    this.persistent=false;
    for(const listener of this.listeners)queueMicrotask(listener);
  }
  getItem(key) {
    if(this.memory.has(key))return this.memory.get(key);
    try{return this.provider()?.getItem(key)??null;}catch{this.failed();return null;}
  }
  setItem(key,value) {
    value=String(value);
    try{const raw=this.provider();if(!raw)throw Error('storage unavailable');raw.setItem(key,value);this.memory.delete(key);return true;}
    catch{this.memory.set(key,value);this.failed();return false;}
  }
  removeItem(key) {
    // A tombstone prevents a failed removal from resurrecting an older disk value.
    this.memory.set(key,null);
    try{const raw=this.provider();if(!raw)throw Error('storage unavailable');raw.removeItem(key);return true;}
    catch{this.failed();return false;}
  }
  external(key) {this.memory.delete(key);}
  subscribe(listener) {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
}
export const appStorage=new SafeStorage();
export const safeStorage=value=>value instanceof SafeStorage?value:new SafeStorage(value);
export function readJSON(key,fallback,storage=appStorage) {
  try{return JSON.parse(storage.getItem(key))??fallback;}catch{return fallback;}
}
