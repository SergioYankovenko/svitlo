import test from 'node:test';import assert from 'node:assert/strict';import {acceptance} from './gates.js';
test('unit tests and same-host restore cannot close physical, store, full-volume or offsite acceptance',()=>{const r=acceptance({android:{unitTests:687},recovery:{restoredFromActualPrivateBaseline:true,independentHost:false,externalRepository:false,afterTargetAbsent:true},load:{requestedSeconds:3600,seconds:3600,offeredAverageRequestsPerSecond:20,readP95ms:9,ackLoss:0,unexpected5xx:0,full90DayFleetVolumeSeeded:false},search:{measurement:'engine-only',p95ms:13,requestsPerSecond:20,exactCases:200,exactCorrect:200,indexBytes:1,peakMemoryBytes:1}});assert.equal(r.readyForPaidLaunch,false);for(const g of ['androidReader','offsitePitr','mixedSlo','searchSlo','storeLifecycle'])assert.equal(r.gates[g],false);assert.equal(r.publicRolloutAuthorized,false);});
test('all independently sourced gates must pass and missing evidence stays pending',()=>{const r=acceptance({});assert.equal(r.pending.length,Object.keys(r.gates).length);assert.equal(r.readyForPaidLaunch,false);});

test('correct latency and completeness evidence cannot close gates for a different image',()=>{
 const image='sha256:'+'a'.repeat(64),other='sha256:'+'b'.repeat(64);
 const r=acceptance({release:{image},search:{image:other,measurement:'full-http-api',requestsPerSecond:20,p95ms:90,exactCases:200,exactCorrect:200,indexBytes:1,peakMemoryBytes:1},soak:{image:other,observedSeconds:86400,unexpectedErrors:0}});
 assert.equal(r.gates.searchSlo,false);assert.equal(r.gates.soak24h,false);
 assert.equal(acceptance({release:{image},soak:{image,observedSeconds:86400,unexpectedErrors:0}}).gates.soak24h,true);
});

test('test-only search overlay cannot attest to the deployed image',()=>{
 const image='sha256:'+'a'.repeat(64);
 const search={image,status:'pass',measurement:'full-http-api',requestsPerSecond:20,observedRequestsPerSecond:20,p95ms:71,exactCases:200,exactCorrect:200,indexBytes:50_000_000,peakMemoryBytes:160_000_000};
 assert.equal(acceptance({release:{image},search}).gates.searchSlo,true);
 assert.equal(acceptance({release:{image},search:{...search,candidateOverlay:true}}).gates.searchSlo,false);
});
