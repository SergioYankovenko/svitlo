import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {projectStreet,resolveHouse,dtekSnapshot,parseHours,localStamp} from './policy.js';
import {validUniversal} from '../../app/lib/universal-contract.js';import {civil} from '../../app/lib/time.js';
const fixture=n=>JSON.parse(readFileSync(new URL('./fixtures/'+n+'.json',import.meta.url),'utf8'));
const date='2026-11-04',now=civil(date,17*60+30),range={fromDate:date,toDate:'2026-11-05'};
const cases=[['kyiv-dehtiarivska-20261104','вул. Дегтярівська','25','22.1'],['kyiv-dehtiarivska-20261104','вул. Дегтярівська','25А/к.1','14.1'],['kyiv-mrii-20261104','вул. Мрії','15Б','21.1']];
function snapshot(name,street,house,group,change){const raw=fixture(name);change?.(raw);const data=projectStreet(raw,now),r=resolveHouse(data,house);r.lines=r.lines.map(l=>({...l,id:'line-'+l.key}));const status={checkedAt:now,updatedAt:civil(date,14*60+50),groupUpdatedAt:{['GPV'+group]:civil(date,14*60+50)},groups:{['GPV'+group]:{[date]:'EmergencyShutdowns','2026-11-05':'EmergencyShutdowns'}},daySchedules:{}};
 return {raw,data,resolution:r,value:dtekSnapshot({id:'11111111-1111-4111-8111-111111111111',operator_id:'ua-kyiv-dtek',source_ref:{city:'м. Київ',street,house}},r,range,data,status,now)};}
for(const values of cases)test('real reported address retains its published plan under emergency: '+values[2],()=>{
 const {raw,data,resolution,value}=snapshot(...values);assert(validUniversal(value));assert.equal(resolution.complete,true);assert.equal(resolution.lines.length,1);assert.equal(resolution.lines[0].groupCode,values[3]);
 const c=value.lines[0].categories,day=c.hourly.days[0],expected=parseHours(Object.values(raw.fact.data)[0]['GPV'+values[3]],date);
 assert.equal(day.state,'suspended');assert.deepEqual(day.intervals,[]);assert.equal(day.publication.state,'published');assert.deepEqual(day.publication.intervals,expected.intervals);assert(day.publication.intervals.length);
 assert.equal(day.applicability.state,'suspended');assert.equal(day.applicability.reason,'emergency_report_newer_than_plan');assert.equal(day.publication.sourceUpdatedAt,localStamp(raw.fact.update));assert.equal(day.publication.checkedAt,now);
 for(const kind of ['planned','unplanned','emergency']){assert.equal(c[kind].evidenceMode,'positive_only');assert.equal(c[kind].days[0].state,'unknown');}
 assert.equal(c.hourly.days[1].publication.state,'not_published');assert.deepEqual(c.hourly.days[1].publication.intervals,[]);assert.equal(value.provenance[0].reconciliation.days['GPV'+values[3]+':'+date].powerState,'unknown');
});
test('incomplete or invalid-clock table is retained as unknown, never a complete published reference',()=>{
 const values=cases[0];let r=snapshot(...values,raw=>{delete Object.values(raw.fact.data)[0]['GPV22.1']['1'];});assert.equal(r.value.lines[0].categories.hourly.days[0].publication.state,'unknown');
 r=snapshot(...values,raw=>{raw.fact.update='invalid';});assert.equal(r.value.lines[0].categories.hourly.days[0].publication.state,'unknown');
});
test('a valid group plus an invalid companion record does not silently choose a line',()=>{
 const r=snapshot(...cases[2],raw=>raw.data['15Б'].push({sub_type:'Стабілізаційне відключення',sub_type_reason:[]}));assert.equal(r.resolution.complete,false);assert.equal(r.resolution.state,'unknown');
});
