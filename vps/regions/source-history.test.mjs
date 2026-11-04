import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {SourceHistory,HISTORY_TARGETS,historyPayload,compareHistory,historyTransitions} from './source-history.js';
const now=Date.parse('2026-11-04T10:45:00Z');
const fixtures=Object.fromEntries(await Promise.all(['kyiv','brovary','yasno-applies-23.1'].map(async name=>[name,JSON.parse(await readFile(new URL('./fixtures/'+name+'.json',import.meta.url),'utf8'))])));
const sample=(index,at=now)=>({source:HISTORY_TARGETS[index].source,state:'ok',checkedAt:at,payload:historyPayload(HISTORY_TARGETS[index],fixtures[index===0?'kyiv':index===1?'brovary':'yasno-applies-23.1'],at)});
test('history retains source clocks/protocol but excludes retrieval clocks, unrelated houses and account fields',()=>{
 const raw=structuredClone(fixtures.kyiv);raw.account='PRIVATE_ACCOUNT';raw.data['36'].account='PRIVATE_ACCOUNT';raw.preset.private='PRIVATE_ACCOUNT';
 const a=historyPayload(HISTORY_TARGETS[0],raw,now),b=historyPayload(HISTORY_TARGETS[0],raw,now+10000);
 assert.deepEqual(a,b);assert.equal(a.parsed.fact.update,raw.fact.update);assert.ok(!JSON.stringify(a).includes('PRIVATE_ACCOUNT'));assert.ok(!Object.hasOwn(a.parsed,'houses'));
 const y=sample(2).payload;assert.equal(y.protocol['23.1'].today.slots.length,fixtures['yasno-applies-23.1']['23.1'].today.slots.length);assert.equal(y.parsed.groupUpdatedAt['GPV23.1'],Date.parse(fixtures['yasno-applies-23.1']['23.1'].updatedOn));
});
test('same group/day intervals agree, while a one-minute change is an explicit conflict',()=>{
 const rows=[sample(0),sample(2)];let result=compareHistory(rows,now).find(x=>x.group==='GPV23.1'&&x.date==='2026-11-04');assert.equal(result.classification,'agreement');assert.equal(result.evidence.powerState,'unknown');
 rows[1].payload.parsed.daySchedules['GPV23.1']['2026-11-04'].intervals[0].end-=60000;
 result=compareHistory(rows,now).find(x=>x.group==='GPV23.1'&&x.date==='2026-11-04');assert.equal(result.classification,'conflict');assert.equal(result.evidence.intervalComparison,'different');
});
test('large capture skew and a missing source never count as agreement',()=>{
 const rows=[sample(0),sample(2,now+31000)];assert.ok(compareHistory(rows,now+31000).every(x=>x.classification==='unconfirmed'));assert.deepEqual(compareHistory([sample(0),{source:'yasno-kyiv',state:'error'}],now),[]);
});
test('emergency remains a mode transition and retains the published plan, never actual power',()=>{
 const rows=[sample(0),sample(2)];const s=rows[1].payload.parsed;s.groups['GPV23.1']['2026-11-04']='EmergencyShutdowns';s.groupUpdatedAt['GPV23.1']=now-1000;
 const result=compareHistory(rows,now).find(x=>x.group==='GPV23.1'&&x.date==='2026-11-04');assert.equal(result.classification,'emergency_override');assert.ok(result.evidence.publishedIntervals.length);assert.equal(result.evidence.powerState,'unknown');
});
test('a failed or missing polling window does not resolve a conflict or claim its exact end',()=>{
 const rows=[{slot:300000,finishedAt:310000,comparison:{classification:'conflict'}},{slot:600000,finishedAt:610000,comparison:null},{slot:1200000,finishedAt:1210000,comparison:{classification:'agreement'}}];
 const r=historyTransitions(rows);assert.deepEqual(r.transitions,[{from:'conflict',to:'agreement',afterObservedAt:310000,beforeObservedAt:1210000,gapObservations:2,exactChangeTime:null}]);assert.equal(r.samplingGaps[0].missingWindows,1);
 assert.equal(historyTransitions(rows.slice(0,2)).transitions.length,0);
});
test('three independent legs persist when YASNO refuses; existing gates and HTTP outcomes remain visible',async()=>{
 let saved,active=0,max=0;const finished=[];
 const bridge={query:async(sql,args)=>{if(sql.includes('claim()'))return {rows:[{value:{granted:true,slot:now,token:'test'}}]};if(sql.includes('finish(')){saved=JSON.parse(args[2]);return {rows:[{value:{state:'saved'}}]};}return {rows:[]};}};
 const regions={gate:async op=>op,finish:async(...args)=>finished.push(args)};
 const fetcher=async(url,options)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;
  if(url.includes('yasno'))return new Response('',{status:403});
  if(!options.headers['x-csrf-token']){const name=url.includes('krem')?'_csrf-dtek-krem':'_csrf-dtek-kem';return new Response('',{status:400,headers:{'set-cookie':name+'='+encodeURIComponent('i:1;s:32:"0123456789abcdef0123456789abcdef";')}});}
  return Response.json(fixtures[url.includes('krem')?'brovary':'kyiv']);};
 const h=new SourceHistory({bridge,regions,enabled:true,now:()=>now,fetcher});await h.runDue();
 assert.ok(max>=2);assert.equal(saved.length,3);assert.equal(saved.filter(x=>x.state==='ok').length,2);assert.equal(saved.find(x=>x.source==='yasno-kyiv').httpStatus,403);assert.ok(finished.some(x=>x[0]==='yasno-kyiv'&&x[2].error==='forbidden'));
});
test('disabled/not-due collectors do not make network requests, and timeouts retain attempted count without secret errors',async()=>{
 const h=new SourceHistory({bridge:{query:async()=>({rows:[{value:{granted:false}}]})},regions:{gate:async()=>'',finish:async()=>{}},fetcher:async()=>{throw Error('PRIVATE_SECRET');}});
 assert.equal((await h.runDue()).state,'disabled');h.enabled=true;assert.equal((await h.runDue()).state,'not_due');
 const row=await h.capture(HISTORY_TARGETS[2]);assert.equal(row.state,'error');assert.equal(row.requestCount,1);assert.ok(!JSON.stringify(row).includes('PRIVATE_SECRET'));
});
