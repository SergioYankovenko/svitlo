import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GroupPlans} from './group-plans.js';
import {dtekSnapshot,projectStreet,resolveHouse,parseHours} from './policy.js';
import {civil} from '../../app/lib/time.js';
import {Source} from '../../server/source.js';
import {normalizeLegacy} from '../universal/normalize.js';

const date='2026-11-04',now=civil(date,900),range={fromDate:date,toDate:date};
const entity={id:'house-id',operator_id:'ua-kyiv-region-dtek',source_ref:{house:'1'}};
test('shared DTEK schedule supersedes the street fact while keeping exact line and emergency evidence',()=>{
  const raw=JSON.parse(readFileSync(new URL('./fixtures/brovary.json',import.meta.url),'utf8'));
  const data=projectStreet(raw,now),resolution=resolveHouse(data,'1');
  resolution.lines=resolution.lines.map(l=>({...l,id:l.key}));
  const key=resolution.lines[0].key,hours=Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),i===0?'no':'yes']));
  const group={fact:{data:{[civil(date)/1000]:{[key]:hours}},update:'04.11.2026 14:50'},flags:{},checkedAt:now-240000,fresh:true};
  const category=dtekSnapshot(entity,resolution,range,data,null,now,group).lines[0].categories.hourly;
  assert.equal(category.checkedAt,group.checkedAt);
  assert.deepEqual(category.days[0].publication.intervals,parseHours(hours,date).intervals);
  const stale=dtekSnapshot(entity,resolution,range,data,null,now,{...group,fresh:false}).lines[0].categories.hourly;
  assert.ok(stale.freshUntil<=now);
  assert.equal(stale.days[0].state,'stale');
});

test('one Cherkasy news read serves the subgroups and malformed rows stay unknown',async()=>{
  const title='Оновлено графік погодинних відключень (ГПВ) на 4 листопада';
  const post={id:1,slug:'verified-gpv',title,publishedAt:new Date(now-60000).toISOString(),content:'<p>1.1 01:00 - 02:00</p><p>1.2 03:00 - 20:0 0</p>'};
  const requests=[];
  const source=new Source(async url=>{requests.push(new URL(url));return Response.json({success:true,data:url.includes('/category/')?{content:[post]}:post});});
  const bridge={query:async()=>({rows:[{value:null}]})};
  const collected=await new GroupPlans(bridge,{now:()=>now}).captureCherkasy(source);
  assert.equal(collected.error,null);
  assert.deepEqual(requests.map(u=>u.pathname),['/api/v1/posts/category/news','/api/v1/posts/verified-gpv']);
  const resolution={state:'resolved',complete:true,lines:[{id:'line',key:'main',label:'Group',groupCode:'1.1'}]};
  const legacy={queue:'1.1',groupSchedule:true,plans:collected.value.plans,feedCheckedAt:now,checkedAt:now};
  const read=(data)=>normalizeLegacy({...entity,operator_id:'ua-cherkasy'},data,resolution,range,now).lines[0].categories.hourly.days[0];
  assert.equal(read(legacy).state,'published');assert.equal(read({...legacy,queue:'1.2'}).state,'unknown');
  assert.equal(read({...legacy,feedFailed:true}).state,'stale');
});

test('a source failure preserves the last group publication as expired evidence',async()=>{
  const prior={checkedAt:now-300000,fact:{},flags:{}};
  const responses={'dtek-kyiv-region':{slot:now,checkedAt:prior.checkedAt,error:'forbidden',value:prior}};
  const bridge={query:async(_sql,[source])=>({rows:[{value:responses[source]}]})};
  const {primary}=await new GroupPlans(bridge,{now:()=>now}).dtek('ua-kyiv-region-dtek');
  assert.deepEqual(primary,{fact:{},flags:{},checkedAt:prior.checkedAt,fresh:false});
});
