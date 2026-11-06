const leaseLost=()=>Object.assign(Error('Job lease no longer valid'),{code:'lease_lost'});
export class DomainJobs {
 constructor(pool){this.pool=pool;}
 async claim(consumer,limit=10){return (await this.pool.query('select svitlo_events.claim_delivery($1,$2,1) value',[consumer,limit])).rows[0].value;}
 async fail(job,reason='handler_error'){return (await this.pool.query('select svitlo_events.fail_delivery($1,$2,$3) value',[job.deliveryId,job.token,reason])).rows[0].value;}
 async database(job,handler){
  const tx=await this.pool.connect();
  try{
   await tx.query('begin');
   if(!(await tx.query('select svitlo_events.lock_delivery($1,$2) value',[job.deliveryId,job.token])).rows[0].value)throw leaseLost();
   const result=await handler({tx,event:job,idempotencyKey:job.eventId+':'+job.consumer});
   if(!(await tx.query('select svitlo_events.finish_delivery($1,$2) value',[job.deliveryId,job.token])).rows[0].value)throw leaseLost();
   await tx.query('commit');return result;
  }catch(e){await tx.query('rollback').catch(()=>{});throw e;}finally{tx.release();}
 }
 async external(job,send,record=async()=>{}){
  // External HTTP is never performed while holding a database transaction.
  // The provider/recipient must use this stable key for duplicate suppression.
  // A crash after send and before ACK can repeat send with the same key.
  if(Date.parse(job.deadline)<=Date.now())throw Object.assign(Error('Expired job'),{code:'deadline_expired'});
  const result=await send({event:job,idempotencyKey:job.eventId+':'+job.consumer});
  return this.database(job,context=>record({...context,result}));
 }
 async run(consumer,handler,{mode='database',limit=10,stopping=()=>false}={}){
  if(!['database','external'].includes(mode))throw Error('invalid_job_mode');
  const claimed=await this.claim(consumer,limit);let completed=0,failed=0;
  for(const job of claimed){if(stopping())break;try{
   await this[mode](job,handler);completed++;
  }catch(e){failed++;await this.fail(job,['dependency_unavailable','invalid_payload','revision_changed'].includes(e.code)?e.code:'handler_error').catch(()=>{});}}
  return {claimed:claimed.length,completed,failed};
 }
}
