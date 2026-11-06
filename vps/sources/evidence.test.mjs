import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {SourceEvidence,observedPublicFetch,publicSource,sourceRegistry} from './evidence.js';
test('public source observation preserves body and cookies without persisting URLs, source rows or private accounts',async()=>{
 const records=[],headers=new Headers({'content-type':'application/json'});headers.append('set-cookie','first=one; HttpOnly');headers.append('set-cookie','second=two; HttpOnly');
 const raw='{"public":"valid"}',fetcher=observedPublicFetch(async()=>new Response(raw,{headers}),r=>records.push(r));
 const response=await fetcher('https://www.dtek-kem.com.ua/ua/ajax');assert.equal(await response.text(),raw);
 assert.equal(response.headers.getSetCookie().length,2);assert.equal(records.length,1);assert.equal(records[0].contentHash,createHash('sha256').update(raw).digest('hex'));
 assert.ok(!JSON.stringify(records).includes('HttpOnly'));assert.ok(!JSON.stringify(records).includes('https://'));
 assert.equal(publicSource('https://cabinet.cherkasyoblenergo.com/api_new/disconn.php?op=ls_list_by_addr'),null);
 assert.equal(publicSource('https://cabinet.cherkasyoblenergo.com/api_new/disconn.php?op=disconn_by_ls&abon_ls=private'),null);
 assert.equal(publicSource('https://other.example/private'),null);assert.equal(sourceRegistry.ministryOperators,27);
});
test('cancelled or malformed wire data cannot become validated source evidence; observer failure preserves source response',async()=>{
 const records=[],fetcher=observedPublicFetch(async()=>new Response('{broken'),r=>records.push(r));
 await assert.rejects(()=>(async()=>JSON.parse(await(await fetcher('https://www.dtek-kem.com.ua/ua/ajax')).text()))());
 assert.equal(records[0].outcome,'observed');assert.ok(!records.some(r=>r.outcome==='accepted'));
 const response=await observedPublicFetch(async()=>new Response('x'.repeat(100)),r=>records.push(r))('https://www.dtek-kem.com.ua/ua/ajax');await response.body.cancel();
 assert.equal(records.at(-1).outcome,'partial');assert.equal(records.at(-1).contentHash,null);
 assert.equal(await(await observedPublicFetch(async()=>new Response('still-readable'),()=>{throw Error('log unavailable');})('https://www.dtek-kem.com.ua/ua/ajax')).text(),'still-readable');
});
test('normalization evidence keeps the original successful observation time and treats degraded snapshots separately',async()=>{
 const writes=[],evidence=new SourceEvidence({query:async(sql,args)=>writes.push(JSON.parse(args[0]))},{now:()=>10000});
 const value={operatorId:'ua-kyiv-dtek',coverage:{fromDate:'2026-11-07',toDate:'2026-11-07'},resolution:{complete:true,state:'resolved'},lines:[],supportState:'available',freshUntil:20000,checkedAt:9000,sourceUpdatedAt:5000};
 await evidence.accepted(value,'dtek-public-v1');assert.equal(writes[0].checkedAt,5000);assert.equal(writes[0].outcome,'accepted');
 await evidence.accepted({...value,supportState:'degraded'},'dtek-public-v1');assert.equal(writes[1].outcome,'partial');
 assert.equal(writes[1].contentHash,writes[0].contentHash);
});
