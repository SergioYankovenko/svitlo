// Exact release, real PostgreSQL catalog, scoped read-only Meilisearch key.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import pg from 'pg';
const database=process.env.PGDATABASE,base='http://127.0.0.1:8080';
assert.match(database,/^svitlo_modular_qa_\d+$/);
const db=new pg.Client({host:'postgres',database,user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});
await db.connect();
const sql=`select e.id,e.parent_id,e.label
 from svitlo_vps.catalog e join svitlo_vps.catalog p on p.id=e.parent_id
 join svitlo_vps.catalog c on c.id=p.parent_id
 join svitlo_search.receipts r on r.entity_id=e.id
 join svitlo_search.control g on g.active_generation=r.generation and g.enabled
 where e.kind='address' and e.operator_id='ua-cherkasy' and e.redirect_to is null
 and p.metadata->>'regionOperator' is null and c.metadata->>'regionOperator' is null
 and svitlo_search.public_allowed(e.id)
 order by md5(e.id::text) limit 200`;
const exact=(await db.query(sql)).rows;assert.equal(exact.length,200);
const api=spawn(process.execPath,['vps/http.mjs'],{stdio:['ignore','ignore','pipe'],env:{...process.env,STAGE_ORIGIN:base}});
let diagnostic='';api.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-1200);});
async function post(body){
 const start=performance.now(),r=await fetch(base+'/api/v1/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,...body}),signal:AbortSignal.timeout(5000)});
 assert.equal(r.status,200);
 return {ms:performance.now()-start,value:await r.json()};
}
const indexed=value=>value.nextCursor&&JSON.parse(Buffer.from(value.nextCursor,'base64url')).engine==='meili';
try{
 let ready=false;
 for(let i=0;i<80;i++){try{if((await fetch(base+'/readyz')).ok){ready=true;break;}}catch{}await sleep(100);}
 assert.ok(ready,'QA search API not ready: '+diagnostic.replace(/\b[spdt]_[A-Za-z0-9_-]+/g,'[redacted]'));
 const prefixes=[];
 for(const q of ['','с','к','ч','п','м','в','л'])if(indexed((await post({kind:'cities',q,limit:2})).value))prefixes.push(q);
 assert(prefixes.length>=2,'Meili index path not proven');
 const times=[],exactTimes=[],indexedTimes=[],active=new Set();let exactCorrect=0,indexedCorrect=0,firstError;const start=performance.now();
 for(let i=0;i<400;i++){
  const wait=start+i*50-performance.now();if(wait>0)await sleep(wait);
  if(active.size>=8)await Promise.race(active);if(firstError)throw firstError;
  const e=exact[Math.floor(i/2)],isExact=i%2===0;
  const job=(async()=>{
   const {ms,value}=await post(isExact?{kind:'houses',parentId:e.parent_id,q:e.label,limit:20}:{kind:'cities',q:prefixes[Math.floor(i/2)%prefixes.length],limit:2});
   if(isExact){assert(value.items.some(x=>x.id===e.id));assert(value.items.every(x=>x.house.normalize('NFC').trim().toLocaleLowerCase('uk-UA')===e.label.normalize('NFC').trim().toLocaleLowerCase('uk-UA')));exactCorrect++;}
   else{assert(indexed(value));indexedCorrect++;}
   times.push(ms);(isExact?exactTimes:indexedTimes).push(ms);
  })().catch(e=>{firstError??=e;}).finally(()=>active.delete(job));active.add(job);
 }
 await Promise.all(active);if(firstError)throw firstError;
 const duration=performance.now()-start;
 const p95=values=>Math.round(values.sort((a,b)=>a-b)[Math.floor(values.length*.95)]);
 const p95ms=p95(times);
 assert.equal(exactCorrect,200);assert.equal(indexedCorrect,200);
 const report={status:p95ms<=200&&duration<=20500?'pass':'threshold_missed',measurement:'full-http-api',requestsPerSecond:20,observedRequestsPerSecond:Math.round(times.length/duration*10000)/10,elapsedMs:Math.round(duration),p95ms,exactP95ms:p95(exactTimes),indexedP95ms:p95(indexedTimes),
  exactCases:200,exactCorrect,indexedCases:200,indexedCorrect,providerRequests:0,productionDataWritten:false};
 await writeFile('/qa-output/report.json',JSON.stringify(report));console.log(JSON.stringify(report));
}finally{if(api.exitCode===null){api.kill('SIGTERM');await new Promise(resolve=>api.once('exit',resolve));}await db.end();}
