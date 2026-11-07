import {readFileSync,existsSync} from 'node:fs';
async function boundedJson(response,max){let size=0;const chunks=[];for await(const c of response.body||[]){size+=c.byteLength;if(size>max)throw Error('fcm_response_too_large');chunks.push(c);}return JSON.parse(Buffer.concat(chunks));}
// Separate OAuth scope and credentials from Play billing. No arbitrary URLs.
export class FcmChannel {
 constructor({projectId='',serviceAccount=null,fetcher=fetch,now=Date.now}={}){Object.assign(this,{projectId,serviceAccount,fetcher,now});this.cached=null;this.refresh=null;}
 get configured(){return /^[a-z][a-z0-9-]{4,62}$/.test(this.projectId)&&this.serviceAccount?.project_id===this.projectId&&!!this.serviceAccount?.private_key;}
 async accessToken(){
  // GooglePlay's fixed OAuth implementation is deliberately not reused: it
  // requests androidpublisher. The messaging implementation owns its scope.
  if(!this.configured)throw Error('fcm_not_configured');
  if(this.cached?.until>this.now()+60000)return this.cached.token;
  if(!this.refresh)this.refresh=(async()=>{
   const {SignJWT,importPKCS8}=await import('jose'),key=await importPKCS8(this.serviceAccount.private_key,'RS256');
   const assertion=await new SignJWT({scope:'https://www.googleapis.com/auth/firebase.messaging'}).setProtectedHeader({alg:'RS256'}).setIssuer(this.serviceAccount.client_email).setAudience('https://oauth2.googleapis.com/token').setIssuedAt(Math.floor(this.now()/1000)).setExpirationTime(Math.floor(this.now()/1000)+3600).sign(key);
   const r=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})}),v=await boundedJson(r,10000);
   if(!r.ok||typeof v.access_token!=='string'||v.access_token.length>4096||v.token_type!=='Bearer'||!Number.isInteger(v.expires_in)||v.expires_in<120||v.expires_in>7200)throw Error('fcm_auth_unavailable');this.cached={token:v.access_token,until:this.now()+v.expires_in*1000};return v.access_token;
  })().finally(()=>{this.refresh=null;});return this.refresh;
 }
 async send(token,payload,{ttl=60}={}){
  const auth=await this.accessToken();const response=await this.fetcher('https://fcm.googleapis.com/v1/projects/'+this.projectId+'/messages:send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify({message:{token,data:Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,String(v)])),android:{priority:'normal',ttl:Math.max(1,Math.min(3600,ttl))+'s',collapse_key:payload.profileId}}})});
  const value=await boundedJson(response,10000);if(!response.ok){const invalid=value.error?.details?.some(d=>d.errorCode==='UNREGISTERED');throw Object.assign(Error('fcm_send_failed'),{permanent:invalid});}if(typeof value.name!=='string')throw Error('fcm_invalid_receipt');return {accepted:true};
 }
}
export function configuredFcm(){const path='/run/notifications/fcm-service-account.json';return new FcmChannel({projectId:process.env.FIREBASE_PROJECT_ID||'',serviceAccount:existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null});}
