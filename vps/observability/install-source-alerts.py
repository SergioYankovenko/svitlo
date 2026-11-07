"""Install the read-only source monitor on the private stage host."""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time

NAME = 'svitlo-stage-source-alerts'
ROLE = 'svitlo_source_alerts'
NETWORK = 'svitlo_source_alerts_egress'
LABEL = 'svitlo.scope=private-source-alerts'
ROOT = Path('/etc/svitlo/source-alerts')
STATE = Path('/var/lib/svitlo-source-alerts')
ACTIVE = Path('/opt/svitlo/staging/current')

def docker(*args, data=None):
    result = subprocess.run(['docker', *args], text=True, input=data, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError('source_alerts_setup_failed')
    return result.stdout.strip()

def main():
    assert os.geteuid() == 0 and Path(__file__).resolve().is_relative_to(ACTIVE.resolve())
    manifest = json.loads((ACTIVE / 'manifest.json').read_text())
    image = manifest['image']
    assert manifest['scope'] == 'isolated-staging' and re.fullmatch(r'sha256:[a-f0-9]{64}', image)
    assert docker('image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',image)==manifest['sourceCommit']
    marker = ROOT / '.owner'
    if ROOT.exists():
        assert marker.read_text() == NAME
    else:
        ROOT.mkdir(mode=0o750)
        marker.write_text(NAME)
    os.chown(ROOT,0,1000)
    STATE.mkdir(mode=0o700,exist_ok=True)
    os.chown(STATE,1000,1000)
    password_file = ROOT / 'database-password'
    if not password_file.exists():
        password_file.touch(mode=0o600,exist_ok=False)
        password_file.write_text(secrets.token_hex(32))
    os.chown(password_file,0,1000)
    password_file.chmod(0o440)
    password = password_file.read_text().strip()
    assert re.fullmatch(r'[a-f0-9]{64}',password)
    sql = f'''begin;
do $$ begin
 if not exists(select 1 from pg_roles where rolname='{ROLE}') then
  create role {ROLE} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 2 password '{password}';
 elsif not exists(select 1 from pg_roles where rolname='{ROLE}' and rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and rolconnlimit=2) then
  raise exception 'unexpected source alert role';
 end if;
end $$;
grant usage on schema svitlo_source_history to {ROLE};
grant execute on function svitlo_source_history.group_plan(text) to {ROLE};
do $$ begin
 if has_table_privilege('{ROLE}','svitlo_source_history.observations','SELECT') or has_table_privilege('{ROLE}','public.svitlo_profiles','SELECT') or has_function_privilege('{ROLE}','svitlo_source_history.claim()','EXECUTE') then
  raise exception 'source alert privileges are too broad';
 end if;
end $$;
commit;'''
    docker('exec','-i','svitlo-postgres-1','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','svitlo_owner','-d','svitlo_staging',data=sql)
    if NETWORK not in docker('network','ls','--format','{{.Name}}').splitlines():
        docker('network','create','--label',LABEL,NETWORK)
    assert docker('network','inspect','--format','{{index .Labels "svitlo.scope"}}',NETWORK)=='private-source-alerts'
    if NAME in docker('ps','-a','--format','{{.Names}}').splitlines():
        assert docker('inspect','--format','{{index .Config.Labels "svitlo.scope"}}',NAME)=='private-source-alerts'
        assert docker('inspect','--format','{{.Image}}',NAME)==image
    else:
        docker('create','--name',NAME,'--label',LABEL,'--restart','unless-stopped','--network','svitlo_backend',
            '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--memory','96m',
            '--cpus','0.2','--pids-limit','64','--log-opt','max-size=2m','--log-opt','max-file=2',
            '--mount',f'type=bind,src={ROOT},dst=/run/alerts-secrets,readonly',
            '--mount',f'type=bind,src={STATE},dst=/state',image,'node','--use-system-ca','vps/observability/source-alerts.mjs')
        docker('network','connect',NETWORK,NAME)
    docker('start',NAME)
    for _ in range(15):
        if 'source_alerts_ready' in docker('logs','--tail','15',NAME):
            break
        time.sleep(1)
    else:
        raise RuntimeError('source_alerts_database_probe_failed')
    print(json.dumps({'scope':'isolated-staging','container':NAME,'image':image,'groupSources':4,'pollSeconds':5,
        'configured':(ROOT/'telegram.json').is_file(),'publicPorts':False,'profileAccess':False}))

if __name__=='__main__':
    main()
