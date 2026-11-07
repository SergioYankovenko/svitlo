"""Bounded private stage soak. Observes one exact release; never sends alerts."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

def sample():
    def check(path):
        request = Request('http://127.0.0.1:18765/' + path, headers={'Host':'localhost:18765'})
        with urlopen(request, timeout=5) as response:
            return json.load(response)
    health, ready = check('healthz'), check('readyz')
    return health.get('release'), ready.get('release')

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--release',required=True)
    parser.add_argument('--image',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    current=Path('/opt/svitlo/staging/active-release.json')
    out=args.output
    assert out.parent==Path('/var/lib/svitlo-acceptance') and out.name==args.release
    out.mkdir(mode=0o700,parents=True,exist_ok=False)
    started=time.monotonic()
    count=errors=0
    with (out/'samples.jsonl').open('x',encoding='utf-8',buffering=1) as log:
        while True:
            elapsed=time.monotonic()-started
            try:
                manifest=json.loads(current.read_text())
                pinned=manifest.get('release')==args.release and manifest.get('image')==args.image
                if not pinned:
                    reason='release_changed'
                else:
                    reason='ok' if sample()==(args.release,args.release) else 'unexpected_health_payload'
            except (OSError,ValueError,TypeError):
                reason='health_or_readiness_failed'
            count+=1
            errors+=reason!='ok'
            now=datetime.now(timezone.utc).isoformat()
            log.write(json.dumps(dict(at=now,seconds=int(elapsed),result=reason))+'\n')
            status={'status':'stopped_release_changed' if reason=='release_changed' else 'complete' if elapsed>=86400 else 'observing',
                    'release':args.release,'image':args.image,'observedSeconds':int(elapsed),'samples':count,
                    'unexpectedErrors':errors,'latest':now,'independentHost':False,'writesAttempted':0}
            tmp=out/'.summary.tmp';tmp.write_text(json.dumps(status,indent=2)+'\n',encoding='utf-8')
            tmp.replace(out/'summary.json')
            if status['status']!='observing':
                break
            time.sleep(max(1,started+count*60-time.monotonic()))
if __name__=='__main__':
    main()
