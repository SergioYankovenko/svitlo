import {runtime} from '../runtime.js';import {DiscoveryCollector} from './collector.mjs';
if(process.env.DISCOVERY_ENABLED!=='true')throw Error('Discovery collector is not enabled');
const rt=await runtime('worker'),collector=new DiscoveryCollector(rt);let stopping=false;
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stopping=true;});
try{do{try{const result=await collector.runDue();if(!['not_due','idle','daily_limit'].includes(result.state))console.log(JSON.stringify({event:'address_discovery',...result}));}catch(e){console.error(JSON.stringify({event:'address_discovery_error',code:/^[A-Z0-9_]{1,32}$/i.test(e.code||'')?e.code:'collector_error'}));}if(process.argv.includes('--once'))break;const until=Date.now()+15000;while(!stopping&&Date.now()<until)await new Promise(r=>setTimeout(r,500));}while(!stopping);}finally{await rt.p.end();}
