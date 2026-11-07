from pathlib import Path
import hashlib,json,os,subprocess,time,urllib.request
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
assert os.geteuid()==0 and (str(ROOT).startswith('/opt/svitlo/staging/releases/') or str(ROOT).startswith('/opt/svitlo/modules/observability/'))
for folder in [Path('/etc/svitlo/netdata'),Path('/var/lib/svitlo-netdata')]:
 if folder.exists():assert (folder/'.owner').read_text()=='ARCH-MOD-01-01'
 folder.mkdir(mode=0o755,parents=True,exist_ok=True);(folder/'.owner').write_text('ARCH-MOD-01-01')
for kind in ['cache','lib','log']:
 p=Path('/var/lib/svitlo-netdata')/kind;p.mkdir(mode=0o700,exist_ok=True);os.chown(p,201,201)
config=Path('/etc/svitlo/netdata');(config/'netdata.conf').write_bytes((HERE/'netdata.conf').read_bytes());(config/'netdata.conf').chmod(0o644)
for name,text in [('cloud.conf','[global]\n    enabled = no\n'),('.opt-out-from-anonymous-statistics','')]:
 p=config/name;p.write_text(text);p.chmod(0o644)
subprocess.run(['docker','compose','-f',str(HERE/'compose.yaml'),'up','-d'],check=True,stdout=subprocess.DEVNULL)
for n in range(30):
 try:
  with urllib.request.urlopen('http://127.0.0.1:19999/api/v1/charts',timeout=3) as r:charts=json.load(r)['charts']
  if 'system.cpu' in charts and 'system.ram' in charts:break
 except (OSError,ValueError):pass
 time.sleep(1)
else:raise RuntimeError('Netdata CPU/RAM readiness failed')
service='''[Unit]
Description=Svitlo bounded private host evidence
After=docker.service
[Service]
Type=oneshot
User=root
UMask=0077
ExecStart=/usr/bin/python3 /opt/svitlo/staging/current/vps/observability/host-agent.py
TimeoutStartSec=45
'''
timer='''[Unit]
Description=Svitlo minute host evidence
[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
'''
for suffix,value in [('service',service),('timer',timer)]:Path('/etc/systemd/system/svitlo-host-evidence.'+suffix).write_text(value)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','svitlo-host-evidence.timer'],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['/usr/bin/python3',str(HERE/'host-agent.py')],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'netdata':True,'cpuAndRamCharts':True,'bind':'127.0.0.1:19999','dockerSocketMounted':False,'privileged':False,'cloudEnabled':False,'hostEvidenceTimer':True,'independentMonitorHost':False}))
