import {COLLECTOR_SOURCES} from './regional-sources.mjs';
import {initializeRegionalSources,importRegionalRoutes} from './regional-import.mjs';
const safeCode=e=>typeof e.code==='string'&&/^[a-z0-9_]{1,64}$/.test(e.code)?e.code:e.name==='TimeoutError'?'timeout':'source_unavailable';
export async function refreshRegionalSources(c,source,{operators=Object.keys(COLLECTOR_SOURCES),pages=12,onProgress=()=>{},now=Date.now}={}){
 if(!Number.isInteger(pages)||pages<1||pages>100||operators.some(op=>!Object.hasOwn(COLLECTOR_SOURCES,op)))throw Error('Invalid regional refresh scope');
 await initializeRegionalSources(c);const result=[];
 for(const op of operators){
  const state=(await c.query('select * from svitlo_discovery.regional_sources where operator_id=$1',[op])).rows[0];if(!state.enabled||new Date(state.next_at).getTime()>now()){result.push({operator:op,status:'not_due'});continue;}
  let checkpoint=state.checkpoint||{},summary={routes:0,mapped:0,ambiguous:0,jobsSeeded:0},complete=false;
  await c.query('update svitlo_discovery.regional_sources set last_attempt_at=clock_timestamp() where operator_id=$1',[op]);
  try{
   if(!checkpoint.branches){
    const directory=await source.directory(op);if(directory.limitation)throw Object.assign(Error('Search is not a full enumeration API'),{code:'public_directory_search_only'});
    if(directory.branches){checkpoint={branches:directory.branches,offset:0};}
    else{if(!directory.complete||!directory.items?.length)throw Object.assign(Error('Incomplete source directory'),{code:'invalid_source'});summary=await importRegionalRoutes(c,op,directory.items);complete=true;}
   }
   if(checkpoint.branches){
    if(!Array.isArray(checkpoint.branches)||checkpoint.branches.length>100||!Number.isSafeInteger(checkpoint.offset)||checkpoint.offset<0||checkpoint.offset>checkpoint.branches.length)throw Error('Invalid directory checkpoint');
    for(let n=0;n<pages&&checkpoint.offset<checkpoint.branches.length;n++){
     const branch=checkpoint.branches[checkpoint.offset],directory=await source.directory(op,{branch:branch.key});
     if(!directory.complete||!Array.isArray(directory.items))throw Object.assign(Error('Invalid branch directory'),{code:'invalid_source'});
     if(directory.items.length){const imported=await importRegionalRoutes(c,op,directory.items,{branch:branch.key,branchName:branch.name});for(const k of Object.keys(summary))summary[k]+=imported[k]||0;}
     checkpoint.offset++;onProgress({operator:op,branchPagesChecked:checkpoint.offset,branchPagesTotal:checkpoint.branches.length,...summary});
     await c.query("update svitlo_discovery.regional_sources set checkpoint=$2,status='partial',directory_complete=false where operator_id=$1",[op,checkpoint]);
    }complete=checkpoint.offset===checkpoint.branches.length;
   }
   const stats=(await c.query(`select count(*)::int routes,count(*) filter(where exists(select 1 from svitlo_geo.route_places l where l.route_id=r.id))::int mapped from svitlo_geo.routes r where r.operator_id=$1 and active`,[op])).rows[0];
   if(complete&&!stats.routes)throw Object.assign(Error('Empty regional directory'),{code:'invalid_source'});
   const publicSummary={...stats,branchPagesChecked:checkpoint.offset||null,branchPagesTotal:checkpoint.branches?.length||null,queueLookup:COLLECTOR_SOURCES[op].family==='dtek'?'provider_address':'not_queried'};
   await c.query(`update svitlo_discovery.regional_sources set status=$2,directory_complete=$3,last_success_at=clock_timestamp(),next_at=clock_timestamp()+make_interval(secs=>$4),checkpoint=$5,summary=$6,error_code=null where operator_id=$1`,[op,complete?'available':'partial',complete,complete?21600:60,complete?{}:checkpoint,publicSummary]);
   await c.query("update svitlo_vps.operators set state='available' where id=$1 and config->>'collectorOnly'='true'",[op]);result.push({operator:op,status:complete?'available':'partial',...publicSummary});
  }catch(e){const code=safeCode(e),needsFeed=['public_directory_access_required','public_directory_search_only','source_format_unsupported','mapping_review_required'].includes(code),status=code==='forbidden'?'forbidden':needsFeed?'needs_feed':code.startsWith('invalid')?'invalid_source':'unavailable';
   await c.query(`update svitlo_discovery.regional_sources set status=$2,error_code=$3,directory_complete=false,next_at=clock_timestamp()+make_interval(secs=>$4),checkpoint=$5 where operator_id=$1`,[op,status,code,status==='forbidden'||needsFeed?21600:900,checkpoint]);
   await c.query("update svitlo_vps.operators set state='degraded' where id=$1 and config->>'collectorOnly'='true'",[op]);result.push({operator:op,status,error:code});
  }
 }return result;
}
