import {notificationRequest} from '../api.js';
const url=()=>new URL('push-installation.json',document.baseURI).href;
export async function modernInstallation(owner){try{const r=await (await caches.open('svitlo-installations-v1')).match(url());const value=r&&await r.json();return value?.owner===owner?value:null;}catch{return null;}}
export async function registerModern(subscription,owner){
 const prior=await modernInstallation(owner);let status;
 // A pending attempt may have committed while its response was lost.
 // Avoid legacy registration for that endpoint until reconciled.
 try{status=await notificationRequest('status',{}, {owner});}catch(error){if(error.status===404&&!prior)return false;throw error;}
 if(!status.configured||!status.enabled||!status.channels?.webpush){if(prior)throw Error('Сповіщення тимчасово недоступні');return false;}
 const cache=await caches.open('svitlo-installations-v1'),installationId=prior?.installationId||crypto.randomUUID(),fingerprint=JSON.stringify([subscription,Notification.permission]),requestId=prior&&!prior.ready&&prior.fingerprint===fingerprint?prior.requestId:crypto.randomUUID();
 // Save the request identity before network; lost ACK retries use the same ID.
 const pending={owner,installationId,requestId,fingerprint,credential:prior?.credential||null};await cache.put(url(),Response.json(pending));
 const result=await notificationRequest('register',{installationId,requestId,credential:pending.credential,channel:'webpush',permission:Notification.permission,subscription},{owner});
 if(result.ok!==true||!/^ni_[A-Za-z0-9_-]{43}$/.test(result.credential||''))throw Error('Сповіщення тимчасово недоступні');
 await cache.put(url(),Response.json({...pending,credential:result.credential,ready:true}));return true;
}
export async function revokeModern(owner){const old=await modernInstallation(owner);if(!old?.credential)return false;await notificationRequest('revoke',{installationId:old.installationId,credential:old.credential},{owner});await (await caches.open('svitlo-installations-v1')).delete(url());return true;}
