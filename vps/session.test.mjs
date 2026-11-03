import test from 'node:test';
import assert from 'node:assert/strict';
import {vpsClient} from '../app/lib/vps-auth.js';
import {Sessions} from './session.js';
const value={user:{id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'},csrf_token:'a'.repeat(64),access_token:'a'.repeat(64),expires_at:2000};
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
test('metadata is persisted for offline cached schedules; cookie remains the only server credential',async()=>{
 const s=storage(),client=vpsClient({storage:s,now:()=>1000000,fetcher:async()=>Response.json({session:value})});
 await client.auth.getSession();assert.equal(JSON.parse(s.getItem('svitlo-auth')).user.id,value.user.id);
 const offline=vpsClient({storage:s,now:()=>1000000,fetcher:async()=>{throw Error('offline');}});
 assert.equal((await offline.auth.getSession()).data.session.user.id,value.user.id);
 await assert.rejects(()=>offline.auth.signInAnonymously(),/offline/);
 await assert.rejects(()=>offline.auth.signOut(),/offline/);
});
test('revoked server session clears cached metadata; expired metadata is not an identity',async()=>{
 const s=storage();s.setItem('svitlo-auth',JSON.stringify(value));
 const revoked=vpsClient({storage:s,now:()=>1000000,fetcher:async()=>Response.json({session:null})});
 assert.equal((await revoked.auth.getSession()).data.session,null);assert.equal(s.getItem('svitlo-auth'),null);
 s.setItem('svitlo-auth',JSON.stringify(value));
 const expired=vpsClient({storage:s,now:()=>3000000,fetcher:async()=>{throw Error('offline');}});
 await assert.rejects(()=>expired.auth.getSession(),/offline/);
});
test('CSRF is bound to opaque cookie, not the client-selected owner',()=>{
 const sessions=new Sessions(null,'separate-server-secret');const csrf=sessions.csrf('a'.repeat(64));
 assert.ok(sessions.validCsrf({headers:{'x-svitlo-csrf':csrf}},{csrf}));
 assert.equal(sessions.validCsrf({headers:{'x-svitlo-csrf':sessions.csrf('b'.repeat(64))}},{csrf}),false);
 assert.equal(sessions.validCsrf({headers:{'x-svitlo-csrf':'é'.repeat(64)}},{csrf}),false);
});
