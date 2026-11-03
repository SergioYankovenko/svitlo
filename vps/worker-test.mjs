import assert from 'node:assert/strict';
import {runtime} from './runtime.js';
const rt=await runtime('worker');
try{
 const claims=await Promise.all([rt.db.jobsClaim(),rt.db.jobsClaim()]);
 assert.equal(claims.filter(c=>c.granted).length,1);const claim=claims.find(c=>c.granted);
 try{
  const result=await rt.service.jobs();assert.equal(result.status,'busy');assert.equal(result.sent,0);
 }finally{await rt.db.jobsFinish(claim.token,null);}
 await assert.rejects(()=>rt.service.push({},{}),/STAGING_DELIVERY_DISABLED/);
 // Only the named browser QA profile is made due, never a production/customer row.
 const r=await rt.p.query("update public.svitlo_profiles set last_checked=0,next_check=1,lease_until=0 where name='Тест VPS' returning id");
 assert.equal(r.rowCount,1);
 const result=await rt.service.jobs();assert.equal(result.refreshed,1);assert.equal(result.failedRefreshes,0);assert.equal(result.sent,0);
 const profile=(await rt.p.query('select last_checked,snapshot,address from public.svitlo_profiles where id=$1',[r.rows[0].id])).rows[0];
 assert.ok(profile.last_checked>Date.now()-120000);assert.equal(profile.address.account,undefined);assert.equal(profile.snapshot.queue,'3.2');
 console.log(JSON.stringify({scope:'real-worker-vps',singleLease:true,backgroundRefreshed:result.refreshed,queue:profile.snapshot.queue,partial:result.partialRefreshes,externalPushSent:result.sent}));
}finally{await rt.p.end();}
