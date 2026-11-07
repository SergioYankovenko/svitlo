import {readFileSync} from 'node:fs';import {verify,createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import {SupabaseMigrationSource} from './source.js';import {MigrationService} from './service.js';import {canonicalJson} from '../planning/service.js';import {boundedJson} from '../billing/google-play.js';
class SourceBridge {
 constructor(config){this.config=config;}
 async call(action,fields){const r=await fetch(this.config.url+'/functions/v1/svitlo-migration-v1',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+this.config.bridgeKey,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,action,...fields})});if(!r.ok)throw Object.assign(Error('migration_source_unavailable'),{status:503});return boundedJson(r,256000);}
 export(subject,sourceAccessToken){return this.call('export',{subject,sourceAccessToken});}
 async freeze(proof,sourceAccessToken){const result=await this.call('freeze',{...proof,sourceAccessToken}),{signature,...payload}=result;if(typeof signature!=='string'||!verify(null,Buffer.from(canonicalJson(payload)),this.config.sourcePublicKey,Buffer.from(signature,'base64url'))||payload.digest!==proof.digest||payload.sourceSubject!==proof.sourceSubject||payload.targetSubject!==proof.targetSubject)throw Error('source_fence_signature_invalid');return result;}
 finalize({nonce,digest,receipt},sourceAccessToken){return this.call('finalize',{nonce,digest,receiptHash:createHash('sha256').update(canonicalJson(receipt)).digest('hex'),sourceAccessToken});}
 abort(fields,sourceAccessToken){return this.call('abort',{...fields,sourceAccessToken});}
}
export function configuredMigration(rt,targetOrigin){
 const config=readConfiguration(),source=new SupabaseMigrationSource({...config,bridge:config.bridgeKey?new SourceBridge(config):null});
 targetOrigin=config.targetOrigin||targetOrigin;
 return new MigrationService({bridge:rt.bridge,source,targetOrigin,privateKey:config.privateKey||null,publicKey:config.publicKey||null,mapper:async legacy=>{
  try{const lookup=await rt.ports.catalog.legacy(Object.fromEntries(['department','cityId','streetId','house'].map(k=>[k,legacy[k]])));if(!lookup.address?.id)return {status:'unresolved'};
   const resolution=await rt.ports.catalog.resolve({addressId:lookup.address.id});if(!resolution.resolution?.complete)return {status:'unresolved'};
   const address=await rt.service.canonicalAddress({addressId:lookup.address.id,expandLines:true});return {status:'resolved',addresses:address._lineAddresses||[address]};
  }catch{return {status:'unresolved'};}
 }});
}

function readConfiguration(){
 try{
  const config=JSON.parse(readFileSync('/run/migration/config.json','utf8'));
  const origin=new URL(config.targetOrigin);
  if(origin.protocol!=='https:'||config.targetOrigin!==origin.origin||!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url)||!/^[a-f0-9]{64}$/.test(config.bridgeKey)||typeof config.publishableKey!=='string'||!config.publishableKey)return {};
  const privateKey=createPrivateKey(config.privateKey),publicKey=createPublicKey(config.publicKey),sourcePublicKey=createPublicKey(config.sourcePublicKey),spki={type:'spki',format:'der'};
  if([privateKey,publicKey,sourcePublicKey].some(k=>k.asymmetricKeyType!=='ed25519')||!createPublicKey(privateKey).export(spki).equals(publicKey.export(spki))||sourcePublicKey.export(spki).equals(publicKey.export(spki)))return {};
  return {...config,privateKey,publicKey,sourcePublicKey};
 }catch{return {};}
}
