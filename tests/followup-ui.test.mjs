import test from 'node:test';
import assert from 'node:assert/strict';
import {dayState,countdown} from '../app/lib/schedule.js';
import {civil,addDays} from '../app/lib/time.js';
import {canShareDay} from '../app/lib/notifications.js';
import {scheduleNotice} from '../app/lib/patch-ui.js';

const date='2026-10-28',now=civil(date,600);
const snapshot=(queue='3.2')=>({queue,checkedAt:now,feedCheckedAt:now,failures:[],plans:[],
  categories:Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{checkedAt:now,sourceAt:now,events:[]}]))});

test('sharing is hidden for confirmed empty days, excluded addresses and unknown data',()=>{
  const known=snapshot(),excluded=snapshot(null),unknown=snapshot(null);
  excluded.queueResolution={inclusion:'not_in_queue'};
  for(const s of [known,excluded,unknown])assert.equal(canShareDay(dayState(s,date,now)),false);
  assert.equal(dayState(excluded,date,now).totals.off,0);
  assert.equal(dayState(unknown,date,now).totals,null,'unknown is not converted into light');
});

test('sharing uses exact intervals of the selected date, including a minute lost by tile rounding',()=>{
  for(const category of ['hourly','planned','emergency']){
    const s=snapshot();s.categories[category].events=[{start:civil(date,721),end:civil(date,722),category}];
    const selected=dayState(s,date,now);
    assert.equal(canShareDay(selected),true,category);
    assert.equal(selected.displayHours.some(h=>h.segments.some(x=>x.kind===category)),false);
    assert.equal(canShareDay(dayState(s,addDays(date,1),now)),false);
  }
});

test('sharing excludes zero-length intervals but retains ongoing confirmed address events',()=>{
  const s=snapshot(null);
  s.categories.emergency.events=[{start:now,end:now,category:'emergency'}];
  assert.equal(canShareDay(dayState(s,date,now)),false);
  s.categories.emergency.events=[{start:now-60000,end:null,category:'emergency'}];
  assert.equal(canShareDay(dayState(s,date,now)),true);
});

test('only a repeated no-outage status is removed; different selected-day warnings stay visible',()=>{
  const s=snapshot(null);s.queueResolution={inclusion:'not_in_queue'};
  const day=dayState(s,date,now),label=countdown(s,now).label;
  assert.equal(label,'У вас відключень поки немає');
  assert.equal(scheduleNotice(day,label),'');
  assert.equal(scheduleNotice(day,'До відключення'),label);
  assert.equal(scheduleNotice(dayState(snapshot(null),date,now),label),'Немає точних даних');
  assert.equal(scheduleNotice({reason:'plan_incomplete'},label),'Графік містить неповні дані');
});

test('sharing follows real 23/25-hour day bounds without creating outages',()=>{
  for(const d of ['2026-03-29','2026-10-25']){
    const t=civil(d,720),s=snapshot();s.categories=Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{checkedAt:t,sourceAt:t,events:[]} ]));s.feedCheckedAt=t;
    assert.equal(canShareDay(dayState(s,d,t)),false);
    s.categories.planned.events=[{category:'planned',start:civil(d),end:civil(addDays(d,1))}];
    assert.equal(canShareDay(dayState(s,d,t)),true);
  }
});
