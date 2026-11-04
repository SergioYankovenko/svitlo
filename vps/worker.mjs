import {runtime} from './runtime.js';
import {runLoggedJob} from '../server/operations.js';
const rt=await runtime('worker');let stopping=false;
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{stopping=true;});
async function tick(){
  await rt.p.query('update svitlo_vps.worker_cycle set last_attempt=clock_timestamp() where id');
  const result=await runLoggedJob(rt.db,'jobs',()=>rt.service.jobs());
  await rt.p.query('select svitlo_internal.maintenance($1)',[Date.now()]);
  await rt.p.query('select svitlo_vps.session_cleanup()');
  await rt.p.query('select svitlo_telemetry.cleanup()');
  await rt.p.query('select svitlo_sensors.cleanup()');
  await rt.p.query('select svitlo_sensors.ingest_cleanup()');
  await rt.p.query('select svitlo_sensors.history_cleanup()');
  await rt.p.query('select svitlo_sensors.phone_cleanup()');
  await rt.p.query('update svitlo_vps.worker_cycle set last_success=clock_timestamp(),error_code=null where id');
  console.log(JSON.stringify({event:'stage_jobs',...result,delivery:'disabled'}));
}
do{const start=Date.now();try{await tick();}catch(e){const code=/^[A-Z0-9_]{1,32}$/i.test(e.code||'')?e.code:'job_error';await rt.p.query('update svitlo_vps.worker_cycle set last_failure=clock_timestamp(),error_code=$1 where id',[code]).catch(()=>{});console.error(JSON.stringify({event:'stage_job_error',code}));}
  if(process.argv.includes('--once'))break;
  // Short interruptible sleeps; every process restart resumes durable DB lease state.
  while(!stopping&&Date.now()-start<60000)await new Promise(r=>setTimeout(r,1000));
}while(!stopping);
await rt.p.end();
