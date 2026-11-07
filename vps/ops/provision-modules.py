"""Root-only private-VPS provisioning. No secrets on stdout or process argv."""
from pathlib import Path
import argparse,json,os,secrets,subprocess,time,urllib.request,urllib.error,uuid

S=Path('/etc/svitlo');ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','search','admin']);a=parser.parse_args()
assert os.geteuid()==0 and str(ROOT).startswith('/opt/svitlo/staging/releases/')
def command(args,**kw):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kw)
 if r.returncode:raise RuntimeError('Module provisioning command failed: '+args[0])
 return r.stdout.decode().strip()
def private(path,value,uid=0):
 path.parent.mkdir(parents=True,exist_ok=True)
 if path.exists():
  value=path.read_text().strip();os.chown(path,uid,uid);os.chmod(path,0o400 if uid else 0o600);return value
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400 if uid else 0o600)
 with os.fdopen(fd,'w') as f:f.write(value+'\n')
 os.chown(path,uid,uid);return value
def prepare():
 for kind in ['search','billing','sources','notifications','migration']:
  directory=S/kind;marker=directory/'.arch-mod-01'
  if directory.exists() and not marker.exists():raise RuntimeError('Unowned module directory: '+kind)
  directory.mkdir(mode=0o755,exist_ok=True);private(marker,'ARCH-MOD-01')
  for role in ['api','worker']:
   folder=directory/role;folder.mkdir(mode=0o700,exist_ok=True);os.chown(folder,1000,1000);os.chmod(folder,0o500)
 (S/'admin-secrets').mkdir(mode=0o700,exist_ok=True)
 private(S/'admin-secrets/admin-password',secrets.token_hex(32),1000);private(S/'admin-secrets/admin-secret',secrets.token_hex(32),1000)
 master=private(S/'search/master-key',secrets.token_hex(32));private(S/'search/engine.env','MEILI_MASTER_KEY='+master)
 purchase=private(S/'billing/purchase-key',secrets.token_hex(32))
 for role in ['api','worker']:
  if private(S/('billing/'+role+'/purchase-key'),purchase,1000)!=purchase:raise RuntimeError('Purchase encryption key mismatch')
 delivery=private(S/'notifications/delivery-key',secrets.token_hex(32))
 for role in ['api','worker']:
  if private(S/('notifications/'+role+'/delivery-key'),delivery,1000)!=delivery:raise RuntimeError('Notification encryption key mismatch')
 data=Path('/var/lib/svitlo-search');data.mkdir(mode=0o700,exist_ok=True);os.chown(data,1000,1000)
 prepare_report={'prepared':True,'generatedCredentialsPrinted':False,'paidModeChanged':False};return prepare_report
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None
def start_search():
 command(['docker','compose','-f',str(ROOT/'vps/search/compose.yaml'),'up','-d'])
 inspect=json.loads(command(['docker','inspect','svitlo-search-1']))[0]
 if inspect['HostConfig']['PortBindings']:raise RuntimeError('Search must have no public ports')
 ip=inspect['NetworkSettings']['Networks']['svitlo_backend']['IPAddress'];base='http://'+ip+':7700';master=(S/'search/master-key').read_text().strip();opener=urllib.request.build_opener(NoRedirect)
 def request(path,method='GET',body=None,key=master):
  req=urllib.request.Request(base+path,method=method,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},data=None if body is None else json.dumps(body).encode())
  try:
   with opener.open(req,timeout=10) as r:return r.status,json.load(r)
  except urllib.error.HTTPError as e:return e.code,{}
 for _ in range(30):
  try:
   if request('/health')[0]==200:break
  except OSError:pass
  time.sleep(1)
 else:raise RuntimeError('Search readiness failed')
 for role,actions in [('api',['search','documents.get']),('worker',['indexes.create','indexes.get','indexes.delete','documents.add','documents.delete','settings.get','settings.update','tasks.get'])]:
  identity=str(uuid.uuid5(uuid.NAMESPACE_URL,'svitlo-arch-mod-01/search/'+role));status,key=request('/keys/'+identity)
  if status==404:status,key=request('/keys','POST',{'uid':identity,'name':'Svitlo '+role,'actions':actions,'indexes':['svitlo_catalog_g_*','svitlo_dictionary_g_*'],'expiresAt':None})
  if status not in [200,201] or sorted(key.get('actions',[]))!=sorted(actions) or sorted(key.get('indexes',[]))!=['svitlo_catalog_g_*','svitlo_dictionary_g_*']:raise RuntimeError('Search key permissions mismatch')
  file=S/('search/'+role+'/'+('read-key' if role=='api' else 'write-key'))
  if private(file,key['key'],1000)!=key['key']:raise RuntimeError('Search key mismatch; explicit key rotation required')
  if request('/keys',key=key['key'])[0]!=403:raise RuntimeError('Application key must not manage keys')
 return {'searchReady':True,'publicPorts':False,'readerAndWriterKeysSeparated':True,'masterMountedInApplication':False}
def start_admin():
 password=(S/'admin-secrets/admin-password').read_text().strip()
 if len(password)!=64 or any(c not in '0123456789abcdef' for c in password):raise RuntimeError('Invalid admin role secret')
 sql="do $$ begin if exists(select from pg_roles where rolname='svitlo_stage_admin' and (rolsuper or rolbypassrls)) then raise exception 'invalid role';end if;end $$;alter role svitlo_stage_admin login connection limit 2 password '"+password+"';grant connect on database svitlo_staging to svitlo_stage_admin;"
 command(['docker','exec','-i','svitlo-postgres-1','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','svitlo_owner','-d','svitlo_staging'],input=sql.encode())
 command(['docker','compose','--env-file',str(ROOT/'vps/release.env'),'-f',str(ROOT/'vps/admin/compose.yaml'),'up','-d'])
 for _ in range(30):
  try:
   with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18768/readyz',headers={'Host':'localhost:18768'}),timeout=3) as response:
    if response.status==200 and json.load(response).get('status')=='ready':break
  except OSError:pass
  time.sleep(1)
 else:raise RuntimeError('Admin database/readiness check failed')
 return {'adminStarted':True,'bind':'127.0.0.1:18768','separateRolePoolAndSecrets':True,'publicOriginChanged':False}
print(json.dumps(prepare() if a.action=='prepare' else start_search() if a.action=='search' else start_admin()))
