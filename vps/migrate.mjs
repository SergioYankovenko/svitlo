import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const password=(await readFile('/run/secrets/owner_password','utf8')).trim();
const c=new pg.Client({host:'postgres',user:'svitlo_owner',database:'svitlo_staging',password});
await c.connect();
try{
  await c.query('select pg_advisory_lock(311032026)');
  await c.query('create schema if not exists svitlo_vps; create table if not exists svitlo_vps.migrations(name text primary key,sha256 text not null,applied_at timestamptz not null default now())');
  const migrations=[['000_platform.sql',await readFile('vps/sql/platform.sql','utf8')]];
  for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()){
    let sql=await readFile('supabase/migrations/'+file,'utf8');
    // Keep local maintenance/readiness; exclude Supabase cron/Vault/net bridge and its production URL.
    if(file==='20261027203648_conditional_jobs_maintenance.sql'){
      const end=sql.search(/create (?:or replace )?function svitlo_internal\.dispatch\(\)/i);
      if(end<0)throw Error('Scheduler transform marker missing');sql=sql.slice(0,end);
    }
    migrations.push([file,sql]);
  }
  migrations.push(['999_vps.sql',await readFile('vps/sql/runtime.sql','utf8')]);
  migrations.push(['1000_vps_session_retention.sql',await readFile('vps/sql/session-retention.sql','utf8')]);
  migrations.push(['1001_universal_catalog.sql',await readFile('vps/sql/universal.sql','utf8')]);
  migrations.push(['1002_universal_profile_adoption.sql',await readFile('vps/sql/universal-profile-adoption.sql','utf8')]);
  migrations.push(['1003_catalog_quality.sql',await readFile('vps/sql/catalog-quality.sql','utf8')]);
  migrations.push(['1004_private_telemetry.sql',await readFile('vps/sql/telemetry.sql','utf8')]);
  migrations.push(['1005_sensor_access.sql',await readFile('vps/sql/sensor-access.sql','utf8')]);
  migrations.push(['1006_map_addresses.sql',await readFile('vps/sql/map-addresses.sql','utf8')]);
  for(const [name,sql] of migrations){
    const hash=createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
    const old=(await c.query('select sha256 from svitlo_vps.migrations where name=$1',[name])).rows[0];
    if(old){if(old.sha256!==hash)throw Error('Applied migration changed: '+name);continue;}
    await c.query('begin');try{await c.query(sql);await c.query('insert into svitlo_vps.migrations(name,sha256) values($1,$2)',[name,hash]);await c.query('commit');}
    catch(e){await c.query('rollback');throw e;}
    console.log(JSON.stringify({migration:name,status:'applied'}));
  }
}finally{await c.end();}
