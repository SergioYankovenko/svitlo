import {notificationRequest} from '../api.js';
const url=()=>new URL('push-installation.json',document.baseURI).href;
export async function modernInstallation(owner){try{const r=await (await caches.open('svitlo-installations-v1')).match(url());const value=r&&await r.json();return value?.owner===owner?value:null;}catch{return null;}}
export async function registerModern(subscription,owner){
 const status=await notificationRequest('status',{}, {owner});if(!status.enabled||!status.channels?.webpush)return false;
 const cache=await caches.open('svitlo-installations-v1'),prior=await modernInstallation(owner),installationId=prior?.installationId||crypto.randomUUID(),fingerprint=JSON.stringify([subscription,Notification.permission]),requestId=prior&&!prior.ready&&prior.fingerprint===fingerprint?prior.requestId:crypto.randomUUID();
 // Save the request identity before network; lost ACK retries use the same ID.
 const pending={owner,installationId,requestId,fingerprint,credential:prior?.credential||null};await cache.put(url(),Response.json(pending));
 const result=await notificationRequest('register',{...pending,channel:'webpush',permission:Notification.permission,subscription},{owner});
 await cache.put(url(),Response.json({...pending,credential:result.credential,ready:result.ok===true}));return result.ok===true;
}
export async function revokeModern(owner){const old=await modernInstallation(owner);if(!old?.credential)return false;await notificationRequest('revoke',{installationId:old.installationId,credential:old.credential},{owner});await (await caches.open('svitlo-installations-v1')).delete(url());return true;}
