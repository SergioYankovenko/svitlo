import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {RequestIds,diagnosticPacket,validateRequest,routeTag} from './validation.js';import {SecuritySink,Telemetry} from './service.js';
const sample=()=>({schemaVersion:1,reportId:randomUUID(),client:{target:'pwa',version:'1.2.3-qa'},occurredAt:'2026-11-03T12:30:10.000Z',stage:'street',code:'temporary',events:[{name:'lookup_failed',code:'temporary'}]});
const packet=(p,options={})=>diagnosticPacket(p,{consent:p.reportId,...options});
test('diagnostic schema accepts minimal/max events and canonicalizes UUID',()=>{const p=sample();p.reportId=p.reportId.toUpperCase();p.events=Array.from({length:8},()=>p.events[0]);assert.equal(packet(p).reportId,p.reportId.toLowerCase());});
test('diagnostics reject extra/secret fields including prototype names at every level',()=>{
 for(const name of ['address','account','url','stacktrace','cookie','authorization','installationId','gps','__proto__','constructor']){
  const p=sample();Object.defineProperty(p,name,{value:'DO_NOT_STORE',enumerable:true});assert.throws(()=>packet(p),e=>e.status===400);
 }
 for(const change of [p=>p.client.secret='TOKEN',p=>p.events[0].payload='SQL;\r\nSECRET',p=>p.events.push(...Array(8).fill(p.events[0])),p=>p.client.target='admin',p=>p.httpStatus=99,p=>p.stage=null,p=>p.events[0].code=null]){const p=sample();change(p);assert.throws(()=>packet(p),e=>e.status===400);}
});
test('consent is per exact report and cannot be inferred from a session',()=>{const p=sample();for(const consent of [undefined,'',randomUUID()])assert.throws(()=>packet(p,{consent}),e=>e.status===403);});
test('diagnostic date format rejects normalized invalid calendar dates and control input',()=>{
 for(const date of ['2026-02-30T12:00:00Z','2026-11-03T24:00:00Z','2026-11-03','not-a-date']){const p=sample();p.occurredAt=date;assert.throws(()=>packet(p));}
 const p=sample();p.client.version='1.2\r\nSECRET';assert.throws(()=>packet(p));
});
test('only server-issued, fresh and correctly scoped request IDs are accepted',()=>{
 let now=1793700000000;const ids=new RequestIds('test-only-secret',{now:()=>now}),own=ids.issue('A'),pub=ids.issue();
 assert.equal(ids.verify(own.token,'A'),own.id);assert.equal(ids.verify(own.token,'B'),null);assert.equal(ids.verify(pub.token,'B'),pub.id);
 for(const token of [randomUUID(),'Authorization_Token_12345678',own.token.slice(0,-1)+'!'])assert.equal(ids.verify(token,'A'),null);
 const p=sample();p.correlationId=own.token;assert.equal(packet(p,{requestIds:ids,owner:'A'}).correlationId,own.id);assert.throws(()=>packet(p,{requestIds:ids,owner:'B'}));
 now+=86401000;assert.equal(ids.verify(own.token,'A'),null);
});
test('public and protected validation reject unknown operations/fields/control but allow Unicode and SQL words as data',()=>{
 validateRequest('/api/v1/search',{kind:'cities',q:"Лук’янівка ' SELECT; DROP -- Київ"});
 for(const [route,p] of [['/api/v1/search',{kind:'cities',q:'fine',rpc:'DROP'}],['/api',{action:'execute_sql',sql:'select 1'}],['/api',{action:{toString:'unsafe'}}],['/api',{action:'save',address:null}],['/api',{action:'preferences',preferences:null}],['/api',{action:'preferences',id:randomUUID(),preferences:{role:'admin'}}],['/api/v1/search',{kind:'cities',q:'a\r\nb'}],['/api/session',{owner:randomUUID()}]])assert.throws(()=>validateRequest(route,p),e=>e.status===400);
 assert.equal(routeTag('/api/DO_NOT_LOG_SECRET'),'unknown_api');
 assert.throws(()=>validateRequest('/api',{action:'sync',subscription:{endpoint:'https://fcm.googleapis.com/qa',keys:{auth:{toString:null},p256dh:'qa'}}}),e=>e.status===400);
});
test('security queue strips raw fields, remains bounded and never leaks sink errors',async()=>{
 const stored=[];let release;const blocked=new Promise(r=>release=r);const sink=new SecuritySink(async p=>{await blocked;stored.push(p);},{limit:2});
 const event={operation:'catalog_lookup',field:'request',reason:'schema',confidence:'schema_violation',raw:'TOKEN',ip:'PRIVATE',owner:'PRIVATE'};
 assert.equal(sink.emit(event),true);assert.equal(sink.emit(event),true);assert.equal(sink.emit(event),false);release();await sink.flush();assert.equal(stored.length,2);assert.ok(stored.every(p=>!('raw'in p)&&!('ip'in p)&&!('owner'in p)));
 const failed=new SecuritySink(()=>{throw Error('DO_NOT_LOG_SECRET');});failed.emit(event);await failed.flush();assert.equal(failed.failed,1);
});
test('empty/success/upstream failures do not create input-security events',async()=>{
 const t=new Telemetry({query:async()=>{throw Error('unexpected write');}},'secret');let count=0;t.sink.emit=()=>count++;
 for(const status of [200,201,404,409,500,503])t.reject({path:'/api/v1/search',status});assert.equal(count,0);
 for(const status of [403,429])t.reject({path:'/api/v1/search',status,reason:'upstream'});assert.equal(count,0);
 t.reject({path:'/api/v1/search',status:400});assert.equal(count,1);
});
test('storage failures do not return a successful diagnostic receipt',async()=>{
 const t=new Telemetry({query:async()=>{throw Error('database_unavailable');}},'secret'),p=sample();await assert.rejects(()=>t.submit('owner',p,p.reportId));
});
