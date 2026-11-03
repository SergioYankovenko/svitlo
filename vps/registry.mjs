import {runtime} from './runtime.js';
import {syncRegistry} from '../server/queue-registry.js';
import {pdfPages} from '../server/pdf-pages.js';
import {providerTransport} from '../server/provider-transport.js';
import {operatorFetch} from './operator-fetch.js';
import {runLoggedJob} from '../server/operations.js';
const rt=await runtime('worker'),lock=await rt.p.connect();let acquired=false;
try{
 acquired=(await lock.query('select pg_try_advisory_lock(311032027) as granted')).rows[0].granted;
 if(acquired){const result=await runLoggedJob(rt.db,'registry',()=>syncRegistry({db:rt.db,pdfPages,fetcher:providerTransport(rt.db,operatorFetch)}));console.log(JSON.stringify({event:'stage_registry',...result}));}
 else console.log(JSON.stringify({event:'stage_registry',status:'busy'}));
}finally{if(acquired)await lock.query('select pg_advisory_unlock(311032027)');lock.release();await rt.p.end();}
