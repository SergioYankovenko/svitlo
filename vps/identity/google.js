import {createRemoteJWKSet,jwtVerify} from 'jose';
export const identityError=(status,code)=>Object.assign(Error('Не вдалося підтвердити вхід'),{status,code});
export class GoogleIdentity {
 constructor({clientIds=[],authorizedParties=[],jwks=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{timeoutDuration:5000,cooldownDuration:30000})}={}){
  if(clientIds.some(x=>typeof x!=='string'||!x.endsWith('.apps.googleusercontent.com')))throw Error('Invalid Google audience configuration');
  Object.assign(this,{clientIds,authorizedParties,jwks});
 }
 get configured(){return this.clientIds.length>0;}
 async verify(token,nonce){
  if(!this.configured)throw identityError(503,'identity_not_configured');
  if(typeof token!=='string'||token.length>12000||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(nonce))throw identityError(400,'invalid_identity_packet');
  try{const {payload:p}=await jwtVerify(token,this.jwks,{algorithms:['RS256'],issuer:['https://accounts.google.com','accounts.google.com'],audience:this.clientIds,clockTolerance:5,maxTokenAge:'10m'});
   if(typeof p.sub!=='string'||!p.sub||p.sub.length>255||p.nonce!==nonce||!Number.isInteger(p.exp)||p.exp<=Date.now()/1000||typeof p.iat!=='number'||p.iat>Date.now()/1000+5||Array.isArray(p.aud)&&p.aud.length>1&&!p.azp||p.azp!==undefined&&!this.authorizedParties.concat(this.clientIds).includes(p.azp))throw Error();
   return {provider:'google',issuer:'https://accounts.google.com',subject:p.sub};
  }catch{throw identityError(401,'identity_proof_rejected');}
 }
}
export const configuredGoogle=()=>new GoogleIdentity({clientIds:(process.env.GOOGLE_WEB_CLIENT_IDS||'').split(',').filter(Boolean),authorizedParties:(process.env.GOOGLE_ANDROID_CLIENT_IDS||'').split(',').filter(Boolean)});
