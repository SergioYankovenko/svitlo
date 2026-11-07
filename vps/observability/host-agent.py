"""Root-owned minute snapshot for private staging. Never reads process env/secrets."""
from pathlib import Path
import argparse,datetime,json,os,subprocess,urllib.request

EVENTS={'request_failed','stage_job_error','source_history_error','notification_worker_failed','notification_delivery_failed','catalog_projector_failed','dictionary_index_failed','search_index_failed'}
def public_log(line,service):
 try:
  value=json.loads(line);event=value.get('event')
  if event not in EVENTS:return None
  status=value.get('status');duration=value.get('ms')
  return {'service':service,'event':event,'status':status if type(status) is int and 100<=status<=599 else None,'duration_ms':duration if type(duration) is int and 0<=duration<=300000 else None}
 except (ValueError,TypeError):return None

def collect(run=subprocess.check_output):
 def command(args):return run(args,text=True,timeout=12).strip()
 def sql(query):return command(['docker','exec','svitlo-postgres-1','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','svitlo_owner','-d','svitlo_staging','-Atc',query])
 data={};root=Path('/opt/svitlo/staging')
 try:
  m=json.loads((root/'active-release.json').read_text());data['release']=('ok',{k:m[k] for k in ['release','sourceCommit','image','activeSlot'] if k in m})
 except (OSError,ValueError):data['release']=('failed',{})
 disk=os.statvfs('/');free=disk.f_bavail*disk.f_frsize;total=disk.f_blocks*disk.f_frsize;data['disk']=('ok' if free/total>.15 and free>10*1024**3 else 'degraded',{'freeBytes':free,'totalBytes':total})
 memory={line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:','MemAvailable:'))};data['memory']=('ok' if memory['MemAvailable']>384*1024**2 else 'degraded',memory)
 backup=Path('/var/lib/svitlo-stage/latest-backup')
 try:
  file=Path(backup.read_text().strip());age=max(0,int(datetime.datetime.now().timestamp()-file.stat().st_mtime));data['backup']=('ok' if age<7*3600 else 'failed',{'localBackupAgeSeconds':age,'offsiteRestoreVerified':False})
 except OSError:data['backup']=('failed',{})
 try:
  db=json.loads(sql("select json_build_object('connections',(select count(*) from pg_stat_activity),'version',current_setting('server_version'),'statStatementsLoaded',position('pg_stat_statements' in current_setting('shared_preload_libraries'))>0,'deadlocks',(select sum(deadlocks) from pg_stat_database),'oldestTransactionSeconds',(select coalesce(max(extract(epoch from clock_timestamp()-xact_start)),0)::int from pg_stat_activity where xact_start is not null));"));data['database']=('ok' if db['oldestTransactionSeconds']<60 else 'degraded',db)
  wal=json.loads(sql("select json_build_object('archiveMode',current_setting('archive_mode'),'failedCount',failed_count,'lastArchivedAt',last_archived_time,'lastFailureAt',last_failed_time,'walBytes',(select coalesce(sum(size),0) from pg_ls_waldir())) from pg_stat_archiver;"));data['wal']=('not_configured' if wal['archiveMode']!='on' else 'failed' if wal['lastFailureAt'] and (not wal['lastArchivedAt'] or wal['lastFailureAt']>wal['lastArchivedAt']) else 'ok',wal)
 except (OSError,subprocess.SubprocessError,ValueError):data['database']=('failed',{});data['wal']=('unknown',{})
 try:
  with urllib.request.urlopen('http://127.0.0.1:19999/api/v1/info',timeout=3) as r:agent=json.load(r)
  data['netdata']=('ok',{'version':str(agent.get('version',''))[:30]})
 except (OSError,ValueError):data['netdata']=('not_configured',{})
 data['independent_monitor']=('not_configured',{'externalHostConfigured':False})
 logs=[]
 for name,service in [('svitlo-stage-api-a-1','api'),('svitlo-stage-api-b-1','api'),('svitlo-stage-worker-1','worker'),('svitlo-stage-discovery-1','discovery'),('svitlo-admin-console-1','admin')]:
  try:
   raw=subprocess.run(['docker','logs','--since','55s','--tail','100',name],capture_output=True,text=True,timeout=5)
   for line in (raw.stdout+'\n'+raw.stderr).splitlines():
    log=public_log(line,service)
    if log:logs.append(log)
  except (OSError,subprocess.SubprocessError):pass
 return data,logs[:100]

def main():
 if os.geteuid()!=0:raise RuntimeError('root local staging agent required')
 data,logs=collect();statements=[]
 def literal(value):return "'"+json.dumps(value,separators=(',',':'),ensure_ascii=True).replace("'","''")+"'::jsonb"
 for key,(status,details) in data.items():
  statements.append("insert into svitlo_ops.snapshots values('"+key+"','"+status+"',clock_timestamp(),"+literal(details)+") on conflict(id) do update set status=excluded.status,observed_at=excluded.observed_at,details=excluded.details;")
 for row in logs:
  statements.append("insert into svitlo_ops.logs(service,event,status,duration_ms) select service,event,status,duration_ms from jsonb_to_record("+literal(row)+") as r(service text,event text,status integer,duration_ms integer);")
 statements.append("delete from svitlo_ops.logs where id in(select id from svitlo_ops.logs where at<clock_timestamp()-interval '2 days' order by id limit 1000);")
 subprocess.run(['docker','exec','-i','svitlo-postgres-1','psql','-X','-q','-1','-v','ON_ERROR_STOP=1','-U','svitlo_owner','-d','svitlo_staging'],input='\n'.join(statements),text=True,check=True,stdout=subprocess.DEVNULL)
 print(json.dumps({'snapshots':len(data),'sanitizedErrors':len(logs),'privateLogsExported':False}))
if __name__=='__main__':main()
