import {runtime} from './runtime.js';
import {runLoggedJob} from '../server/operations.js';
const rt=await runtime('worker');let stopping=false;
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{stopping=true;});
async function tick(){
  const result=await runLoggedJob(rt.db,'jobs',()=>rt.service.jobs());
  await rt.p.query('select svitlo_internal.maintenance($1)',[Date.now()]);
  await rt.p.query('select svitlo_vps.session_cleanup()');
  await rt.p.query('select svitlo_telemetry.cleanup()');
  console.log(JSON.stringify({event:'stage_jobs',...result,delivery:'disabled'}));
}
do{const start=Date.now();try{await tick();}catch(e){console.error(JSON.stringify({event:'stage_job_error',code:e.code||'job_error'}));}
  if(process.argv.includes('--once'))break;
  // Short interruptible sleeps; every process restart resumes durable DB lease state.
  while(!stopping&&Date.now()-start<60000)await new Promise(r=>setTimeout(r,1000));
}while(!stopping);
await rt.p.end();
