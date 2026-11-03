import pg from 'pg';
import {readFile} from 'node:fs/promises';
const c=new pg.Client({host:'postgres',database:'svitlo_staging',user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});
const rows=JSON.parse(await readFile('/seed/rows.json','utf8')),registry=JSON.parse(await readFile('/seed/registry-state.json','utf8'));
if(rows.length!==17940||new Set(rows.map(r=>JSON.stringify([r.department,r.city_id,r.street_id,r.house]))).size!==17940)throw Error('Catalog count/key mismatch');
await c.connect();
try{
 await c.query('begin');await c.query('select pg_advisory_xact_lock(26102618)');
 const key='branch18-20261026-864180d7d543';
 const b=(await c.query(`insert into public.svitlo_address_queue_batches(import_key,department,expected_total,expected_numeric,expected_exclusions,expected_service,checksum_md5,reviewed_at,metadata)
 values($1,'18',17940,16741,1191,8,'864180d7d54394ed0620b58a40f1dd2b','2026-10-26T14:37:20.588Z','{"scope":"public-data-staging-copy","estimated_count":331,"preserve_primary_operator_queue":true}')
 on conflict(import_key) do update set import_key=excluded.import_key returning id`,[key])).rows[0];
 const cols=['department','city_id','street_id','house','city','street','status','queue','is_estimate','confidence','evidence'];
 for(let i=0;i<rows.length;i+=250){const values=[];const tuples=rows.slice(i,i+250).map(row=>'('+[b.id,...cols.map(k=>k==='evidence'?JSON.stringify(row[k]):row[k])].map(v=>{values.push(v??null);return '$'+values.length;}).join(',')+')');
  await c.query(`insert into public.svitlo_address_queues(batch_id,${cols}) values ${tuples} on conflict(batch_id,department,city_id,street_id,house) do nothing`,values);
 }
 const counts=(await c.query(`select count(*)::int as total,count(*) filter(where status='numeric')::int as numeric,count(*) filter(where status='not_in_queue')::int as excluded,
 md5(string_agg(concat_ws(chr(31),department,city_id,street_id,house,status,coalesce(queue,''),is_estimate::text,coalesce(confidence,'')),chr(10) order by department collate "C",city_id collate "C",street_id collate "C",house collate "C")) as checksum from public.svitlo_address_queues where batch_id=$1`,[b.id])).rows[0];
 if(counts.total!==17940||counts.numeric!==16741||counts.excluded!==1191||counts.checksum!=='864180d7d54394ed0620b58a40f1dd2b')throw Error('Seed verification failed');
 await c.query("update public.svitlo_address_queue_batches set status='active',activated_at=coalesce(activated_at,now()) where id=$1",[b.id]);
 for(const v of registry.versions){await c.query(`insert into public.svitlo_queue_versions(id,valid_from,valid_until,checked_at,active,payload) values($1,$2,$3,$4,$5,$6)
 on conflict(id) do nothing`,[v.id,v.valid_from,v.valid_until,v.checked_at,v.active,JSON.stringify(v.payload)]);}
 for(let i=0;i<registry.rules.length;i+=250)await c.query(`insert into public.svitlo_queue_rules(version_id,ordinal,city,street,scope,queue,evidence)
 select version_id,ordinal,city,street,scope,queue,evidence from jsonb_to_recordset($1::jsonb)
 as r(version_id text,ordinal integer,city text,street text,scope text,queue text,evidence jsonb) on conflict(version_id,ordinal) do nothing`,[JSON.stringify(registry.rules.slice(i,i+250))]);
 await c.query("insert into public.svitlo_cache(key,value) values('queue-registry-state',$1) on conflict(key) do nothing",[JSON.stringify(registry.state)]);
 await c.query('commit');console.log(JSON.stringify({seed:'public-catalog',...counts,productionUsersImported:0}));
}catch(e){await c.query('rollback');throw e;}finally{await c.end();}
