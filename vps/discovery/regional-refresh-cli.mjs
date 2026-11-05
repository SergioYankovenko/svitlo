// Separate owner maintenance command, fixed public feeds, no user/private writes.
import pg from 'pg';import {readFile} from 'node:fs/promises';
import {RegionalDiscoverySources,COLLECTOR_SOURCES} from './regional-sources.mjs';
import {refreshRegionalSources} from './regional-refresh.mjs';
const args=process.argv.slice(2);let pages=12,operators=Object.keys(COLLECTOR_SOURCES);
for(let i=0;i<args.length;i++){if(args[i]==='--operator'&&COLLECTOR_SOURCES[args[i+1]])operators=[args[++i]];else if(args[i]==='--pages'&&/^(?:[1-9][0-9]?|100)$/.test(args[i+1]||''))pages=Number(args[++i]);else throw Error('Usage: regional-refresh-cli.mjs [--operator reviewed_operator] [--pages 1..100]');}
if(process.env.PGDATABASE!=='svitlo_staging'&&!/^svitlo_.*_qa_[0-9]+$/.test(process.env.PGDATABASE||''))throw Error('Test database required');
const c=new pg.Client({host:process.env.PGHOST||'postgres',database:process.env.PGDATABASE,user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim(),options:'-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=30000'});await c.connect();
const source=new RegionalDiscoverySources({gate:async op=>{const until=Date.now()+6000;while(true){const r=(await c.query('select svitlo_regions.acquire($1) result',[op])).rows[0].result;if(r.granted)return r.ticket;if(r.reason==='cooldown'||Date.now()>=until)throw Object.assign(Error('Source transport waiting'),{code:r.code==='forbidden'?'forbidden':'rate_limited'});await new Promise(r=>setTimeout(r,250));}},finish:async(op,ticket,v)=>{await c.query('select svitlo_regions.finish($1,$2,$3,$4,$5)',[op,ticket,v.status,v.error,v.retry]);}});
try{console.log(JSON.stringify({event:'regional_source_refresh',results:await refreshRegionalSources(c,source,{operators,pages,onProgress:r=>console.log(JSON.stringify({event:'regional_source_directory_page',...r}))})}));}finally{await c.end();}
