import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';import {randomBytes,randomUUID} from 'node:crypto';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {GoogleIdentity} from './google.js';import {adminFixture} from '../admin/fixture.mjs';
test('Google proof verifies signature, fixed issuer/audience, expiry, nonce and authorized party; email is never an identity key',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey),nonce=randomBytes(32).toString('base64url'),aud='server.apps.googleusercontent.com',provider=new GoogleIdentity({clientIds:[aud],jwks:createLocalJWKSet({keys:[{...jwk,kid:'qa',alg:'RS256'}]})});
 const issue=(claims={})=>new SignJWT({sub:'stable-google-subject',email:'mutable@example.invalid',email_verified:false,nonce,iss:'https://accounts.google.com',aud,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,...claims}).setProtectedHeader({alg:'RS256',kid:'qa'}).sign(privateKey);
 assert.deepEqual(await provider.verify(await issue(),nonce),{provider:'google',issuer:'https://accounts.google.com',subject:'stable-google-subject'});
 for(const claims of [{iss:'https://attacker.invalid'},{aud:'other.apps.googleusercontent.com'},{nonce:'different'},{exp:1},{azp:'attacker.apps.googleusercontent.com'},{iat:Math.floor(Date.now()/1000)+600}])await assert.rejects(()=>issue(claims).then(t=>provider.verify(t,nonce)),e=>e.code==='identity_proof_rejected');
 const attacker=await generateKeyPair('RS256');const forged=await new SignJWT({nonce,sub:'victim'}).setProtectedHeader({alg:'RS256',kid:'qa'}).setIssuer('https://accounts.google.com').setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(attacker.privateKey);await assert.rejects(()=>provider.verify(forged,nonce));
 await assert.rejects(()=>new GoogleIdentity().verify('anything',nonce),e=>e.code==='identity_not_configured');
});
async function fixture(){const c=new PGlite();await adminFixture(c);await c.exec(`create table public.svitlo_profiles(id uuid primary key default gen_random_uuid(),owner uuid);alter table public.svitlo_profiles enable row level security;
 create table svitlo_sensors.bindings(owner_subject uuid,ended_at timestamptz);alter table svitlo_sensors.bindings enable row level security;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('svitlo.owner_id',true),'')::uuid$$;`);await c.exec(await readFile(new URL('../sql/identity.sql',import.meta.url),'utf8'));return c;}
const hash=()=>randomBytes(32).toString('hex');
async function guest(c){await c.exec('reset role');const owner=randomUUID(),session=hash();await c.query('insert into auth.users(id) values($1)',[owner]);await c.query("insert into svitlo_vps.sessions values($1,$2,now()+interval '30 days')",[session,owner]);return {owner,session};}
async function challenge(c,session,mode='sign_in'){const nonce=hash();await c.exec('set role svitlo_stage_session');assert.equal((await c.query('select svitlo_identity.challenge($1,$2,$3) value',[session,nonce,mode])).rows[0].value,true);return nonce;}
const finish=async(c,session,nonce,sub='google-user')=>(await c.query('select svitlo_identity.finish($1,$2,$3,$4,$5) value',[session,nonce,sub,hash(),hash()])).rows[0].value;
test('guest links in place; a new installation recovers the same internal UUID; nonce reuse and direct SQL access fail',async()=>{
 const c=await fixture();try{
  const a=await guest(c),nonce=await challenge(c,a.session,'link'),linked=await finish(c,a.session,nonce);assert.equal(linked.state,'authenticated');assert.equal(linked.accountId,a.owner);
  assert.equal((await finish(c,a.session,nonce)).state,'session_required');await assert.rejects(()=>c.query('select * from svitlo_identity.subjects'),e=>e.code==='42501');
  const b=await guest(c),n=await challenge(c,b.session),restored=await finish(c,b.session,n);assert.equal(restored.accountId,a.owner);assert.equal(restored.recoverable,true);
  const d=await guest(c),wrong=await challenge(c,d.session);assert.equal((await finish(c,d.session,hash(),'someone')).state,'challenge_expired');assert.equal((await finish(c,d.session,wrong,'someone')).accountId,d.owner);
 }finally{await c.close();}
});
test('signing into an existing account requires review when guest assets exist; confirmation does not merge profiles, subscriptions or sensor ownership',async()=>{
 const c=await fixture();try{
  const a=await guest(c);await finish(c,a.session,await challenge(c,a.session));
  const b=await guest(c);await c.query('insert into public.svitlo_profiles(owner) values($1)',[b.owner]);await c.query('insert into svitlo_sensors.bindings values($1,null)',[b.owner]);
  const nonce=await challenge(c,b.session),review=hash(),next=hash(),pending=(await c.query('select svitlo_identity.finish($1,$2,$3,$4,$5) value',[b.session,nonce,'google-user',hash(),review])).rows[0].value;
  assert.equal(pending.state,'confirmation_required');assert.equal(pending.guestProfiles,1);assert.equal(pending.ownedSensors,1);assert.equal(pending.mergeSupported,false);
  const result=(await c.query('select svitlo_identity.confirm_switch($1,$2,$3) value',[b.session,review,next])).rows[0].value;assert.equal(result.accountId,a.owner);assert.equal((await c.query('select svitlo_identity.confirm_switch($1,$2,$3) value',[b.session,review,hash()])).rows[0].value.state,'session_required');
  await c.exec('reset role');assert.equal((await c.query('select owner from public.svitlo_profiles')).rows[0].owner,b.owner);assert.equal((await c.query('select owner_subject from svitlo_sensors.bindings')).rows[0].owner_subject,b.owner);
  const d=await guest(c);const link=await challenge(c,d.session,'link');assert.equal((await finish(c,d.session,link)).state,'identity_in_use');
  await c.exec('reset role');await c.query("insert into svitlo_admin.account_blocks values($1,now()+interval '1 hour')",[a.owner]);const e=await guest(c);assert.equal((await finish(c,e.session,await challenge(c,e.session))).state,'account_blocked');
 }finally{await c.close();}
});
