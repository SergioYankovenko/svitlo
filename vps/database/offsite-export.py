#!/usr/bin/python3
"""Root-only, public-key encrypted export. Never emits plaintext secrets."""
import hashlib,io,json,os,subprocess,tarfile,time
from pathlib import Path
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes

def output(args):return subprocess.check_output(args,timeout=120)
def export():
    release=Path('/opt/svitlo/staging/current').resolve()
    data={
        'globals.sql':output(['docker','exec','svitlo-postgres-1','pg_dumpall','-U','svitlo_owner','--globals-only']),
    }
    for base in [Path('/etc/svitlo'),Path('/opt/svitlo/postgres'),Path('/opt/svitlo/compose'),Path('/opt/svitlo/modules')]:
        if base.exists():
            for p in base.rglob('*'):
                if p.is_file() and not p.is_symlink() and p.stat().st_size<4*1024*1024:
                    data['host/'+str(p.relative_to('/'))]=p.read_bytes()
    for p in Path('/etc/nginx/conf.d').glob('*svitlo*'):
        if p.is_file():data['host/'+str(p.relative_to('/'))]=p.read_bytes()
    for p in Path('/usr/local/sbin').glob('svitlo*'):
        if p.is_file():data['host/'+str(p.relative_to('/'))]=p.read_bytes()
    for p in Path('/etc/systemd/system').glob('svitlo*'):
        if p.is_file():data['host/'+str(p.relative_to('/'))]=p.read_bytes()
    # Source and exact compose/environment permit rebuilding without changing legacy services.
    for name in ['vps','server','app','pwa','admin','supabase/migrations','package.json','package-lock.json']:
        root=release/name
        for p in ([root] if root.is_file() else root.rglob('*')):
            if p.is_file() and not p.is_symlink() and 'node_modules' not in p.parts:
                data['release/'+str(p.relative_to(release))]=p.read_bytes()
    # Existing root-only logical dump; never assemble a full database archive in RAM.
    subprocess.run(['/usr/local/sbin/svitlo-stage-backup'],check=True,stdout=subprocess.DEVNULL)
    dump=Path(Path('/var/lib/svitlo-stage/latest-backup').read_text().strip())
    h=hashlib.sha256()
    with dump.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    data['manifest.json']=json.dumps({'version':1,'createdAt':int(time.time()),'release':release.name,
        'sha256':{'database.dump':h.hexdigest(),**{k:hashlib.sha256(v).hexdigest() for k,v in data.items()}}}).encode()
    key=os.urandom(32);nonce=os.urandom(12);aad=b'SVITLO-OFFSITE-v1'
    pub=serialization.load_pem_public_key(Path('/etc/svitlo/offsite-public.pem').read_bytes())
    wrapped=pub.encrypt(key,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=aad))
    import sys
    dest=sys.stdout.buffer;dest.write(aad+b'\n'+len(wrapped).to_bytes(2,'big')+wrapped+nonce)
    cipher=Cipher(algorithms.AES(key),modes.GCM(nonce)).encryptor();cipher.authenticate_additional_data(aad)
    class Writer:
        def write(self,body):dest.write(cipher.update(body));return len(body)
    with tarfile.open(fileobj=Writer(),mode='w|gz') as t:
        entry=tarfile.TarInfo('database.dump');entry.size=dump.stat().st_size;entry.mode=0o600
        with dump.open('rb') as f:t.addfile(entry,f)
        for name,body in data.items():
            entry=tarfile.TarInfo(name);entry.size=len(body);entry.mode=0o600;t.addfile(entry,io.BytesIO(body))
    dest.write(cipher.finalize());dest.write(cipher.tag);dest.flush()
if __name__=='__main__':
    import sys
    export()
