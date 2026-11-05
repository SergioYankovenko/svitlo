import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
test('explicit discovery preloader rejects the live database before installing any transport hook',()=>{
 const r=spawnSync(process.execPath,['--import','./vps/discovery/qa-upstream.mjs','--input-type=module','-e','throw Error("must not run")'],{cwd,env:{...process.env,PGDATABASE:'svitlo_staging'},encoding:'utf8',timeout:10000});
 assert.notEqual(r.status,0);assert.match(r.stderr,/Disposable discovery QA database required/);assert.ok(!r.stderr.includes('Error: must not run'));
});
test('explicit QA child intercepts the custom Undici operator adapter and blocks all other external sources',()=>{
 const script=`import assert from 'node:assert/strict';import {operatorFetch} from './vps/operator-fetch.js';const r=await operatorFetch('https://cabinet.cherkasyoblenergo.com/?op=street_list');assert.equal((await r.json())[0].ID,'geo-qa-street');await assert.rejects(()=>operatorFetch('https://invalid.example/'),/Outbound fetch is disabled/);console.log('isolated');`;
 const r=spawnSync(process.execPath,['--import','./vps/discovery/qa-upstream.mjs','--input-type=module','-e',script],{cwd,env:{...process.env,PGDATABASE:'svitlo_discovery_qa_1'},encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'isolated');
});
