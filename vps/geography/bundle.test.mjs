import test from 'node:test';import assert from 'node:assert/strict';
import {loadBundle} from './bundle.mjs';import {normalizeName} from './service.mjs';
const {manifest,data}=await loadBundle(),nodes=new Map(data.nodes.map(n=>[n.code,n])),routes=new Map(data.routes.map(r=>[r.id,r]));
test('official national edition is complete and every hierarchy reference resolves',()=>{
 assert.equal(manifest.nodeCount,31744);assert.equal(manifest.settlementCount,29703);assert.equal(nodes.size,data.nodes.length);
 for(const n of data.nodes){assert.ok(n.name&&n.searchName);for(const k of ['parentCode','regionCode','districtCode','communityCode','settlementCode'])if(n[k])assert.ok(nodes.has(n[k]),k);if(n.parentCode)assert.ok(nodes.get(n.parentCode).level<n.level);}
 assert.equal(data.nodes.filter(n=>n.level===1).length,27);assert.ok(nodes.has('UA01000000000013043'));assert.equal(nodes.get('UA85000000000065278').name,'Севастополь');
});
test('city and village Khrystynivka remain distinct and reviewed branch aliases target only the city',()=>{
 const city='UA71060230010046648',village='UA71060230260024910';assert.equal(nodes.get(city).category,'M');assert.equal(nodes.get(village).category,'C');assert.equal(nodes.get(city).parentCode,nodes.get(village).parentCode);
 for(const id of ['ua-cherkasy:18:801','ua-cherkasy:3:100'])assert.deepEqual(data.links.filter(l=>l.routeId===id).map(l=>[l.settlementCode,l.matchState]),[[city,'reviewed']]);
 assert.equal(data.links.find(l=>l.routeId==='ua-cherkasy:18:818').settlementCode,village);
});
test('Kyiv special city and Kyiv province never inherit each other provider mappings',()=>{
 const kyiv='UA80000000000093317',province='UA32000000000030281';assert.equal(nodes.get(kyiv).category,'K');assert.equal(nodes.get(province).category,'O');
 for(const l of data.links){const r=routes.get(l.routeId),n=nodes.get(l.settlementCode);assert.equal(n.regionCode,r.regionCode);if(r.operatorId==='ua-kyiv-dtek')assert.equal(n.code,kyiv);if(r.operatorId==='ua-kyiv-region-dtek')assert.equal(n.regionCode,province);}
});
test('duplicate settlement names retain all explicitly provisional candidates',()=>{
 const ambiguous=data.links.filter(l=>l.candidateCount>1);assert.ok(ambiguous.length>0);
 for(const l of ambiguous){assert.equal(l.matchState,'candidate');assert.equal(l.matchMethod,'ambiguous_name_type_region');assert.equal(data.links.filter(x=>x.routeId===l.routeId).length,l.candidateCount);}
});
test('source catalogue entries are never represented as electrical coverage or invented queues',()=>{
 assert.equal(new Set(data.routes.map(r=>r.id)).size,data.routes.length);assert.equal(new Set(data.routes.filter(r=>r.operatorId==='ua-cherkasy').map(r=>r.branchId)).size,22);
 for(const r of data.routes){assert.equal(r.evidence.addressCheckRequired,true);assert.equal(r.evidence.physicalNetworkCoverageConfirmed,false);assert.ok(Number.isFinite(Date.parse(r.sourceObservedAt)));assert.ok(!/[\[\]*]/u.test(r.providerCityName));assert.ok(!Object.hasOwn(r,'queue'));}
});
test('Ukrainian apostrophes, case and compatibility spaces normalize without replacing identities',()=>{
 assert.equal(normalizeName('  ЛУК’ЯНІВКА\u00a0'),"лук'янівка");assert.equal(normalizeName('Лукʼянівка'),"лук'янівка");assert.equal(normalizeName('Іванівка'),'іванівка');
 assert.notEqual(nodes.get('UA71060230010046648').code,nodes.get('UA71060230260024910').code);
});
