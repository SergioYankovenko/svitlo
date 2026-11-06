import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unresolvedLog} from './unresolved-log.js';
test('protected unresolved log deduplicates concurrent retries and excludes credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'svitlo-unresolved-'));try{
  const file=join(dir,'cases.ndjson'),write=unresolvedLog(file),address={queueUnresolved:true,canonicalAddressId:'a',operatorId:'source',city:'City',street:'Street',house:'1',queueReason:'ambiguous',queueCandidates:['2.2','3.2'],token:'secret',email:'private'};
  await Promise.all([write(address,'profile'),write(address,'profile')]);const body=await readFile(file,'utf8');assert.equal(body.trim().split('\n').length,1);assert.doesNotMatch(body,/secret|private|profile/);assert.equal(JSON.parse(body).reason,'ambiguous');
  await write({...address,queueUnresolved:false},'other');assert.equal(await readFile(file,'utf8'),body);
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
 }finally{await rm(dir,{recursive:true,force:true});}
});
