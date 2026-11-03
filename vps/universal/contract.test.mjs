import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeLegacy,degraded,seal,retainPartial} from './normalize.js';
import {validUniversal,universalEnvelope,universalDay,CATEGORIES} from '../../app/lib/universal-contract.js';
import {civil} from '../../app/lib/time.js';
import {dayState,countdown} from '../../app/lib/schedule.js';
const vectors=JSON.parse(await readFile(new URL('./golden-vectors.json',import.meta.url),'utf8'));
function frozen(date='2026-11-03'){
 const now=civil(date,720),events=[{category:'hourly',start:civil(date,960),end:civil(date,1080)}];
 const legacy={queue:'3.2',categories:Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{events:k==='hourly'?events:[],checkedAt:now,sourceAt:now}])),
  checkedAt:now,feedCheckedAt:now,failures:[],feedFailed:false,plans:[{date,queue:'3.2',events,publishedAt:now-1000}],emergencies:[]};
 const resolution={state:'resolved',complete:true,lines:[{id:'line-a',label:'Main',groupCode:'3.2'}],provenance:{source:'frozen-vector'}};
 const value=normalizeLegacy({id:'address-a',operator_id:'ua-cherkasy'},legacy,resolution,{fromDate:date,toDate:date},now);
 return {now,legacy,value};
}
test('formal contract and frozen vectors exist before transport deployment',async()=>{const schema=JSON.parse(await readFile(new URL('./snapshot.schema.json',import.meta.url),'utf8'));assert.equal(schema.properties.schemaVersion.const,1);assert.equal(vectors.cases.length,10);});
test('frozen Cherkasy normalizer matches exact legacy intervals, tiles and totals',()=>{
 const {value,legacy,now}=frozen();assert.ok(validUniversal(value));
 const before=dayState(legacy,'2026-11-03',now),after=dayState(universalEnvelope(value,'line-a'),'2026-11-03',now);
 assert.deepEqual(after.displayHours,before.displayHours);assert.deepEqual(after.totals,before.totals);assert.equal(after.totals.off,vectors.frozenCherkasy.expectedOffMinutes);
});
test('arbitrary group and direct no-group schedules need no Cherkasy regex',()=>{
 const {value,now}=frozen();for(const code of ['B-12','7.2/A',null]){value.lines[0].groupCode=code;const s=universalEnvelope(value,'line-a');assert.equal(dayState(s,'2026-11-03',now).known,true);assert.equal(countdown(s,now).label,'До відключення');}
});
test('multiple lines require explicit selection and preserve separate schedules',()=>{const {value,now}=frozen();value.lines.push({...structuredClone(value.lines[0]),id:'line-b',groupCode:'B-12'});value.resolution.state='ambiguous';
 assert.equal(universalDay(value,'2026-11-03',null,now).known,false);assert.equal(universalDay(value,'2026-11-03','line-b',now).known,true);
});
test('unpublished, partial, invalid, stale and disabled never become clear empty days',()=>{const {value,now}=frozen();
 for(const mutate of [s=>s.schemaVersion=2,s=>s.lines[0].categories.hourly.days[0].state='new-dangerous-state',s=>s.resolution.complete=false,s=>s.supportState='disabled',s=>s.freshUntil=0,s=>s.lines[0].categories.hourly.days[0].state='not_published']){
  const s=structuredClone(value);mutate(s);assert.equal(dayState(universalEnvelope(s,'line-a'),'2026-11-03',now).known,false);
 }
});
test('degraded retained snapshot preserves original source timestamps and intervals',()=>{const {value,now}=frozen();const next=degraded({id:'address-a',operator_id:'ua-cherkasy'},value.coverage,value,'rate_limited',now+600000);assert.equal(next.sourceUpdatedAt,value.sourceUpdatedAt);assert.deepEqual(next.lines,value.lines);assert.notEqual(next.revision,value.revision);assert.equal(universalDay(next,'2026-11-03','line-a',now).known,false);});
test('partial category failure keeps prior intervals and timestamps as stale',()=>{const {value,now}=frozen();value.lines[0].categories.planned.days[0].intervals=[{start:now-3600000,end:now+3600000}];const failed=structuredClone(value);failed.lines[0].categories.planned={checkedAt:0,sourceUpdatedAt:null,freshUntil:0,days:[{date:'2026-11-03',state:'unknown',intervals:[]}]};
 const retained=retainPartial(failed,value,['planned']);assert.deepEqual(retained.lines[0].categories.planned.days[0].intervals,value.lines[0].categories.planned.days[0].intervals);assert.equal(retained.lines[0].categories.planned.sourceUpdatedAt,value.lines[0].categories.planned.sourceUpdatedAt);assert.equal(retained.lines[0].categories.planned.days[0].state,'stale');assert.equal(universalDay(retained,'2026-11-03','line-a',now).known,false);});
test('DST spring/fall days retain real epoch hours; source intervals are not rounded',()=>{for(const [date,count] of [['2026-10-25',25],['2026-03-29',23]]){const {value,now}=frozen(date);value.lines[0].categories.hourly.days[0].intervals=[{start:civil(date,960)+60000,end:civil(date,1080)+120000}];const d=dayState(universalEnvelope(value,'line-a'),date,now);assert.equal(d.hours.length,count);assert.equal(d.events[0].start%3600000,60000);}});
