import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dayKey} from '../../app/lib/time.js';
import {dtekFixtureAt,yasnoFixtureAt} from './fixtures/calendar.mjs';
import {projectStreet,resolveHouse,dtekSnapshot} from './policy.js';
import {projectYasno} from './yasno.js';
const dtek=JSON.parse(await readFile(new URL('./fixtures/kyiv.json',import.meta.url),'utf8'));
const yasno=JSON.parse(await readFile(new URL('./fixtures/yasno-applies-23.1.json',import.meta.url),'utf8'));
const original=JSON.stringify([dtek,yasno]);
for(const instant of ['2026-11-04T21:59:59Z','2026-11-04T22:00:01Z']){
 test('regional QA calendar preserves current-day reconciliation at '+instant,()=>{
  const now=Date.parse(instant),date=dayKey(now),data=projectStreet(dtekFixtureAt(dtek,now),now);
  const resolution=resolveHouse(data,'36');resolution.lines=resolution.lines.map(l=>({...l,id:l.key}));
  const entity={id:'calendar-qa',operator_id:'ua-kyiv-dtek',source_ref:{house:'36'}};
  const snapshot=raw=>dtekSnapshot(entity,resolution,{fromDate:date,toDate:date},data,projectYasno(raw,now),now);
  const raw=yasnoFixtureAt(yasno,now),equal=snapshot(raw);
  assert.equal(equal.supportState,'available');
  assert.equal(equal.provenance[0].reconciliation.days['GPV23.1:'+date].intervalComparison,'equal');
  raw['23.1'].today.slots[1].end=809;raw['23.1'].today.slots[2].start=809;
  const conflict=snapshot(raw),day=conflict.lines[0].categories.hourly.days[0];
  assert.equal(conflict.supportState,'degraded');assert.equal(day.applicability.state,'conflict');
  assert.equal(day.publication.state,'published');assert(day.publication.intervals.length);
  raw['23.1'].today.slots=[];
  const incomplete=snapshot(raw);
  assert.equal(incomplete.supportState,'degraded');
  assert.equal(incomplete.provenance[0].reconciliation.days['GPV23.1:'+date].reason,'secondary_intervals_unavailable');
  assert.equal(JSON.stringify([dtek,yasno]),original);
 });
}
