import test from 'node:test';
import assert from 'node:assert/strict';
import {predictDays} from './prediction.js';
import {civil,addDays} from '../../app/lib/time.js';
const today='2026-11-06';
function days(count=14){return Array.from({length:count},(_,i)=>{const date=addDays(today,-i-1),start=civil(date),end=civil(addDays(date,1));return {date,dayStartUtc:new Date(start).toISOString(),dayEndUtc:new Date(end).toISOString(),observation:{semantics:'explicit_coverage_only',complete:true,intervals:[{start:new Date(start).toISOString(),end:new Date(end).toISOString(),powerState:'on'}]}};});}
test('recurring complete measurements produce a labelled estimate for today and tomorrow',()=>{
 const result=predictDays(days(),today);assert.deepEqual(Object.keys(result),[today,addDays(today,1)]);assert.ok(result[today].sampleDays>=7);assert.deepEqual(result[today].segments,[{start:0,end:1440,state:'on'}]);assert.equal(result[today].method,'recurring_observations_v1');
});
test('insufficient, conflicting, missing and future history cannot become a forecast',()=>{
 assert.deepEqual(predictDays(days(6),today),{});
 const gap=days();gap.forEach(d=>d.observation.intervals=[]);assert.deepEqual(predictDays(gap,today),{});
 const split=days();split.slice(0,7).forEach(d=>d.observation.intervals[0].powerState='off');assert.deepEqual(predictDays(split,today),{});
 const future=days();future.forEach(d=>d.date=addDays(today,1));assert.deepEqual(predictDays(future,today),{});
});
