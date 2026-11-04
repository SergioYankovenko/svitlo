import test from 'node:test';import assert from 'node:assert/strict';
import {vpsClient,SESSION_CHECK_KEY} from '../app/lib/vps-auth.js';
import {SessionController} from '../app/lib/session.js';
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const session=(id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',t=1000000)=>({user:{id},csrf_token:'a'.repeat(64),access_token:'a'.repeat(64),expires_at:Math.floor(t/1000)+86400});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(options={}){let time=1000000,calls=0;const storage=memory(),s=session();storage.setItem('svitlo-auth',JSON.stringify(s));
 const client=vpsClient({storage,now:()=>time,locks:null,fetcher:async()=>{calls++;return Response.json({session:s});},...options});
 return {client,storage,s,calls:()=>calls,time:v=>time=v};}
test('one verified read covers duplicate identity checks; receipt expires within five minutes without extending credentials',async()=>{
 const x=setup();for(let i=0;i<20;i++)assert.equal((await x.client.auth.getSession()).data.session.user.id,x.s.user.id);assert.equal(x.calls(),1);
 x.time(1300001);await x.client.auth.getSession();assert.equal(x.calls(),2);assert.equal(JSON.parse(x.storage.getItem('svitlo-auth')).expires_at,x.s.expires_at);
});
test('concurrent reads coalesce per tab and across tabs with a shared lock and freshness receipt',async()=>{
 const storage=memory(),s=session(),gate=deferred();let calls=0,tail=Promise.resolve();storage.setItem('svitlo-auth',JSON.stringify(s));
 const locks={request:(_key,_opts,fn)=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;}};
 const options={storage,locks,now:()=>1000000,fetcher:async()=>{calls++;await gate.promise;return Response.json({session:s});}};
 const a=vpsClient(options),b=vpsClient(options),jobs=[a.auth.getSession(),a.auth.getSession(),b.auth.getSession()];await new Promise(r=>setImmediate(r));assert.equal(calls,1);gate.resolve();await Promise.all(jobs);assert.equal(calls,1);
});
test('a different tab clearing identity fences a late successful session response',async()=>{
 const gate=deferred(),x=setup({fetcher:async()=>{await gate.promise;return Response.json({session:session()});}});
 const pending=x.client.auth.getSession();await new Promise(r=>setImmediate(r));x.storage.removeItem('svitlo-auth');gate.resolve();await assert.rejects(()=>pending,/змінився/);assert.equal(x.storage.getItem('svitlo-auth'),null);
});
test('401/403 invalidation forces a fresh cookie check and definitive null clears the metadata',async()=>{
 let revoked=false,calls=0;const x=setup({fetcher:async()=>{calls++;return Response.json({session:revoked?null:session()});}});
 await x.client.auth.getSession();revoked=true;await x.client.auth.getSession();assert.equal(calls,1);
 x.client.auth.invalidateSession();assert.equal((await x.client.auth.getSession()).data.session,null);assert.equal(calls,2);assert.equal(x.storage.getItem(SESSION_CHECK_KEY),null);
});
test('429 and 503 retain known metadata without renewing a freshness receipt or creating a new anonymous owner',async()=>{
 for(const status of [429,503]){
  let calls=0,post=0;const storage=memory(),s=session();storage.setItem('svitlo-auth',JSON.stringify(s));
  const client=vpsClient({storage,locks:null,now:()=>1000000,fetcher:async(_url,o)=>{calls++;if(o.method==='POST')post++;return new Response('',{status,headers:{'Retry-After':'20'}});}});
  const c=new SessionController({client:()=>client,storage});assert.equal((await c.ensure()).user.id,s.user.id);assert.equal((await c.ensure()).user.id,s.user.id);assert.equal(calls,1);assert.equal(post,0);assert.equal(storage.getItem(SESSION_CHECK_KEY),null);
 }
});
test('an expired identity never turns a transient server error into an anonymous registration',async()=>{
 let posts=0;const storage=memory();storage.setItem('svitlo-auth',JSON.stringify(session(undefined,-90000000)));
 const client=vpsClient({storage,locks:null,now:()=>1000000,fetcher:async(_u,o)=>{if(o.method==='POST')posts++;return new Response('',{status:429});}});
 await assert.rejects(()=>new SessionController({client:()=>client,storage}).ensure());assert.equal(posts,0);
});
test('future receipts, changed owners and changed CSRF metadata cannot suppress revalidation',async()=>{
 const x=setup();await x.client.auth.getSession();const receipt=JSON.parse(x.storage.getItem(SESSION_CHECK_KEY));receipt.at=9000000;x.storage.setItem(SESSION_CHECK_KEY,JSON.stringify(receipt));await x.client.auth.getSession();assert.equal(x.calls(),2);
 const other=session('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');x.storage.setItem('svitlo-auth',JSON.stringify(other));await x.client.auth.getSession();assert.equal(x.calls(),3);
});
test('sign-out rechecks the cookie, clears metadata and receipt, and emits a signed-out event',async()=>{
 const methods=[],storage=memory(),s=session(),events=[];storage.setItem('svitlo-auth',JSON.stringify(s));
 const c=vpsClient({storage,locks:null,now:()=>1000000,fetcher:async(_u,o)=>{methods.push(o.method);return Response.json(o.method==='DELETE'?{ok:true}:{session:s});}});
 c.auth.onAuthStateChange(event=>events.push(event));await c.auth.getSession();await c.auth.signOut();await Promise.resolve();assert.deepEqual(methods,['GET','GET','DELETE']);assert.equal(storage.getItem('svitlo-auth'),null);assert.equal(storage.getItem(SESSION_CHECK_KEY),null);assert.deepEqual(events,['SIGNED_OUT']);
});
test('invalid successful responses retain cached display metadata but never mark it fresh',async()=>{
 const x=setup({fetcher:async()=>Response.json({session:{user:{id:'forged'}}})});await assert.rejects(()=>x.client.auth.getSession(),/Некоректна/);assert.equal(JSON.parse(x.storage.getItem('svitlo-auth')).user.id,x.s.user.id);assert.equal(x.storage.getItem(SESSION_CHECK_KEY),null);
});
test('invalidation prevents an in-flight response from installing old state',async()=>{
 const gate=deferred(),x=setup({fetcher:async()=>{await gate.promise;return Response.json({session:session()});}}),pending=x.client.auth.getSession();await new Promise(r=>setImmediate(r));x.client.auth.invalidateSession();gate.resolve();await assert.rejects(()=>pending,/змінився/);assert.equal(x.storage.getItem(SESSION_CHECK_KEY),null);
});
