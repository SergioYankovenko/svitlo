import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLegacy} from '../vps/universal/normalize.js';
import {retainPublishedDays} from '../app/lib/universal-history.js';
import {civil} from '../app/lib/time.js';
function snapshot(date){const now=civil(date,600);return normalizeLegacy({id:'a',operator_id:'ua-cherkasy'},{queue:'3.2',checkedAt:now,feedCheckedAt:now,failures:[],feedFailed:false,categories:{hourly:{events:[],checkedAt:now,sourceAt:now},planned:{events:[],checkedAt:now,sourceAt:now},emergency:{events:[],checkedAt:now,sourceAt:now}},plans:[{date,queue:'3.2',events:[],publishedAt:now}],emergencies:[]},{state:'resolved',complete:true,lines:[{id:'line',label:'Main',groupCode:'3.2'}],provenance:{}},{fromDate:date,toDate:date},now);}
test('midnight retains original published past date without renewing freshness',()=>{
 const old=snapshot('2026-11-05'),next=snapshot('2026-11-06'),result=retainPublishedDays(next,old,'2026-11-06');
 assert.equal(result.coverage.fromDate,'2026-11-05');assert.equal(result.checkedAt,next.checkedAt);
 assert.deepEqual(result.lines[0].categories.hourly.days[0],old.lines[0].categories.hourly.days[0]);
 assert.equal(next.lines[0].categories.hourly.days.length,1);
});
test('history does not cross address, line, group or future dates',()=>{
 const old=snapshot('2026-11-05'),next=snapshot('2026-11-06');
 for(const mutate of [s=>s.addressId='b',s=>s.lines[0].id='another',s=>s.lines[0].groupCode='4.2']){const copy=structuredClone(old);mutate(copy);assert.equal(retainPublishedDays(next,copy,'2026-11-06'),next);}
 assert.equal(retainPublishedDays(old,next,'2026-11-05'),old);
});
test('unknown past placeholder can be replaced by archived publication, current data cannot',()=>{
 const old=snapshot('2026-11-05'),next=snapshot('2026-11-06');next.coverage.fromDate='2026-11-05';
 const category=next.lines[0].categories.hourly;category.days.unshift({...structuredClone(old.lines[0].categories.hourly.days[0]),state:'unknown',publication:{state:'not_published'}});
 assert.equal(retainPublishedDays(next,old,'2026-11-06').lines[0].categories.hourly.days[0].state,'published');
});
test('new week keeps yesterday even when the provider sends fourteen future dates',()=>{
 const old=snapshot('2026-11-05'),next=snapshot('2026-11-06');
 for(const category of Object.values(next.lines[0].categories)){
  const template=category.days[0];category.days=Array.from({length:14},(_,i)=>({...structuredClone(template),date:'2026-11-'+String(6+i).padStart(2,'0')}));
 }
 next.coverage.toDate='2026-11-19';const result=retainPublishedDays(next,old,'2026-11-06');
 assert.equal(result.lines[0].categories.hourly.days.length,14);assert.equal(result.lines[0].categories.hourly.days[0].date,'2026-11-05');
});
