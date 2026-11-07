import {sensorPushTick} from './push.js';
import {runtime} from './runtime.js';
import {runLoggedJob} from '../server/operations.js';
import {catalogProjectorLoop} from './events/worker.js';
import {SearchIndexer} from './search/indexer.js';
import {DictionaryIndexer} from './search/dictionary.js';
import {configuredMeili} from './search/meili.js';
const rt=await runtime('worker');let stopping=false;
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{stopping=true;});
const projector=catalogProjectorLoop(rt.p,{stopping:()=>stopping,onError:code=>console.error(JSON.stringify({event:code}))});
const searchClient=configuredMeili('write'),searchLoop=searchClient?new SearchIndexer({pool:rt.p,client:searchClient,onError:code=>console.error(JSON.stringify({event:code}))}).loop({stopping:()=>stopping}):Promise.resolve();
const dictionaryLoop=searchClient?new DictionaryIndexer({pool:rt.p,client:searchClient}).loop({stopping:()=>stopping,onError:code=>console.error(JSON.stringify({event:code}))}):Promise.resolve();
async function tick(){
  await rt.p.query('update svitlo_vps.worker_cycle set last_attempt=clock_timestamp() where id');
  let historyError=null;
  try{const history=await rt.sourceHistory.runDue();if(history.state!=='not_due'&&history.state!=='disabled')console.log(JSON.stringify({event:'source_history_cycle',...history}));}
  catch(e){historyError=e;console.error(JSON.stringify({event:'source_history_error',code:/^[A-Z0-9_]{1,32}$/i.test(e.code||'')?e.code:'history_error'}));}
  const sensorDelivery=await sensorPushTick(rt);
  const result=await runLoggedJob(rt.db,'jobs',()=>rt.service.jobs());
  await rt.p.query('select svitlo_internal.maintenance($1)',[Date.now()]);
  await rt.p.query('select svitlo_vps.session_cleanup()');
  await rt.p.query('select svitlo_telemetry.cleanup()');
  await rt.p.query('select svitlo_sensors.cleanup()');
  await rt.p.query('select svitlo_sensors.ingest_cleanup()');
  await rt.p.query('select svitlo_sensors.history_cleanup()');
  await rt.p.query('select svitlo_sensors.phone_cleanup()');
  await rt.p.query('select svitlo_sensors.expired_phone_qr_cleanup()');
  await rt.p.query('select svitlo_sources.cleanup()');
  await rt.p.query('select svitlo_admin.cleanup()');
  await rt.p.query('select svitlo_identity.cleanup()');
  await rt.p.query('select svitlo_events.domain_cleanup()');
  if(historyError)throw historyError;
  await rt.p.query('update svitlo_vps.worker_cycle set last_success=clock_timestamp(),error_code=null where id');
  console.log(JSON.stringify({event:'stage_jobs',...result,sensorDelivery,delivery:rt.delivery}));
}
do{const start=Date.now();try{await tick();}catch(e){const code=/^[A-Z0-9_]{1,32}$/i.test(e.code||'')?e.code:'job_error';await rt.p.query('update svitlo_vps.worker_cycle set last_failure=clock_timestamp(),error_code=$1 where id',[code]).catch(()=>{});console.error(JSON.stringify({event:'stage_job_error',code}));}
  if(process.argv.includes('--once'))break;
  // Short interruptible sleeps; every process restart resumes durable DB lease state.
  while(!stopping&&Date.now()-start<60000)await new Promise(r=>setTimeout(r,1000));
}while(!stopping);
stopping=true;await Promise.all([projector,searchLoop,dictionaryLoop]);await rt.p.end();
