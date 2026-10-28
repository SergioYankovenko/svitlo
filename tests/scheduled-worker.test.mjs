import test from 'node:test';
import assert from 'node:assert/strict';
import {runScaledJobs} from '../server/scaled-jobs.js';
import {runLoggedJob} from '../server/operations.js';
import {Service} from '../server/service.js';
import {MemoryDatabase} from '../server/memory.js';
const now=Date.parse('2026-10-27T20:00:00Z');
function worker(feed=true){
 const calls=[],db={scheduledMaintenance:true,jobsClaim:async()=>({granted:true,token:'j'}),jobsWork:async()=>({feed}),
 jobsFinish:async()=>calls.push('finish'),due:async()=>[],reminderClaim:async()=>[],deliveryBatch:async()=>[],
 cleanup:async()=>{throw Error('Edge cleanup must not run');},opsCleanup:async()=>{throw Error('Edge ops cleanup must not run');},
 feed:async()=>({plans:[],checkedAt:now-3600000}),saveFeed:async()=>calls.push('save'),
 startJob:async()=> 'run',finishJob:async(_id,status,summary)=>calls.push({status,summary})};
 const service={db,now:()=>now,jobBudgetMs:45000,source:{feed:async(_t,_old,options)=>{
  calls.push({force:options.force});return {plans:[],emergencies:[],checkedAt:now};}}};
 return{db,service,calls};
}
test('feed-only due work refreshes once without profile claims or Edge cleanup, then journals success',async()=>{
 const{db,service,calls}=worker();
 const result=await runLoggedJob(db,'jobs',()=>runScaledJobs(service),()=>now);
 assert.equal(result.feedChecks,1);assert.equal(result.refreshed,0);
 assert.deepEqual(calls,[{force:true},'save','finish',{status:'succeeded',summary:{refreshed:0,sent:0,failedRefreshes:0,partialRefreshes:0,failedDeliveries:0,expiredSubscriptions:0,skippedRefreshes:0,remindersChecked:0,budgetExhausted:false,feedChecks:1}}]);
});
test('feed failure is journaled partial and always releases the global lease; fresh feed is not polled',async()=>{
 const s=worker();s.service.source.feed=async()=>{throw Error('source unavailable');};
 const result=await runLoggedJob(s.db,'jobs',()=>runScaledJobs(s.service),()=>now);
 assert.equal(result.failedFeeds,1);assert.equal(s.calls.at(-1).status,'partial');assert.ok(s.calls.includes('finish'));
 const fresh=worker(false);await runScaledJobs(fresh.service);assert.deepEqual(fresh.calls,['finish']);
});
test('profile workers await the same feed result before completing and release after all work',async()=>{
 const s=worker(),claims=[{id:'p1'},{id:'p2'}];let release;
 s.service.source.feed=()=>new Promise(r=>release=r);
 s.db.due=async()=>claims.length?[claims.shift()]:[];
 s.service.refresh=async(p,_prepared,{feedResult})=>{const shared=await feedResult;assert.equal(shared.value.checkedAt,now);s.calls.push(p.id);return{snapshot:{}};};
 const pending=runScaledJobs(s.service);await new Promise(r=>setImmediate(r));assert.ok(!s.calls.includes('finish'));
 release({plans:[],checkedAt:now});const result=await pending;
 assert.equal(result.refreshed,2);assert.equal(s.calls.filter(x=>x==='save').length,1);assert.equal(s.calls.at(-1),'finish');
});
test('legacy resolve_queue uses one atomic lookup and skips provider/PDF payload for a catalog hit',async()=>{
 const db=new MemoryDatabase();let lookups=0;
 db.addressResolutionData=async()=>{lookups++;return{record:{status:'not_in_queue',batch:{import_key:'test',reviewed_at:'2026-10-27'},evidence:{}},registry:null};};
 db.registry=async()=>{throw Error('full PDF must not be read');};
 const svc=new Service({db,source:{resolve:async()=>{throw Error('provider must not be called');}},now:()=>now});
 const r=await svc.handle('owner',{action:'resolve_queue',address:{department:'18',cityId:'801',streetId:'12068',house:'15'}});
 assert.equal(r.resolution.inclusion,'not_in_queue');assert.equal(lookups,1);
});
