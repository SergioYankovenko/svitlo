import {createHmac,createHash} from 'node:crypto';import {readFileSync,existsSync} from 'node:fs';
import {PurchaseVault} from '../billing/vault.js';import {validSubscription} from '../../server/service.js';
const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
export class NotificationService {
 constructor({bridge,key=null,channels={fcm:false,webpush:false}}){Object.assign(this,{bridge,key,channels});this.vault=key?new PurchaseVault(key):null;}
 credential(session,id,requestId){return 'ni_'+createHmac('sha256',Buffer.from(this.key,'hex')).update(['notification-installation-v1',session.owner,session.token,id,requestId].join(':')).digest('base64url');}
 hash(s){return createHash('sha256').update(s).digest('hex');}
 async handle(session,d){
  if(d?.schemaVersion!==1||!['status','register','revoke','receipt'].includes(d.action))throw fail('invalid_notification_request');
  if(d.action==='status')return {schemaVersion:1,configured:!!this.key,channels:this.channels,...(await this.bridge.query('select svitlo_notifications.status() value')).rows[0].value};
  if(!this.vault)throw fail('notifications_not_configured',503);
  if(!uuid(d.installationId))throw fail('invalid_installation_id');
  if(d.action==='register'){
   if(!uuid(d.requestId)||!['fcm','webpush'].includes(d.channel)||!this.channels[d.channel]||!['granted','denied'].includes(d.permission))throw fail('notification_channel_unavailable',409);
   const token=d.channel==='webpush'?JSON.stringify(d.subscription):d.token;
   if(d.channel==='webpush'&&!validSubscription(d.subscription)||d.channel==='fcm'&&(typeof token!=='string'||token.length<20||token.length>4096||/[\s\x00-\x1f]/.test(token)))throw fail('invalid_notification_token');
   const quiet=d.quiet||{startMinute:null,endMinute:null};if(Object.keys(quiet).some(k=>!['startMinute','endMinute'].includes(k))||Object.values(quiet).some(v=>v!==null&&(!Number.isInteger(v)||v<0||v>1439)))throw fail('invalid_quiet_hours');
   const credential=this.credential(session,d.installationId,d.requestId),hash=this.vault.hash('notification:'+token),requestHash=this.hash(JSON.stringify({channel:d.channel,hash,permission:d.permission,quiet}));
   const result=(await this.bridge.query('select svitlo_notifications.register($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) value',[d.installationId,d.requestId,d.channel,hash,this.vault.seal(token,'notification:'+d.installationId),this.hash(credential),d.credential?this.hash(d.credential):'',requestHash,d.permission,JSON.stringify(quiet),d.channel==='webpush'?d.subscription.endpoint:null])).rows[0].value;
   if(result.error)throw fail(result.error,409);return {schemaVersion:1,...result,credential};
  }
  if(typeof d.credential!=='string'||!/^ni_[A-Za-z0-9_-]{43}$/.test(d.credential))throw fail('installation_proof_required',403);
  if(d.action==='receipt'&&(!uuid(d.intentId)||!['received','displayed'].includes(d.state)))throw fail('invalid_notification_receipt');
  return {schemaVersion:1,...(await this.bridge.query('select svitlo_notifications.installation_action($1,$2,$3,$4,$5) value',[d.installationId,this.hash(d.credential),d.action,d.intentId||null,d.state||null])).rows[0].value};
 }
}
export function notificationKey(){const path='/run/notifications/delivery-key';if(!existsSync(path))return null;const key=readFileSync(path,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(key))throw Error('invalid_notification_key');return key;}
