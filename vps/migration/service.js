import {sign,verify,createHash,randomUUID} from 'node:crypto';import {canonicalJson} from '../planning/service.js';
const hash=v=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
export class MigrationService {
 constructor({bridge,source,mapper,privateKey=null,publicKey=null,targetOrigin,now=Date.now}){Object.assign(this,{bridge,source,mapper,privateKey,publicKey,targetOrigin,now});}
 get configured(){return !!(this.privateKey&&this.publicKey&&this.source?.configured);}
 async handle(session,d){
  if(d?.schemaVersion!==1||!['status','preview','commit'].includes(d.action))throw fail('invalid_migration_request',400);
  const status=(await this.bridge.query('select svitlo_migration.status() value')).rows[0].value;
  if(d.action==='status')return {schemaVersion:1,configured:this.configured,...status};
  if(!this.configured||d.action==='preview'&&!status.allowed)throw fail('migration_not_enabled',503);
  const old=await this.source.authenticate(d.sourceAccessToken);
  if(d.action==='preview'){
   const exported=await this.source.export(old.subject,d.sourceAccessToken);if(!Array.isArray(exported.profiles)||exported.profiles.length>10||typeof exported.revision!=='string'||exported.revision.length>128)throw fail('invalid_source_export',422);
   const profiles=[];for(const p of exported.profiles){if(typeof p.id!=='string'||typeof p.name!=='string'||p.name.length>80||!p.address||!p.preferences)throw fail('invalid_source_export',422);
    // Mapper is server-owned and validates exact canonical ID plus all confirmed
    // line identities. Client names/coordinates never resolve electrical lines.
    const mapping=await this.mapper(p.address);profiles.push({legacyId:p.id,name:p.name,preferences:p.preferences,status:mapping.status,addresses:mapping.status==='resolved'?mapping.addresses:[]});}
   const payload={schemaVersion:1,nonce:randomUUID(),sourceSubject:old.subject,targetSubject:session.owner,targetOrigin:this.targetOrigin,issuedAt:this.now(),expiresAt:this.now()+900000,sourceRevision:exported.revision,profiles};
   const encoded=canonicalJson(payload);if(Buffer.byteLength(encoded)>256000)throw fail('migration_export_too_large',413);
   const envelope={payload:encoded,signature:sign(null,Buffer.from(encoded),this.privateKey).toString('base64url')};
   await this.bridge.query('select svitlo_migration.prepare($1,$2,$3,$4,$5)',[payload.nonce,old.subject,hash(payload),encoded,new Date(payload.expiresAt).toISOString()]);
   return {schemaVersion:1,envelope,preview:profiles.map(p=>({...p,addresses:p.addresses.map(a=>({canonicalAddressId:a.canonicalAddressId,lineId:a.lineId,operatorId:a.operatorId,label:a.label}))})),sourceBackup:exported.profiles,sensorOwnershipImported:false};
  }
  if(d.backupSaved!==true||typeof d.envelope?.payload!=='string'||d.envelope.payload.length>256000||typeof d.envelope.signature!=='string'||d.envelope.signature.length>256)throw fail('migration_backup_and_envelope_required',400);
  let p;try{if(!verify(null,Buffer.from(d.envelope.payload),this.publicKey,Buffer.from(d.envelope.signature,'base64url')))throw Error();p=JSON.parse(d.envelope.payload);}catch{throw fail('migration_envelope_invalid',403);}
  if(!p||p.schemaVersion!==1||p.sourceSubject!==old.subject||p.targetSubject!==session.owner||p.targetOrigin!==this.targetOrigin||p.issuedAt>this.now()||p.expiresAt-p.issuedAt!==900000)throw fail('migration_envelope_expired_or_wrong_target',403);
  const digest=hash(p),readReceipt=async()=>(await this.bridge.query('select svitlo_migration.receipt($1,$2) value',[p.nonce,digest])).rows[0].value;
  const finalize=async result=>{await this.source.finalize({nonce:p.nonce,digest,receipt:result},d.sourceAccessToken).catch(()=>{});return {schemaVersion:1,...result};};
  const abort=async()=>{const durable=(await this.bridge.query('select svitlo_migration.abort_transfer($1,$2) value',[p.nonce,digest])).rows[0].value;if(!durable)return false;
   const statement={aborted:true,nonce:p.nonce,digest,sourceSubject:old.subject,targetSubject:session.owner};
   await this.source.abort({nonce:p.nonce,digest,cancellation:{statement,signature:sign(null,Buffer.from(canonicalJson(statement)),this.privateKey).toString('base64url')}},d.sourceAccessToken).catch(()=>{});return true;};
  const prior=await readReceipt();if(prior?.aborted){await abort();throw fail('migration_transfer_aborted');}if(prior?.ok)return finalize(prior);
  if(p.expiresAt<=this.now()||!status.allowed){await abort();throw fail('migration_envelope_expired_or_wrong_target',403);}
  if(p.profiles.some(p=>p.status!=='resolved'))throw fail('unresolved_mappings_require_review');
  const current=await this.source.export(old.subject,d.sourceAccessToken);if(current.revision!==p.sourceRevision)throw fail('source_changed_preview_required');
  // A source bridge MUST atomically compare its revision and establish a durable
  // per-subject profiles writer fence. A successful GET is never such a proof.
  const fence=await this.source.freeze({nonce:p.nonce,sourceSubject:old.subject,targetSubject:session.owner,sourceRevision:p.sourceRevision,digest},d.sourceAccessToken);
  if(fence?.fenced!==true||fence.nonce!==p.nonce||fence.revision!==p.sourceRevision)throw fail('source_writer_not_fenced');
  try{
   const result=(await this.bridge.query('select svitlo_migration.commit($1,$2,$3) value',[p.nonce,digest,JSON.stringify(fence)])).rows[0].value;
   if(result?.error)throw fail(result.error);if(!result?.ok)throw fail('target_commit_unconfirmed',503);return finalize(result);
  }catch(error){
   // Receipt takes precedence after a lost COMMIT response. Cancellation only
   // crosses to the source after the target nonce is durably unable to commit.
   const committed=await readReceipt();if(committed?.ok)return finalize(committed);
   if(await abort())throw fail('migration_target_rejected');throw error;
  }
 }
}
