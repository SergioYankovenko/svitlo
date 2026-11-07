import {createHmac,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
// Infrastructure primitive. Domain modules supply independent keys and scopes.
export class SecretVault {
 constructor(key,label){if(!/^[a-f0-9]{64}$/.test(key||'')||!['notifications'].includes(label))throw Error('dedicated_secret_key_required');this.key=Buffer.from(key,'hex');this.label=label;}
 hash(value){return createHmac('sha256',this.key).update(this.label+':token-v1:'+value).digest('hex');}
 seal(value,scope){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(this.label+':'+scope));const data=Buffer.concat([c.update(value,'utf8'),c.final()]);return [iv,c.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');}
 open(cipher,scope){try{const [iv,tag,data]=cipher.split('.').map(x=>Buffer.from(x,'base64url')),d=createDecipheriv('aes-256-gcm',this.key,iv);d.setAAD(Buffer.from(this.label+':'+scope));d.setAuthTag(tag);return Buffer.concat([d.update(data),d.final()]).toString();}catch{throw Object.assign(Error('secret_key_unavailable'),{code:'secret_key_unavailable'});}}
}
