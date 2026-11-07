import postgres from 'npm:postgres@3.4.7';
import {createClient} from 'npm:@supabase/supabase-js@2.106.1';
const env=(name:string)=>Deno.env.get(name)||'';
const key=env('SVITLO_MIGRATION_BRIDGE_KEY'),url=env('SUPABASE_URL'),db=env('SUPABASE_DB_URL');
const secret=(name:string)=>{const s=env(name).replace(/-----[^-]+-----|\s/g,'');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
const canonical=(v:unknown)=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const bytes=(x:string)=>new TextEncoder().encode(x);
const encode=(b:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=(x:string)=>Uint8Array.from(atob(x.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-x.length%4)%4)),c=>c.charCodeAt(0));
const uuid=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const reply=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const client=db?postgres(db,{max:1,prepare:false,idle_timeout:10,connect_timeout:5}):null;
async function proof(header:string){if(!/^[a-f0-9]{64}$/.test(key)||!/^Bearer [a-f0-9]{64}$/.test(header))return false;const a=bytes(header.slice(7)),b=bytes(key);let mismatch=0;for(let i=0;i<64;i++)mismatch|=a[i]^b[i];return mismatch===0;}
async function packet(req:Request){let size=0;const chunks=[];for await(const chunk of req.body||[]){size+=chunk.byteLength;if(size>24000)throw Error('bounded_request');chunks.push(chunk);}return JSON.parse(await new Blob(chunks).text());}
Deno.serve(async req=>{
 if(req.method!=='POST'||req.headers.has('Origin')||req.headers.has('Cookie')||new URL(req.url).search||!await proof(req.headers.get('Authorization')||''))return reply({code:'source_bridge_unauthorized'},401);
 if(!client||!url||!env('SUPABASE_ANON_KEY')||!env('SVITLO_MIGRATION_SOURCE_SIGNING_KEY')||!env('SVITLO_MIGRATION_TARGET_PUBLIC_KEY'))return reply({code:'source_bridge_not_configured'},503);
 try{
  const p=await packet(req);if(p?.schemaVersion!==1||!['export','freeze','finalize','abort'].includes(p.action)||typeof p.sourceAccessToken!=='string'||p.sourceAccessToken.length>12000)return reply({code:'invalid_source_request'},400);
  const auth=createClient(url,env('SUPABASE_ANON_KEY'),{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}).auth;
  const {data,error}=await auth.getUser(p.sourceAccessToken);if(error||!uuid(data.user?.id))return reply({code:'source_session_invalid'},401);
  const jwt=JSON.parse(new TextDecoder().decode(decode(p.sourceAccessToken.split('.')[1]||''))),subject=data.user!.id,sid=jwt.session_id;
  if(!uuid(sid)||jwt.sub!==subject||(p.subject!==undefined&&p.subject!==subject)||(p.sourceSubject!==undefined&&p.sourceSubject!==subject))return reply({code:'source_session_invalid'},401);
  if(p.action==='export')return reply((await client`select svitlo_migration_source.export_profiles(${subject}::uuid,${sid}::uuid) value`)[0].value);
  if(!uuid(p.nonce)||! /^[a-f0-9]{64}$/.test(p.digest||''))return reply({code:'invalid_source_fence'},400);
  if(p.action==='freeze'){
   if(!uuid(p.targetSubject)||! /^[a-f0-9]{64}$/.test(p.sourceRevision||''))return reply({code:'invalid_source_fence'},400);
   const row=(await client`select svitlo_migration_source.freeze(${subject}::uuid,${sid}::uuid,${p.nonce}::uuid,${p.targetSubject}::uuid,${p.sourceRevision},${p.digest}) value`)[0].value;
   const signer=await crypto.subtle.importKey('pkcs8',secret('SVITLO_MIGRATION_SOURCE_SIGNING_KEY'),'Ed25519',false,['sign']);return reply({...row,signature:encode(await crypto.subtle.sign('Ed25519',signer,bytes(canonical(row))))});
  }
  if(p.action==='finalize'){
   if(! /^[a-f0-9]{64}$/.test(p.receiptHash||''))return reply({code:'invalid_source_receipt'},400);
   return reply({ok:(await client`select svitlo_migration_source.finish(${subject}::uuid,${sid}::uuid,${p.nonce}::uuid,${p.digest},'committed',${p.receiptHash}) value`)[0].value});
  }
  const c=p.cancellation,statement=c?.statement;
  if(!statement||statement.aborted!==true||statement.nonce!==p.nonce||statement.digest!==p.digest||statement.sourceSubject!==subject||!uuid(statement.targetSubject)||typeof c.signature!=='string'||c.signature.length>256)return reply({code:'source_abort_proof_required'},403);
  const verifier=await crypto.subtle.importKey('spki',secret('SVITLO_MIGRATION_TARGET_PUBLIC_KEY'),'Ed25519',false,['verify']);if(!await crypto.subtle.verify('Ed25519',verifier,decode(c.signature),bytes(canonical(statement))))return reply({code:'source_abort_proof_invalid'},403);
  return reply({ok:(await client`select svitlo_migration_source.finish(${subject}::uuid,${sid}::uuid,${p.nonce}::uuid,${p.digest},'aborted',null,${statement.targetSubject}::uuid) value`)[0].value});
 }catch(error){const code=(error as {code?:string})?.code;return reply({code:code==='42501'?'source_session_invalid':code==='55000'||code==='23505'?'source_fence_conflict':'source_bridge_unavailable'},code==='42501'?401:code==='55000'||code==='23505'?409:503);}
});
