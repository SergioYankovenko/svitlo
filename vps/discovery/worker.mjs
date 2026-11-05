import {runtime} from '../runtime.js';
import {DiscoveryCollector} from './collector.mjs';
if(process.env.DISCOVERY_ENABLED!=='true')throw Error('Discovery collector is not enabled');
const rt=await runtime('worker');
// This pipeline owns one lease and runs serially; leave worker connections for
// the interactive scheduler, source history, and isolated deployment checks.
rt.p.options.max=1;
const collector=new DiscoveryCollector(rt);
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;});
try{
 do{
  let waitMs=1000;
  try{
   const result=await collector.runDue();
   waitMs=Number.isFinite(result.waitMs)?result.waitMs:1000;
   if(!['not_due','idle','daily_limit','busy','sources_waiting','disabled'].includes(result.state))console.log(JSON.stringify({event:'address_discovery',...result}));
  }catch(e){
   waitMs=15000;
   console.error(JSON.stringify({event:'address_discovery_error',code:/^[A-Z0-9_]{1,32}$/i.test(e.code||'')?e.code:'collector_error'}));
  }
  if(process.argv.includes('--once'))break;
  const until=Date.now()+Math.max(250,Math.min(30000,waitMs));
  while(!stopping&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,Math.min(500,Math.max(1,until-Date.now()))));
 }while(!stopping);
}finally{await rt.p.end();}
