// The claim, projection receipt and retry state survive process restarts.
// This consumer does no network I/O: it coalesces catalogue changes into a
// durable search inbox. External indexing is a separate bounded consumer.
export async function projectCatalogChanges(pool,{stopping=()=>false}={}){
 await pool.query("select svitlo_events.cycle('attempt',0)");
 const {rows}=await pool.query('select id,token from svitlo_events.claim($1)',[20]);
 let completed=0,failed=0;
 for(const job of rows){
  if(stopping())break; // Unfinished claims are reclaimed after their lease.
  try{const r=await pool.query('select svitlo_events.complete($1,$2) accepted',[job.id,job.token]);if(r.rows[0].accepted)completed++;}
  catch{failed++;await pool.query('select svitlo_events.fail($1,$2,$3)',[job.id,job.token,'worker_error']).catch(()=>{});}
 }
 await pool.query('select svitlo_events.cleanup()');
 await pool.query('select svitlo_events.cycle($1,$2)',[failed?'failure':'ok',completed]);
 return {claimed:rows.length,completed,failed};
}

export async function catalogProjectorLoop(pool,{stopping=()=>false,onError=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 let failures=0;
 while(!stopping()){
  try{await projectCatalogChanges(pool,{stopping});failures=0;}catch{if(failures===0)onError('catalog_projector_error');failures++;}
  // Bounded retry, without a log or DB storm during an outage. Sleeps remain
  // interruptible so a deployment does not wait for the entire backoff period.
  const delay=failures?Math.min(60000,1000*2**Math.min(failures,6)):1000;
  for(let waited=0;!stopping()&&waited<delay;waited+=1000)await sleep(1000);
 }
}
