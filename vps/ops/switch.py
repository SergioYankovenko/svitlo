#!/usr/bin/python3
"""Root-only switch transaction. Caller holds shared private-deploy flock."""
import json,os,re,subprocess,sys,time
from pathlib import Path
BASE=Path('/opt/svitlo/staging');CONF=Path('/etc/nginx/conf.d/svitlo-staging.conf')
def command(args):return subprocess.check_output(args,text=True,timeout=30).strip()
def atomic(p,data):
 t=p.with_name(p.name+'.arc-tmp');t.write_text(data);os.replace(t,p)
def current():
 s=CONF.read_text();ports=re.findall(r'proxy_pass http://127\.0\.0\.1:(18766|18767);',s)
 if len(ports)!=1:raise RuntimeError('Ambiguous proxy target')
 slot='a' if ports[0]=='18766' else 'b'
 if (BASE/'active-slot').read_text().strip()!=slot:raise RuntimeError('Slot/proxy mismatch; reconcile before deploy')
 return slot,ports[0],s
def ready(port):return json.loads(command(['curl','--silent','--show-error','--fail','--max-time','5','-H','Host: localhost:18765','http://127.0.0.1:'+port+'/readyz']))
def switch(target,slot,expected):
 oldslot,oldport,oldconf=current();oldrelease=str((BASE/'current').resolve());oldmanifest=(BASE/'active-release.json').read_text() if (BASE/'active-release.json').exists() else None
 if oldrelease!=expected:raise RuntimeError('Release changed; refusing stale deployment')
 port={'a':'18766','b':'18767'}[slot];wanted=Path(target).name
 if ready(port).get('release')!=wanted:raise RuntimeError('Candidate readiness mismatch')
 if ready('18765').get('release')!=Path(expected).name:raise RuntimeError('Live proxy does not match release state')
 manifest=json.loads((Path(target)/'manifest.json').read_text());assert manifest['delivery']=='disabled'
 journal={'status':'prepared','previousRelease':oldrelease,'previousSlot':oldslot,'previousProxy':oldconf,'previousManifest':oldmanifest,'target':target,'slot':slot}
 atomic(BASE/'switch-journal.json',json.dumps(journal))
 try:
  atomic(CONF,oldconf.replace('127.0.0.1:'+oldport+';','127.0.0.1:'+port+';'))
  command(['nginx','-t']);command(['systemctl','reload','nginx'])
  for _ in range(20):
   if ready('18765').get('release')==wanted:break
   time.sleep(.25)
  else:raise RuntimeError('Proxy did not switch')
  link=BASE/'current.arc-tmp';link.unlink(missing_ok=True);link.symlink_to(target);os.replace(link,BASE/'current')
  atomic(BASE/'active-slot',slot+'\n')
  atomic(BASE/'previous-release',oldrelease+'\n')
  atomic(BASE/'active-release.json',json.dumps({**manifest,'slot':slot,'release':wanted,'previousRelease':oldrelease,'switchedAt':int(time.time())}))
  atomic(BASE/'switch-journal.json',json.dumps({**journal,'status':'committed'}))
 except BaseException:
  atomic(CONF,oldconf);command(['nginx','-t']);command(['systemctl','reload','nginx'])
  link=BASE/'current.arc-tmp';link.unlink(missing_ok=True);link.symlink_to(oldrelease);os.replace(link,BASE/'current')
  atomic(BASE/'active-slot',oldslot+'\n')
  if oldmanifest is not None:atomic(BASE/'active-release.json',oldmanifest)
  else:(BASE/'active-release.json').unlink(missing_ok=True)
  atomic(BASE/'switch-journal.json',json.dumps({**journal,'status':'rolled_back'}));raise
 print(json.dumps({'switched':True,'release':wanted,'slot':slot,'sourceCommit':manifest['sourceCommit']}))
if __name__=='__main__':
 if os.geteuid()!=0:raise RuntimeError('Root required')
 switch(*sys.argv[1:])
