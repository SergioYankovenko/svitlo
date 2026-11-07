import {createClient} from '@supabase/supabase-js';
// The source URL/key are server configuration, never request parameters.
// getUser performs a fresh authentication request; decoded JWT claims alone
// are insufficient. No source token or service key is saved in the envelope.
export class SupabaseMigrationSource {
 constructor({url='',publishableKey='',bridge=null,clientFactory=createClient}={}){
  if(url&&!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url))throw Error('invalid_source_origin');
  Object.assign(this,{url,publishableKey,bridge,clientFactory});
 }
 get configured(){return !!(this.url&&this.publishableKey&&this.bridge);}
 async authenticate(token){if(!this.configured)throw Object.assign(Error('migration_not_configured'),{status:503});if(typeof token!=='string'||token.length>12000||token.length<30)throw Object.assign(Error('old_session_required'),{status:403,code:'old_session_required'});const client=this.clientFactory(this.url,this.publishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init={})=>fetch(input,{...init,redirect:'error',signal:AbortSignal.any([init.signal,AbortSignal.timeout(8000)].filter(Boolean))})}});const {data,error}=await client.auth.getUser(token);if(error||!data?.user?.id)throw Object.assign(Error('old_session_invalid'),{status:403,code:'old_session_invalid'});return {subject:data.user.id};}
 export(subject,sourceAccessToken){return this.bridge.export(subject,sourceAccessToken);}
 freeze(proof,sourceAccessToken){return this.bridge.freeze(proof,sourceAccessToken);}
 finalize(proof,sourceAccessToken){return this.bridge.finalize(proof,sourceAccessToken);}
 abort(proof,sourceAccessToken){return this.bridge.abort(proof,sourceAccessToken);}
}
