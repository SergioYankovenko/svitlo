import pg from 'pg';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {pool} from '../db.js';import {SourceHistory} from './source-history.js';import {historicalPlan} from './historical-plan.js';
import {civil,addDays,dayKey} from '../../app/lib/time.js';
if(!/^svitlo_sources_qa_\d+$/.test(process.env.PGDATABASE||''))throw Error('Disposable restored source-history QA database required');
const ci=process.env.SOURCE_HISTORY_CI==='true';if(ci&&process.env.PGHOST!=='127.0.0.1')throw Error('CI history credentials are localhost-only');
const admin=new pg.Client({host:process.env.PGHOST||'postgres',database:process.env.PGDATABASE,user:'svitlo_owner',password:ci?'isolated-history-ci':(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const connection=role=>{const p=ci?new pg.Pool({host:'127.0.0.1',database:process.env.PGDATABASE,user:'svitlo_stage_'+role,password:'isolated-history-ci',max:2}):pool(role,2);return {p,bridge:{query:(...args)=>p.query(...args)}};};
const a=connection('worker'),b=connection('worker'),api=connection('api'),checks=[];
const check=async(name,fn)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,status:'pass'}));};
const digest=async()=>(await admin.query("select count(*) n,md5(string_agg(id::text||owner::text||address::text||name||preferences::text,'|' order by id)) digest from public.svitlo_profiles")).rows[0];
const before=await digest();let yasnoFail=false;
const fixtures=Object.fromEntries(await Promise.all(['kyiv','brovary','yasno-applies-23.1'].map(async n=>[n,JSON.parse(await readFile(new URL('./fixtures/'+n+'.json',import.meta.url),'utf8'))])));
const fetcher=async(url,options)=>{
 if(url.includes('yasno'))return yasnoFail?new Response('',{status:503}):Response.json(fixtures['yasno-applies-23.1']);
 if(!options.headers['x-csrf-token'])return new Response('',{status:400,headers:{'set-cookie':(url.includes('krem')?'_csrf-dtek-krem':'_csrf-dtek-kem')+'='+encodeURIComponent('i:1;s:32:"0123456789abcdef0123456789abcdef";')}});
 return Response.json(fixtures[url.includes('krem')?'brovary':'kyiv']);};
const regions={gate:async()=>randomUUID(),finish:async()=>{}};
const collectors=[a,b].map(rt=>new SourceHistory({bridge:rt.bridge,regions,enabled:true,fetcher}));
const moveCurrent=async()=>{await admin.query('begin');try{
 await admin.query("insert into svitlo_source_history.cycles select slot-300000,token,started_at,finished_at,lease_until,state,policy,comparisons,analysis_error from svitlo_source_history.cycles where slot=(select max(slot) from svitlo_source_history.cycles)");
 await admin.query('update svitlo_source_history.observations set slot=slot-300000 where slot=(select max(slot) from svitlo_source_history.cycles)');
 await admin.query('delete from svitlo_source_history.cycles where slot=(select max(slot) from svitlo_source_history.cycles)');await admin.query('commit');
 }catch(e){await admin.query('rollback');throw e;}};
try{
 await admin.query('truncate svitlo_source_history.cycles,svitlo_source_history.observations,svitlo_source_history.payloads');
 await check('API has no history access; worker can only use constrained functions, not edit evidence or assume owner',async()=>{
  for(const sql of ['select * from svitlo_source_history.cycles','select svitlo_source_history.claim()'])await assert.rejects(()=>api.p.query(sql),e=>e.code==='42501');
  await assert.rejects(()=>a.p.query('select * from svitlo_source_history.payloads'),e=>e.code==='42501');await assert.rejects(()=>a.p.query('set role svitlo_region_owner'),e=>e.code==='42501');
 });
 await check('two worker processes claim exactly one real five-minute slot',async()=>{
  const results=await Promise.all(collectors.map(c=>c.runDue()));assert.equal(results.filter(x=>x.state==='saved').length,1);assert.equal(results.filter(x=>x.state==='not_due').length,1);
  assert.equal((await admin.query('select count(*) n from svitlo_source_history.observations')).rows[0].n,3);
 });
 await check('same payload is deduplicated across independent observations without refreshing the old clocks',async()=>{
  const old=(await admin.query('select min(checked_at) n from svitlo_source_history.observations')).rows[0].n;
  await moveCurrent();await collectors[0].runDue();assert.equal((await admin.query('select count(*) n from svitlo_source_history.payloads')).rows[0].n,3);
  assert.equal((await admin.query('select count(*) n,min(checked_at) old from svitlo_source_history.observations')).rows[0].n,6);assert.equal((await admin.query('select min(checked_at) n from svitlo_source_history.observations')).rows[0].n,old);
 });
 await check('stale token cannot overwrite evidence and a repeated completed submission is inert',async()=>{
  const row=(await admin.query('select slot,token from svitlo_source_history.cycles order by slot desc limit 1')).rows[0];
  await assert.rejects(()=>a.p.query('select svitlo_source_history.finish($1,$2,$3,$4)',[row.slot,randomUUID(),'[]','[]']));
  assert.equal((await a.p.query('select svitlo_source_history.finish($1,$2,null,null) value',[row.slot,row.token])).rows[0].value.state,'already_saved');
 });
 await check('one failed source is persisted alongside both successful DTEK legs, without a false comparison',async()=>{
  // Make another current slot in this disposable database, preserving prior test observations.
  await admin.query('delete from svitlo_source_history.cycles where slot=(select min(slot) from svitlo_source_history.cycles)');await moveCurrent();yasnoFail=true;
  const result=await collectors[0].runDue();assert.equal(result.sourceStates['yasno-kyiv'],'error');assert.equal(result.sourceStates['dtek-kyiv'],'ok');assert.equal(result.comparisons,0);
  const rows=(await admin.query('select state,http_status,payload_hash from svitlo_source_history.observations where source=$1 order by slot desc limit 1',['yasno-kyiv'])).rows;assert.equal(rows[0].http_status,503);assert.equal(rows[0].payload_hash,null);
 });
 await check('crashed expired cycles become interrupted instead of invented successful observations',async()=>{
  const latest=(await admin.query('select max(slot) n from svitlo_source_history.cycles')).rows[0].n;
  await admin.query("insert into svitlo_source_history.cycles(slot,token,started_at,lease_until,state) values($1,$2,1,1,'collecting')",[latest-900000,randomUUID()]);
  await a.p.query('select svitlo_source_history.claim()');assert.equal((await admin.query('select state from svitlo_source_history.cycles where slot=$1',[latest-900000])).rows[0].state,'interrupted');
 });
 await check('bounded Kyiv-day report exposes source failure, missing windows and no physical-power assertion',async()=>{
  const report=await collectors[0].report({fromDate:dayKey(Date.now()-86400000),toDate:dayKey(Date.now())});assert.ok(report.rows.length>=2);assert.ok(report.rows.some(r=>r.observations?.some(o=>o.state==='error')));assert.equal(report.actualPower,'unknown');assert.ok(report.samplingGaps.length);
  await assert.rejects(()=>collectors[0].report({fromDate:'2026-01-01',toDate:'2026-12-31'}));
 });
 await check('90-day bounded cleanup removes only expired evidence and leaves all pilot profiles unchanged',async()=>{
  const old=Date.now()-92*86400000,slot=old-old%300000;
  await admin.query("insert into svitlo_source_history.cycles(slot,token,started_at,finished_at,lease_until,state) values($1,$2,$3,$3,$3,'complete')",[slot,randomUUID(),old]);
  await admin.query("insert into svitlo_source_history.payloads values($1,'dtek-kyiv','{}',$2,$2)",['0'.repeat(64),old]);
  await a.p.query('select svitlo_source_history.cleanup()');assert.equal((await admin.query('select count(*) n from svitlo_source_history.cycles where slot=$1',[slot])).rows[0].n,0);assert.equal((await admin.query('select count(*) n from svitlo_source_history.payloads where hash=$1',['0'.repeat(64)])).rows[0].n,0);assert.deepEqual(await digest(),before);
 });
 await check('API reads a bounded historical plan without raw history or collector controls',async()=>{
  const date=addDays(dayKey(),-80),from=civil(date),intervals=[{start:from,end:from+1800000}];
  for(const minute of [-5,0,5]){
   const stamp=from+minute*60000,comparison={group:'GPV99.1',date,state:'published',classification:'agreement',intervals,
    evidence:{applicability:'reported',intervalComparison:'equal',primaryCheckedAt:stamp,secondaryCheckedAt:stamp},privateMarker:'must-not-leak'};
   await admin.query("insert into svitlo_source_history.cycles(slot,token,started_at,finished_at,lease_until,state,comparisons) values($1,$2,$1,$3,$3,'complete',$4::jsonb)",[stamp,randomUUID(),stamp+2000,JSON.stringify([comparison])]);
  }
  const rows=(await api.p.query('select svitlo_source_history.plan_observations($1,$2::date) value',['GPV99.1',date])).rows[0].value;
  assert.equal(rows.length,3);assert.equal(historicalPlan(rows,date).periods[0].end,from+300000);assert.ok(!JSON.stringify(rows).includes('must-not-leak'));
  for(const sql of ['select * from svitlo_source_history.cycles','select * from svitlo_source_history.payloads','select svitlo_source_history.claim()'])await assert.rejects(()=>api.p.query(sql),e=>e.code==='42501');
  await assert.rejects(()=>api.p.query('select svitlo_source_history.plan_observations($1,$2::date) value',['GPV99.1','2000-01-01']));
  assert.deepEqual(await digest(),before);
 });
 console.log(JSON.stringify({scope:'paired-source-history-isolated-postgresql',passed:checks.length,realOperatorRequests:0,originalProfiles:before.n,originalConfigurationDigest:before.digest,liveProfileWrites:0}));
}finally{await Promise.all([a.p.end(),b.p.end(),api.p.end(),admin.end()]);}
