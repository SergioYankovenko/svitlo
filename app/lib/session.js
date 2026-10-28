import {appStorage} from './storage.js';
export class RetryingLoader {
  constructor({load,now=()=>Date.now(),cooldown=1500,max=3,timeout=12000}){Object.assign(this,{load,now,cooldown,max,timeout});this.attempt=0;this.promise=null;this.retryAt=0;}
  get(){
    if(this.promise)return this.promise;
    if(this.attempt>=this.max||this.now()<this.retryAt)return Promise.reject(Error('Не вдалося завантажити застосунок. Спробуйте ще раз.'));
    const attempt=this.attempt++,controller=new AbortController();
    this.promise=bounded(Promise.resolve().then(()=>this.load(attempt,controller.signal)),this.timeout).catch(()=>{
      controller.abort();
      this.promise=null;this.retryAt=this.now()+this.cooldown;
      throw Error('Не вдалося завантажити застосунок. Перевірте підключення та спробуйте ще раз.');
    });
    return this.promise;
  }
}
const lost=error=>['refresh_token_not_found','refresh_token_already_used','session_not_found','user_not_found'].includes(error?.code)||error?.name==='AuthSessionMissingError';
export const recoveryError=()=>Object.assign(Error('Не вдалося відновити підключення. Спробуйте ще раз.'),{recovery:true});
export function bounded(promise,ms=12000) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(recoveryError()),ms);})]).finally(()=>clearTimeout(timer));
}
export class SessionController {
  constructor({client,storage=appStorage,timeout=12000}){
    Object.assign(this,{client,storage,timeout});this.owner=null;this.session=null;this.version=0;
    this.listeners=new Set();this.blocked=new Set();this.pending=null;this.signing=null;this.attached=new WeakSet();
  }
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  accept(session,event='SESSION') {
    if(session&&(!session.user?.id||!session.access_token))return;
    if(session&&this.blocked.has(session.user.id)){
      // A late callback from the erased owner must not erase a newer session.
      if(this.session)this.storage.setItem('svitlo-auth',JSON.stringify(this.session));else this.storage.removeItem('svitlo-auth');
      return;
    }
    const owner=session?.user.id||null,changed=owner!==this.owner;
    this.session=session;this.owner=owner;if(changed)this.version++;
    for(const fn of this.listeners)queueMicrotask(()=>fn({owner,event,changed}));
  }
  async instance(){
    const c=await this.client();
    if(!this.attached.has(c)){
      this.attached.add(c);
      c.auth.onAuthStateChange?.((event,session)=>{
        // Never await another auth method inside the SDK callback/lock.
        if(event==='SIGNED_OUT')this.forget();else this.accept(session,event);
      });
    }
    return c;
  }
  async read(){
    if(this.pending)return this.pending;
    const version=this.version;
    const job=(async()=>{
      const c=await this.instance();
      const result=await bounded(c.auth.getSession(),this.timeout);
      if(version!==this.version)return this.session;
      if(result.error){
        if(lost(result.error)){this.forget();return null;}
        throw recoveryError();
      }
      const session=result.data?.session||null;
      if(session&&this.blocked.has(session.user?.id))return this.session;
      this.accept(session);return session;
    })();
    this.pending=job;
    try{return await job;}finally{if(this.pending===job)this.pending=null;}
  }
  async identity(){return (await this.read())?.user.id||null;}
  async ensure(){
    const existing=await this.read();if(existing)return existing;
    if(this.signing)return this.signing;
    const version=this.version;
    const job=(async()=>{
      const c=await this.instance();
      if(version!==this.version)throw recoveryError();
      const result=await bounded(c.auth.signInAnonymously(),this.timeout);
      if(result.error||!result.data?.session)throw recoveryError();
      const session=result.data.session;
      if(this.blocked.has(session.user?.id)||version!==this.version&&this.owner!==session.user?.id)throw recoveryError();
      this.accept(session,'SIGNED_IN');return session;
    })();
    this.signing=job;try{return await job;}finally{if(this.signing===job)this.signing=null;}
  }
  forget(){
    if(this.owner)this.blocked.add(this.owner);
    this.owner=null;this.session=null;this.version++;this.pending=null;this.storage.removeItem('svitlo-auth');
    for(const fn of this.listeners)queueMicrotask(()=>fn({owner:null,event:'SIGNED_OUT',changed:true}));
  }
}
