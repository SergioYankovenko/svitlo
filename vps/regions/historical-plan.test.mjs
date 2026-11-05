import {Regions} from './service.js';
import {projectStreet,resolveHouse} from './policy.js';
import {dtekFixtureAt} from './fixtures/calendar.mjs';
import {validUniversal} from '../../app/lib/universal-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {historicalPlan} from './historical-plan.js';
import {civil,dayKey,addDays} from '../../app/lib/time.js';
const date=addDays(dayKey(),-3),from=civil(date),now=from+86400000;
const sample=(minute,extra={})=>({observedAt:from+minute*60000+2000,primaryCheckedAt:from+minute*60000,secondaryCheckedAt:from+minute*60000,
 state:'published',classification:'agreement',applicability:'reported',intervalComparison:'equal',intervals:[{start:from,end:from+1800000}],...extra});

test('only adjacent observations agreeing on the same plan preserve bounded history',()=>{
 const rows=[sample(-5),sample(0),sample(5),sample(10,{state:'suspended'}),sample(15),sample(20)],before=JSON.stringify(rows);
 const h=historicalPlan(rows,date,now);assert.equal(h.periods.length,2);
 assert.deepEqual(h.periods.map(p=>[p.start,p.end]),[[from,from+5*60000],[from+15*60000,from+20*60000]]);
 assert.equal(JSON.stringify(rows),before);assert.equal(h.basis,'archived_official_plan');
});
test('no extrapolation through failures, gaps, revisions, future clocks or unknown applicability',()=>{
 for(const last of [sample(20),sample(5,{state:'unknown'}),sample(5,{classification:'conflict'}),sample(5,{applicability:'unconfirmed'}),sample(5,{intervals:[]}),sample(5,{observedAt:now+1})])assert.equal(historicalPlan([sample(0),last],date,now),null);
 assert.equal(historicalPlan([],date,now),null);assert.equal(historicalPlan([sample(0)],date,now),null);
});
test('provider snapshot, archive enrichment and shared cache preserve additive API compatibility',async()=>{
 const stamp=from+12*3600000,data=projectStreet(dtekFixtureAt(JSON.parse(await readFile(new URL('./fixtures/kyiv.json',import.meta.url),'utf8')),stamp),stamp),house=Object.keys(data.houses)[0];
 data.flags.showTableFact=false;const original=JSON.stringify(data),resolution=resolveHouse(data,house);
 resolution.lines=resolution.lines.map((l,i)=>({...l,id:'line-'+i}));let calls=0;
 const db={sourceClaim:async()=>({state:'owner',token:'synthetic'}),sourceFinish:async()=>true};
 const regions=new Regions({db,secret:'x'.repeat(64),now:()=>stamp,bridge:{query:async(sql,args)=>{calls++;assert.ok(sql.includes('plan_observations'));assert.equal(args[1],date);return{rows:[{value:[sample(-5),sample(0),sample(5)]}]};}}});
 regions.address=async()=>data;regions.cityStatus=async()=>null;
 const entity={id:'11111111-1111-4111-8111-111111111111',operator_id:'ua-kyiv-dtek',source_ref:{house}},range={fromDate:date,toDate:date};
 const value=(await regions.snapshot(entity,resolution,range)).value;assert.equal(validUniversal(value),true);assert.ok(calls>0);
 const day=value.lines[0].categories.hourly.days[0];assert.equal(day.state,'suspended');assert.deepEqual(day.intervals,[]);assert.equal(day.historicalPlan.periods[0].end,from+300000);
 assert.equal(JSON.stringify(data),original);
});
test('real SQL projection returns only the requested public group/day with bounded grants',async()=>{
const db=new PGlite();
 try{
await db.exec(`create role svitlo_region_owner;create role svitlo_stage_api;create role svitlo_stage_worker;
 create schema svitlo_source_history authorization svitlo_region_owner;
 create table svitlo_source_history.cycles(slot bigint primary key,finished_at bigint,state text,comparisons jsonb);
 alter table svitlo_source_history.cycles owner to svitlo_region_owner;`);
await db.exec(await readFile(new URL('../sql/historical-plan.sql',import.meta.url),'utf8'));


 for(const minute of [-5,0,5]){
  const row=sample(minute),decision={group:'GPV99.1',date,state:row.state,classification:row.classification,intervals:row.intervals,
   evidence:{applicability:row.applicability,intervalComparison:row.intervalComparison,primaryCheckedAt:row.primaryCheckedAt,secondaryCheckedAt:row.secondaryCheckedAt},privateMarker:'NEVER_EXPOSE'};
  await db.query('insert into svitlo_source_history.cycles values($1,$2,$3,$4::jsonb)',[from+minute*60000,row.observedAt,'complete',JSON.stringify([decision])]);
 }
 await db.exec('set role svitlo_stage_api');
 const rows=(await db.query('select svitlo_source_history.plan_observations($1,$2::date) value',['GPV99.1',date])).rows[0].value;
 assert.equal(rows.length,3);assert.equal(historicalPlan(rows,date,now).periods[0].end,from+5*60000);
 assert.ok(!JSON.stringify(rows).includes('NEVER_EXPOSE'));
 assert.deepEqual((await db.query('select svitlo_source_history.plan_observations($1,$2::date) value',['GPV98.1',date])).rows[0].value.map(x=>x.state),[null,null,null]);
 await assert.rejects(()=>db.query('select * from svitlo_source_history.cycles'),e=>e.code==='42501');
 await assert.rejects(()=>db.query('select svitlo_source_history.plan_observations($1,$2::date)',['invalid',date]));
 await db.exec('reset role');
 }finally{await db.close();}
});
