// Private operator command. No public diagnostics or arbitrary SQL endpoint.
import pg from 'pg';import {readFile} from 'node:fs/promises';import {clusterProgress} from './progress.mjs';
const args=process.argv.slice(2);let clusterCode=null,all=false;
for(let i=0;i<args.length;i++){if(args[i]==='--all')all=true;else if(args[i]==='--cluster'&&/^UA[0-9]{17}$/.test(args[i+1]||''))clusterCode=args[++i];else throw Error('Usage: report.mjs [--all] [--cluster KATOTTG_CODE]');}
const c=new pg.Client({host:process.env.PGHOST||'postgres',database:process.env.PGDATABASE||'svitlo_staging',user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim(),options:'-c statement_timeout=10000'});await c.connect();
const scope="($1::text is null or a.code=$1 or a.region_code=$1 or a.district_code=$1 or a.community_code=$1)";
try{
 const policy=(await c.query('select * from svitlo_discovery.policy')).rows[0],state=(await c.query('select * from svitlo_discovery.state')).rows[0];
 const progress=await clusterProgress(c,{clusterCode});
 const jobs=(await c.query(`select j.kind,count(*)::int total,count(*) filter(where j.completed_at is not null)::int completed,count(*) filter(where j.last_error is not null)::int with_error from svitlo_discovery.jobs j join svitlo_geo.places a on a.code=coalesce(j.settlement_code,j.cluster_code) where ${scope} group by j.kind order by j.kind`,[clusterCode])).rows;
 const outcomes=(await c.query(`select e.outcome,e.basis,count(distinct (e.route_id,e.subject_key))::int source_references,sum(e.observations)::int observations from svitlo_discovery.events e join svitlo_geo.places a on a.code=coalesce(e.settlement_code,e.cluster_code) where ${scope} group by e.outcome,e.basis order by e.outcome,e.basis`,[clusterCode])).rows;
 const examples=(await c.query(`select e.first_seen_at,e.last_seen_at,e.cluster_code,e.settlement_code,r.operator_id,r.branch_id,r.branch_name,r.provider_city_name,e.street_key,e.street_name,e.house,e.outcome,e.basis,e.source_checked_at,e.detail from svitlo_discovery.events e join svitlo_geo.routes r on r.id=e.route_id join svitlo_geo.places a on a.code=coalesce(e.settlement_code,e.cluster_code) where ${scope} ${all?'':"and e.outcome not in ('streets_listed','houses_listed','queue_confirmed','queue_not_in_schedule')"} order by e.last_seen_at desc,e.id limit 100`,[clusterCode])).rows;
 console.log(JSON.stringify({schemaVersion:1,scope:'public_provider_diagnostics',policy,state,clusterProgress:progress,jobs,outcomes,examples,noRepairsPerformed:true},null,2));
}finally{await c.end();}
