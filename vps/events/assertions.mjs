import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function verifyOutbox(c){
 let checks=0;const ok=(v,label)=>{assert.ok(v,label);checks++;};
 const query=(sql,args=[])=>c.query(sql,args),count=async()=>Number((await query('select count(*) n from svitlo_events.jobs')).rows[0].n);
 const id=randomUUID();
 await query('begin');await query("insert into svitlo_vps.catalog(id,label) values($1,'Synthetic home')",[id]);
 ok(await count()===1,'write and event share a transaction');await query('rollback');ok(await count()===0,'rollback leaves no event');
 await query("insert into svitlo_vps.catalog(id,label) values($1,'Synthetic home')",[id]);
 await query("update svitlo_vps.catalog set metadata='{\"sourceCheckedAt\":42}' where id=$1",[id]);
 ok(await count()===1,'timestamp-only source refresh produces no redundant search work');
 await query("update svitlo_vps.catalog set label='Renamed home' where id=$1",[id]);ok(await count()===2,'rename produces a durable event');
 const claim=async()=>{await query('set role svitlo_stage_worker');try{return (await query('select * from svitlo_events.claim(20)')).rows;}finally{await query('reset role');}};
 const jobs=await claim();ok(jobs.length===2,'worker can claim');ok((await claim()).length===0,'unexpired jobs cannot be claimed twice');
 ok(!(await query('select svitlo_events.complete($1,$2) accepted',[jobs[0].id,randomUUID()])).rows[0].accepted,'wrong token denied');
 await query('update svitlo_events.jobs set lease_until=clock_timestamp()-interval \'1 second\' where id=$1',[jobs[0].id]);
 ok(!(await query('select svitlo_events.complete($1,$2) accepted',[jobs[0].id,jobs[0].token])).rows[0].accepted,'expired worker fenced');
 const reclaimed=(await claim())[0];ok(reclaimed.id===jobs[0].id&&reclaimed.token!==jobs[0].token&&reclaimed.attempts===2,'restart reclaims expired lease with new proof');
 // Complete newer change before older change; the receipt may not regress.
 await query('select svitlo_events.complete($1,$2)',[jobs[1].id,jobs[1].token]);
 await query('select svitlo_events.complete($1,$2)',[reclaimed.id,reclaimed.token]);
 const dirty=(await query('select * from svitlo_events.catalog_dirty where entity_id=$1',[id])).rows[0];
 ok(String(dirty.version)===String(jobs[1].version),'out-of-order completion keeps newest projection version');
 ok(!(await query('select svitlo_events.complete($1,$2) accepted',[reclaimed.id,reclaimed.token])).rows[0].accepted,'repeated acknowledgement has no second effect');
 await query('delete from svitlo_vps.catalog where id=$1',[id]);let poison=(await claim())[0];
 for(let attempt=1;attempt<=5;attempt++){
  await query('select svitlo_events.fail($1,$2,$3)',[poison.id,poison.token,'sensitive upstream error']);
  const row=(await query('select * from svitlo_events.jobs where id=$1',[poison.id])).rows[0];
  ok(row.error_code==='worker_error'&&(attempt<5?row.state==='ready'&&new Date(row.available_at)>new Date():row.state==='dead'),'bounded retry with redacted error '+attempt);
  if(attempt<5){await query('update svitlo_events.jobs set available_at=clock_timestamp()-interval \'1 second\' where id=$1',[poison.id]);poison=(await claim())[0];}
 }
 await query("insert into svitlo_vps.catalog(id,label) values(gen_random_uuid(),'Synthetic final crash')");
 const finalCrash=(await claim())[0];
 await query("update svitlo_events.jobs set attempts=5,lease_until=clock_timestamp()-interval '1 second' where id=$1",[finalCrash.id]);
 await claim();ok((await query('select state from svitlo_events.jobs where id=$1',[finalCrash.id])).rows[0].state==='dead','crashed final attempt is inspectable, not stranded');
 // APIs cannot read global jobs or execute control functions.
 await query('set role svitlo_stage_api');
 try{await assert.rejects(()=>query('select * from svitlo_events.jobs'),e=>e.code==='42501');checks++;
  await assert.rejects(()=>query('select svitlo_events.claim(1)'),e=>e.code==='42501');checks++;
 }finally{await query('reset role');}
 await query("update svitlo_events.jobs set finished_at=clock_timestamp()-interval '8 days' where state='done'");
 await query('select svitlo_events.cleanup()');ok(await count()===2,'bounded cleanup retains failed jobs for inspection');
 return checks;
}
