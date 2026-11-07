import {createHmac,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
export class PurchaseVault {
 constructor(key){if(!/^[a-f0-9]{64}$/.test(key||''))throw Error('Dedicated purchase key required');this.key=Buffer.from(key,'hex');}
 hash(token){return createHmac('sha256',this.key).update('play-purchase-v1:'+token).digest('hex');}
 account(owner){return createHmac('sha256',this.key).update('play-account-v1:'+owner).digest('hex');}
 seal(token,scope){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from('purchase:'+scope));const data=Buffer.concat([c.update(token,'utf8'),c.final()]);return [iv,c.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');}
 open(cipher,scope){try{const [iv,tag,data]=cipher.split('.').map(x=>Buffer.from(x,'base64url')),d=createDecipheriv('aes-256-gcm',this.key,iv);d.setAAD(Buffer.from('purchase:'+scope));d.setAuthTag(tag);return Buffer.concat([d.update(data),d.final()]).toString();}catch{throw Object.assign(Error('Purchase key unavailable'),{code:'purchase_key_unavailable'});}}
}
