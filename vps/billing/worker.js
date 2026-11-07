import {DomainJobs} from '../events/domain-jobs.js';import {port} from '../modules/ports.js';import {projectSubscription,billingError} from './google-play.js';
export class BillingWorker {
 constructor({pool,provider,vault,onError=()=>{}}){Object.assign(this,{pool,provider,vault,onError});this.billing=port('BillingProvider',provider);this.jobs=new DomainJobs(pool);}
 async call(sql,args){return (await this.pool.query(sql,args)).rows[0].value;}
 async tick(){
  const ready=await this.call('select svitlo_billing.worker_status($1) value',[!!this.vault&&this.provider.configured]);if(!ready.ready)return {state:'disabled'};
  await this.call('select svitlo_billing.schedule_due() value');let completed=0;
  for(const consumer of ['billing-reconcile-v1','billing-acknowledge-v1'])for(const job of await this.jobs.claim(consumer,2)){
   let purchase;try{
    purchase=await this.call('select svitlo_billing.claim_purchase($1) value',[job.payload.purchaseId]);if(!purchase)throw billingError('dependency_unavailable');
    const token=this.vault.open(purchase.cipher,purchase.tokenHash),raw=await this.billing.lookup({token});
    const result=projectSubscription(raw,{productId:purchase.productId,products:this.provider.products,expectedAccountId:this.vault.account(purchase.accountId),mode:ready.mode});
    if(consumer==='billing-reconcile-v1')await this.jobs.database(job,async({tx})=>{
     const ok=(await tx.query('select svitlo_billing.apply_purchase($1,$2,$3,$4,$5,$6,$7,$8) value',[purchase.id,purchase.proof,result.state,result.validUntil,result.active,result.testing,result.needsAcknowledgement,result.linkedToken?this.vault.hash(result.linkedToken):null])).rows[0].value;
     if(!ok)throw billingError('revision_changed');
    });
    else{
     // Rights were committed before this separate durable acknowledgement job.
     // A lost ACK queries the current provider state before retrying the send.
     if(result.needsAcknowledgement&&!purchase.replaced)await this.billing.acknowledge({token,productId:purchase.productId});
     await this.jobs.database(job,async()=>{});
    }
    completed++;
   }catch(e){await this.jobs.fail(job,['dependency_unavailable','revision_changed'].includes(e.code)?e.code:e.status===422?'invalid_payload':'handler_error').catch(()=>{});this.onError(['purchase_verification_rejected','non_test_purchase_rejected','purchase_key_unavailable'].includes(e.code)?e.code:'billing_reconciliation_failed');}
   finally{if(purchase)await this.call('select svitlo_billing.release_purchase($1,$2) value',[purchase.id,purchase.proof]).catch(()=>{});}
  }
  return {state:completed?'progress':'idle',completed};
 }
 async loop({stopping=()=>false}={}){
  if(!this.vault||!this.provider.configured){await this.call('select svitlo_billing.worker_status(false) value').catch(()=>{});return;}
  while(!stopping()){let disabled=false;try{disabled=(await this.tick()).state==='disabled';}catch{this.onError('billing_worker_failed');}const until=Date.now()+(disabled?30000:1000);while(!stopping()&&Date.now()<until)await new Promise(r=>setTimeout(r,1000));}
 }
}
