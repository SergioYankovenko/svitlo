import {readFileSync,existsSync} from 'node:fs';import {billingError,PubSubProof} from './google-play.js';import {PurchaseVault} from './vault.js';
const exact=(p,keys)=>{if(!p||Array.isArray(p)||typeof p!=='object'||p.schemaVersion!==1||Object.keys(p).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(p,k)))throw billingError('invalid_billing_packet',400);};
export function configuredVault(){const file='/run/billing/purchase-key';return existsSync(file)?new PurchaseVault(readFileSync(file,'utf8').trim()):null;}
export class BillingService {
 constructor({bridge,vault,products=[],packageName='',pushProof=new PubSubProof()}={}){Object.assign(this,{bridge,vault,products,packageName,pushProof});}
 async readiness(){return (await this.bridge.query('select svitlo_billing.ready() value')).rows[0].value;}
 async handle(owner,p){
  if(!owner)throw billingError('session_required',401);
  if(p.action==='status'){exact(p,['schemaVersion','action']);return {schemaVersion:1,...await this.readiness(),entitlement:(await this.bridge.query('select svitlo_entitlements.current() value')).rows[0].value.entitlement};}
  const readiness=await this.readiness();if(!this.vault||!readiness.ready||!readiness.accepting)throw billingError('billing_not_configured');
  if(p.action==='checkout'){exact(p,['schemaVersion','action']);if(!(await this.bridge.query('select svitlo_billing.checkout_allowed() value')).rows[0].value)throw billingError('recoverable_account_required',409);return {schemaVersion:1,provider:'google_play',packageName:this.packageName,productIds:this.products,obfuscatedAccountId:this.vault.account(owner)};}
  if(p.action!=='verify')throw billingError('invalid_billing_action',400);exact(p,['schemaVersion','action','productId','purchaseToken']);
  if(!this.products.includes(p.productId)||typeof p.purchaseToken!=='string'||p.purchaseToken.length<8||p.purchaseToken.length>4096||/[\x00-\x20\x7f]/.test(p.purchaseToken))throw billingError('invalid_purchase_packet',400);
  const tokenHash=this.vault.hash(p.purchaseToken),value=(await this.bridge.query('select svitlo_billing.register_purchase($1,$2,$3) value',[tokenHash,this.vault.seal(p.purchaseToken,tokenHash),p.productId])).rows[0].value;
  if(value.state!=='pending_verification')throw billingError('billing_'+value.state,value.state==='not_configured'?503:value.state==='purchase_registration_limit'?429:409);return {schemaVersion:1,...value};
 }
 async rtdn(header,envelope){
  if(!this.vault)throw billingError('billing_not_configured');await this.pushProof.verify(header);
  const m=envelope?.message;if(!m||typeof m.messageId!=='string'||!m.messageId||m.messageId.length>200||typeof m.data!=='string'||m.data.length>16000||!/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)||envelope.subscription!==this.pushProof.subscription)throw billingError('invalid_rtdn',400);
  let value;try{value=JSON.parse(Buffer.from(m.data,'base64').toString('utf8'));}catch{throw billingError('invalid_rtdn',400);}
  if(value.packageName!==this.packageName||typeof value.eventTimeMillis!=='string'||!/^\d{10,16}$/.test(value.eventTimeMillis))throw billingError('invalid_rtdn',400);
  const stamp=Number(value.eventTimeMillis);if(!Number.isSafeInteger(stamp)||!Number.isFinite(new Date(stamp).getTime())||stamp>Date.now()+300000)throw billingError('invalid_rtdn',400);
  const n=value.subscriptionNotification||value.voidedPurchaseNotification,kind=value.testNotification?'test':value.subscriptionNotification?'subscription':value.voidedPurchaseNotification?'voided':null;
  if(!kind||kind!=='test'&&(typeof n?.purchaseToken!=='string'||n.purchaseToken.length<8||n.purchaseToken.length>4096))throw billingError('invalid_rtdn',400);
  await this.bridge.query('select svitlo_billing.accept_rtdn($1,$2,$3,$4::timestamptz)',[m.messageId,kind==='test'?null:this.vault.hash(n.purchaseToken),kind,new Date(stamp).toISOString()]);return {accepted:true};
 }
}
