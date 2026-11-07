import {readFileSync,existsSync} from 'node:fs';import {verify} from 'node:crypto';
import {SupabaseMigrationSource} from './source.js';import {MigrationService} from './service.js';import {canonicalJson} from '../planning/service.js';import {boundedJson} from '../billing/google-play.js';
class SourceBridge {
 constructor(config){this.config=config;}
 async call(action,fields){const r=await fetch(this.config.url+'/functions/v1/svitlo-migration-v1',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+this.config.bridgeKey,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,action,...fields})});if(!r.ok)throw Object.assign(Error('migration_source_unavailable'),{status:503});return boundedJson(r,256000);}
 export(subject){return this.call('export',{subject});}
 async freeze(proof){const result=await this.call('freeze',proof),{signature,...payload}=result;if(typeof signature!=='string'||!verify(null,Buffer.from(canonicalJson(payload)),this.config.sourcePublicKey,Buffer.from(signature,'base64url'))||payload.digest!==proof.digest||payload.sourceSubject!==proof.sourceSubject||payload.targetSubject!==proof.targetSubject)throw Error('source_fence_signature_invalid');return result;}
 finalize(fields){return this.call('finalize',fields);}
}
export function configuredMigration(rt,targetOrigin){
 const path='/run/migration/config.json',config=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{},source=new SupabaseMigrationSource({...config,bridge:config.bridgeKey?new SourceBridge(config):null});
 return new MigrationService({bridge:rt.bridge,source,targetOrigin,privateKey:config.privateKey||null,publicKey:config.publicKey||null,mapper:async legacy=>{
  try{const lookup=await rt.ports.catalog.legacy(Object.fromEntries(['department','cityId','streetId','house'].map(k=>[k,legacy[k]])));if(!lookup.address?.id)return {status:'unresolved'};
   const resolution=await rt.ports.catalog.resolve({addressId:lookup.address.id});if(!resolution.resolution?.complete)return {status:'unresolved'};
   const address=await rt.service.canonicalAddress({addressId:lookup.address.id,expandLines:true});return {status:'resolved',addresses:address._lineAddresses||[address]};
  }catch{return {status:'unresolved'};}
 }});
}
