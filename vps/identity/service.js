import {createHash,randomBytes} from 'node:crypto';import {identityError} from './google.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(p,fields)=>{if(!p||Array.isArray(p)||typeof p!=='object'||p.schemaVersion!==1||Object.keys(p).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(p,k)))throw identityError(400,'invalid_identity_packet');};
export class IdentityService {
 constructor({pool,provider,sessions}){Object.assign(this,{pool,provider,sessions});}
 async call(sql,args){return (await this.pool.query(sql,args)).rows[0].value;}
 async handle(session,p){
  if(!session)throw identityError(401,'session_required');const proof=hash(session.token);
  if(p.action==='status'){exact(p,['schemaVersion','action']);return {schemaVersion:1,configured:this.provider.configured,account:await this.call('select svitlo_identity.status($1) value',[proof])};}
  if(!this.provider.configured)throw identityError(503,'identity_not_configured');
  if(p.action==='challenge'){
   exact(p,['schemaVersion','action','mode']);if(!['sign_in','link'].includes(p.mode))throw identityError(400,'invalid_identity_packet');const nonce=randomBytes(32).toString('base64url');
   if(!await this.call('select svitlo_identity.challenge($1,$2,$3) value',[proof,hash(nonce),p.mode]))throw identityError(429,'identity_challenge_limit');
   return {schemaVersion:1,nonce,expiresInSeconds:300,serverClientId:this.provider.clientIds[0]};
  }
  const token=randomBytes(32).toString('hex');let result;
  if(p.action==='complete'){
   exact(p,['schemaVersion','action','nonce','idToken']);if(typeof p.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.nonce))throw identityError(400,'invalid_identity_packet');
   if(!await this.call('select svitlo_identity.challenge_valid($1,$2) value',[proof,hash(p.nonce)]))throw identityError(401,'identity_challenge_expired');
   const identity=await this.provider.verify(p.idToken,p.nonce),reviewToken=randomBytes(32).toString('base64url');
   result=await this.call('select svitlo_identity.finish($1,$2,$3,$4,$5) value',[proof,hash(p.nonce),identity.subject,hash(token),hash(reviewToken)]);
   if(result.state==='confirmation_required')return {schemaVersion:1,...result,reviewToken,expiresInSeconds:300};
  }else if(p.action==='confirm_switch'){
   exact(p,['schemaVersion','action','reviewToken','confirmed']);if(p.confirmed!==true||typeof p.reviewToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.reviewToken))throw identityError(400,'identity_confirmation_required');
   result=await this.call('select svitlo_identity.confirm_switch($1,$2,$3) value',[proof,hash(p.reviewToken),hash(token)]);
  }else throw identityError(400,'invalid_identity_action');
  if(result.state!=='authenticated')throw identityError(result.state==='account_blocked'?403:409,'identity_'+result.state);
  const next={token,owner:result.accountId,expiresAt:Date.now()+2592000000,csrf:this.sessions.csrf(token)};
  return {schemaVersion:1,state:'authenticated',account:{accountId:next.owner,recoverable:true},session:this.sessions.public(next),setCookie:this.sessions.cookie(token)};
 }
}
