import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {universalEnvelope} from '../app/lib/universal-contract.js';
const source=(await readFile(new URL('../pwa/live-model.js',import.meta.url),'utf8')).replaceAll("'./core/",`'${new URL('../app/',import.meta.url).href}`);
const {scheduleFor,planView,summaryVisible}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const box={window:{}};vm.runInNewContext(await readFile(new URL('../pwa/reference-policy.js',import.meta.url),'utf8'),box);
const {summary}=box.window.SvitloPolicy;
const base=JSON.parse(await readFile(new URL('fixtures/kyiv-publication/deg25-emergency.json',import.meta.url),'utf8'));
const date='2026-11-04',now=base.checkedAt;
function schedule(edit=()=>{}){const s=structuredClone(base);edit(s.lines[0]);return scheduleFor({snapshot:universalEnvelope(s,s.lines[0].id)},date,now);}

test('queue emergency hides both unknown totals without changing evidence or cache',()=>{
 const d=schedule(),before=JSON.stringify(d),v=planView(d),s=summary(v);
 assert.equal(d.emergencySuspended,true);assert.equal(s.on,null);assert.equal(s.off,null);
 assert.equal(summaryVisible(v,s),false);assert.equal(JSON.stringify(d),before);
 assert.equal(d.at(0),'unknown');assert.equal(d.planSummary,null);
});
test('a positive address emergency with a partial day also hides the pair',()=>{
 const d=schedule(l=>{const h=l.categories.hourly.days[0];h.state='unknown';h.applicability={state:'unconfirmed',reason:'no_plan'};h.publication.state='not_published';h.publication.intervals=[];l.categories.emergency.days[0].intervals=[{start:now-60000,end:null}];});
 assert.equal(d.emergencySuspended,false);assert.ok(d.events.some(e=>e.kind==='emergency'));
 assert.equal(summaryVisible(d,summary(d)),false);
});
test('usable actual sensor totals remain visible during emergency including partial coverage',()=>{
 const d=schedule(),s=summary(d,{available:true,covered:91.2,unknown:1348.8,on:60.1,off:31.1,through:now},true);
 assert.equal(s.source,'device_observation');assert.equal(s.partial,true);assert.equal(summaryVisible(d,s),true);
 assert.equal(s.on,60.1);assert.equal(s.off,31.1);
});
test('empty observation does not reveal unknown emergency totals',()=>{
 const d=schedule(),s=summary(d,{available:true,covered:0,on:0,off:0},true);
 assert.equal(summaryVisible(d,s),false);
});
test('restored published plan reappears with both exact plan totals',()=>{
 const d=schedule(l=>{const h=l.categories.hourly.days[0];h.state='published';h.applicability={state:'reported',reason:'official_plan'};h.intervals=structuredClone(h.publication.intervals);}),v=planView(d),s=summary(v);
 assert.equal(d.emergencySuspended,false);assert.ok(Number.isFinite(s.on)&&Number.isFinite(s.off));assert.equal(summaryVisible(v,s),true);
});
test('complete emergency totals including zero remain visible',()=>{
 const d={emergencySuspended:true,events:[]};assert.equal(summaryVisible(d,{on:0,off:1440}),true);
 for(const value of [null,undefined,NaN,Infinity])assert.equal(summaryVisible(d,{on:value,off:10}),false);
 assert.equal(summaryVisible(d,null),false);
});
test('unrelated incomplete non-emergency summaries keep existing behavior',()=>{
 assert.equal(summaryVisible({emergencySuspended:false,events:[]},{on:60,off:null}),true);
});
