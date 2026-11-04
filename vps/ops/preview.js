import {verify} from 'node:crypto';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function migrationPreview(envelope,{publicKey,sourceSubject,targetSubject,targetOrigin,lookup,usedNonces=new Set(),now=Date.now()}){
 const reject=()=>{throw Error('migration_preview_rejected');};
 if(!envelope||Object.keys(envelope).sort().join()!=['payload','signature'].sort().join()||typeof envelope.payload!=='string'||envelope.payload.length>32768||typeof envelope.signature!=='string')reject();
 if(!verify(null,Buffer.from(envelope.payload),publicKey,Buffer.from(envelope.signature,'base64url')))reject();
 let p;try{p=JSON.parse(envelope.payload);}catch{reject();}
 if(Object.keys(p).sort().join()!==['version','sourceSubject','targetSubject','targetOrigin','nonce','issuedAt','expiresAt','profiles'].sort().join()||p.version!==1||p.sourceSubject!==sourceSubject||p.targetSubject!==targetSubject||p.targetOrigin!==targetOrigin||!uuid.test(p.nonce)||usedNonces.has(p.nonce)||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now||p.expiresAt<=now||p.expiresAt-p.issuedAt>900000||!Array.isArray(p.profiles)||p.profiles.length>10)reject();
 const seen=new Set();
 const profiles=p.profiles.map(x=>{
  if(!x||Object.keys(x).sort().join()!==['legacyId','name','address','preferences'].sort().join()||typeof x.legacyId!=='string'||x.legacyId.length>120||seen.has(x.legacyId)||typeof x.name!=='string'||x.name.length>120||!x.address||typeof x.address!=='object'||Array.isArray(x.address)||!x.preferences||typeof x.preferences!=='object'||Array.isArray(x.preferences)||JSON.stringify(x).length>4000)reject();
  // Schema adapter validates preference/address fields at final write; preview is data only.
  if(Object.keys(x.address).some(k=>/owner|sensor|token|password|proof/i.test(k))||Object.keys(x.preferences).some(k=>/owner|sensor|token|password|proof/i.test(k)))reject();
  seen.add(x.legacyId);const match=lookup(x.address);
  return {legacyId:x.legacyId,name:x.name,address:x.address,preferences:x.preferences,status:match?.status||'unresolved',canonicalAddressId:match?.id||null,lines:match?.lines||[]};
 });
 return {version:1,dryRun:true,nonce:p.nonce,profiles,importEnabled:false,unresolved:profiles.filter(x=>x.status!=='resolved').length,sensorOwnershipImported:false};
}
