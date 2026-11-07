import {importPKCS8,SignJWT,createRemoteJWKSet,jwtVerify} from 'jose';import {readFileSync,existsSync} from 'node:fs';
export const billingError=(code,status=503)=>Object.assign(Error('Перевірка підписки тимчасово недоступна'),{code,status});
export async function boundedJson(response,max=1000000){let size=0;const chunks=[];for await(const c of response.body||[]){size+=c.byteLength;if(size>max)throw billingError('billing_response_too_large');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks));}catch{throw billingError('invalid_billing_response');}}
const states=new Set(['SUBSCRIPTION_STATE_PENDING','SUBSCRIPTION_STATE_ACTIVE','SUBSCRIPTION_STATE_PAUSED','SUBSCRIPTION_STATE_IN_GRACE_PERIOD','SUBSCRIPTION_STATE_ON_HOLD','SUBSCRIPTION_STATE_CANCELED','SUBSCRIPTION_STATE_EXPIRED','SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED']);
export function projectSubscription(value,{productId,products,expectedAccountId,now=Date.now(),mode='disabled'}={}){
 if(!value||value.kind!=='androidpublisher#subscriptionPurchaseV2'||!states.has(value.subscriptionState)||!Array.isArray(value.lineItems)||!value.lineItems.length||value.lineItems.length>10||value.lineItems.some(x=>!products.includes(x.productId))||!value.lineItems.some(x=>x.productId===productId)||value.externalAccountIdentifiers?.obfuscatedExternalAccountId!==expectedAccountId||!['ACKNOWLEDGEMENT_STATE_PENDING','ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'].includes(value.acknowledgementState))throw billingError('purchase_verification_rejected',422);
 if(value.testPurchase!==undefined&&(!value.testPurchase||typeof value.testPurchase!=='object'||Array.isArray(value.testPurchase)))throw billingError('invalid_billing_response');
 const testing=value.testPurchase!==undefined;if(mode!=='live'&&!(mode==='license'&&testing))throw billingError('non_test_purchase_rejected',422);
 const active=['SUBSCRIPTION_STATE_ACTIVE','SUBSCRIPTION_STATE_IN_GRACE_PERIOD','SUBSCRIPTION_STATE_CANCELED'].includes(value.subscriptionState),expires=value.lineItems.filter(x=>x.productId===productId).map(x=>Date.parse(x.expiryTime));
 if(active&&expires.some(x=>!Number.isFinite(x)))throw billingError('invalid_billing_expiry');
 const known=expires.filter(Number.isFinite),validUntil=known.length?Math.max(...known):now;
 if(validUntil>now+5*366*86400000)throw billingError('invalid_billing_expiry');
 if(value.linkedPurchaseToken!==undefined&&(typeof value.linkedPurchaseToken!=='string'||value.linkedPurchaseToken.length<8||value.linkedPurchaseToken.length>4096))throw billingError('invalid_billing_response');
 return {state:value.subscriptionState,active:active&&expires.some(x=>x>now),validUntil:new Date(validUntil).toISOString(),testing,needsAcknowledgement:active&&expires.some(x=>x>now)&&value.acknowledgementState==='ACKNOWLEDGEMENT_STATE_PENDING',linkedToken:value.linkedPurchaseToken||null};
}
export class GooglePlay {
 constructor({packageName='',products=[],serviceAccount=null,fetcher=fetch,now=Date.now}={}){
  if(packageName&&!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,8}$/.test(packageName)||products.some(p=>typeof p!=='string'||!/^[a-z0-9][a-z0-9._]{0,99}$/.test(p)))throw Error('Invalid Play configuration');
  Object.assign(this,{packageName,products,serviceAccount,fetcher,now});this.cached=null;this.refresh=null;
 }
 get configured(){return !!(this.packageName&&this.products.length&&this.serviceAccount?.client_email?.endsWith('.gserviceaccount.com')&&this.serviceAccount?.private_key);}
 async accessToken(){
  if(!this.configured)throw billingError('billing_not_configured');if(this.cached?.until>this.now()+60000)return this.cached.token;
  if(!this.refresh)this.refresh=(async()=>{const key=await importPKCS8(this.serviceAccount.private_key,'RS256'),assertion=await new SignJWT({scope:'https://www.googleapis.com/auth/androidpublisher'}).setProtectedHeader({alg:'RS256'}).setIssuer(this.serviceAccount.client_email).setAudience('https://oauth2.googleapis.com/token').setIssuedAt(Math.floor(this.now()/1000)).setExpirationTime(Math.floor(this.now()/1000)+3600).sign(key);
   let response;try{response=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});}catch{throw billingError('billing_auth_unavailable');}
   const value=await boundedJson(response,10000);if(!response.ok||typeof value.access_token!=='string'||value.access_token.length>4096||value.token_type!=='Bearer'||!Number.isInteger(value.expires_in)||value.expires_in<120||value.expires_in>7200)throw billingError('billing_auth_rejected');this.cached={token:value.access_token,until:this.now()+value.expires_in*1000};return value.access_token;
  })().finally(()=>{this.refresh=null;});return this.refresh;
 }
 async request(path,{method='GET',body}={}){
  const token=await this.accessToken();let response;try{response=await this.fetcher('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'+encodeURIComponent(this.packageName)+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw billingError('billing_provider_unavailable');}
  if(!response.ok){await response.body?.cancel();throw billingError(response.status===404?'purchase_not_found':'billing_provider_unavailable',response.status===404?422:503);}
  return response.status===204?null:boundedJson(response);
 }
 token(value){if(typeof value!=='string'||value.length<8||value.length>4096||/[\x00-\x20\x7f]/.test(value))throw billingError('invalid_purchase_token',400);return encodeURIComponent(value);}
 lookup({token}){return this.request('/purchases/subscriptionsv2/tokens/'+this.token(token));}
 acknowledge({token,productId}){if(!this.products.includes(productId))throw billingError('invalid_billing_product',400);return this.request('/purchases/subscriptions/'+encodeURIComponent(productId)+'/tokens/'+this.token(token)+':acknowledge',{method:'POST',body:{}});}
}
export class PubSubProof {
 constructor({audience='',email='',subscription='',jwks=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{timeoutDuration:5000})}={}){Object.assign(this,{audience,email,subscription,jwks});}
 get configured(){return this.audience.startsWith('https://')&&this.email.endsWith('.gserviceaccount.com')&&/^projects\/[a-z0-9-]+\/subscriptions\/[A-Za-z0-9._~-]+$/.test(this.subscription);}
 async verify(header){if(!this.configured)throw billingError('rtdn_not_configured');if(typeof header!=='string'||!/^Bearer [A-Za-z0-9_.-]{20,12000}$/.test(header))throw billingError('rtdn_unauthorized',401);
  try{const {payload:p}=await jwtVerify(header.slice(7),this.jwks,{algorithms:['RS256'],issuer:['https://accounts.google.com','accounts.google.com'],audience:this.audience,maxTokenAge:'65m',clockTolerance:5});if(p.email!==this.email||p.email_verified!==true)throw Error();return true;}catch{throw billingError('rtdn_unauthorized',401);}
 }
}
export function configuredPlay(){const file='/run/billing/google-service-account.json';let serviceAccount=null;try{if(existsSync(file))serviceAccount=JSON.parse(readFileSync(file,'utf8'));}catch{throw Error('Invalid Google service account configuration');}return new GooglePlay({packageName:process.env.GOOGLE_PLAY_PACKAGE||'',products:(process.env.GOOGLE_PLAY_PRODUCTS||'').split(',').filter(Boolean),serviceAccount});}
