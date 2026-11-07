from pathlib import Path
import hashlib,json,os,subprocess
HERE=Path(__file__).resolve().parent
assert os.geteuid()==0 and Path('/etc/svitlo/pgbackrest/.owner').read_text()=='ARCH-MOD-01-14'
exporter=Path('/usr/local/sbin/svitlo-offsite-export');new_export=(HERE/'offsite-export.py').read_bytes().replace(b'\r\n',b'\n')
expected='a7d4490b8e59b6a4c8a1bb59f2a319ace353dfdd04e8857882714e555fa442d0'
old_export=exporter.read_bytes().replace(b'\r\n',b'\n')
assert hashlib.sha256(old_export).hexdigest() in [expected,hashlib.sha256(new_export).hexdigest()], 'unexpected existing backup exporter change'
if old_export!=new_export:
 history=Path('/etc/svitlo/backup-export-history');history.mkdir(mode=0o700,exist_ok=True)
 saved=history/(hashlib.sha256(old_export).hexdigest()+'.py')
 if not saved.exists():saved.write_bytes(old_export);saved.chmod(0o600)
 exporter.write_bytes(new_export);exporter.chmod(0o700)
script=Path('/usr/local/sbin/svitlo-pgbackrest-backup');body=(HERE/'backup-control.sh').read_bytes().replace(b'\r\n',b'\n');script.write_bytes(body);script.chmod(0o700)
for kind,calendar in [('full','Sun *-*-* 03:10:00 UTC'),('diff','Mon..Sat *-*-* 03:10:00 UTC')]:
 service='''[Unit]
Description=Svitlo encrypted physical PostgreSQL backup
After=docker.service
[Service]
Type=oneshot
UMask=0077
ExecStart=/usr/local/sbin/svitlo-pgbackrest-backup KIND
TimeoutStartSec=3600
CPUQuota=50%
MemoryMax=256M
'''.replace('KIND',kind)
 timer='''[Unit]
Description=Svitlo physical backup schedule
[Timer]
OnCalendar=CALENDAR
Persistent=true
RandomizedDelaySec=180
[Install]
WantedBy=timers.target
'''.replace('CALENDAR',calendar)
 for suffix,value in [('service',service),('timer',timer)]:Path('/etc/systemd/system/svitlo-pgbackrest-'+kind+'.'+suffix).write_text(value)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','svitlo-pgbackrest-full.timer','svitlo-pgbackrest-diff.timer'],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'physicalBackupTimersEnabled':True,'full':'weekly Sunday UTC','differential':'Mon–Sat UTC','wal':'continuous archive command','existingOneDriveTimerChanged':False,'externalWalRepository':False,'newModuleSecretsIncludedInExistingEncryptedExport':True,'cloudAccessScopesChanged':False,'controlScriptSha256':hashlib.sha256(body).hexdigest()}))
