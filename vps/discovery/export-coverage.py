#!/usr/bin/env python3
"""Fixed read-only aggregate exporter. No user/profile/sensor tables are read.

Public output is an explicit allowlist. SQL results containing routing IDs stay
in process memory, and no arbitrary SQL is accepted from the HTTP surface.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SOURCE_ERRORS = {'upstream_forbidden', 'upstream_rate_limited', 'upstream_unavailable', 'invalid_source', 'source_stale'}

def aggregate(data, generated_at=None):
    configured = {r['region_code'] for r in data['configured']}
    nodes = {}
    for p in data['places']:
        nodes[p['code']] = dict(p, tasks=0, checked=0, attempted=0, retrying=0,
          territoryCounts={}, territoryHeldTasks=0, rootRoutes=0, rootRoutesChecked=0, rootRoutesHandled=0, unmatchedRoots=0,
          streetTasks=0, streetTasksChecked=0, houseReferencesChecked=0,
          settlements=int(p['level']==4 or p['category']=='K'), settlementsWithoutRoute=0,
          directScopeTasks=0,lastAttemptAt=None,lastObservedAt=None,outcomes={},
          potentialRoutes=set(), ambiguousRoutes=set())
    def walk(code):
        seen=set()
        while code:
            if code in seen: raise ValueError('Administrative cycle')
            seen.add(code)
            if code not in nodes: raise ValueError('Missing administrative anchor')
            n=nodes[code]
            yield n
            code=n['parent_code']
    def latest(a,b): return max(v for v in (a,b) if v) if a or b else None
    for r in data['routes']:
        leaf=nodes.get(r['settlement_code'])
        if leaf:
            leaf['potentialRoutes'].add(r['route_id'])
            if r['candidate_count']>1: leaf['ambiguousRoutes'].add(r['route_id'])
    for leaf in list(nodes.values()):
        if leaf['level']!=4 and leaf['category']!='K': continue
        for n in walk(leaf['code']):
            key=leaf.get('territory_status') or 'unlisted'
            n['territoryCounts'][key]=n['territoryCounts'].get(key,0)+1
            if not leaf['potentialRoutes']: n['settlementsWithoutRoute']+=1
            if n is not leaf: n['settlements']+=1
            n['potentialRoutes'].update(leaf['potentialRoutes'])
            n['ambiguousRoutes'].update(leaf['ambiguousRoutes'])
    for j in data['jobs']:
        for n in walk(j['settlement_code'] or j['cluster_code']):
            for target,source in [('tasks','total'),('checked','checked'),('attempted','attempted'),('retrying','retrying')]:n[target]+=j[source]
            n['territoryHeldTasks']+=j.get('territory_held',0)
            n['lastAttemptAt']=latest(n['lastAttemptAt'],j['last_attempt'])
            if j['kind']=='city':
                n['rootRoutes']+=j['total'];n['rootRoutesHandled']+=j['checked']
                if j['scope_status']=='unmatched':n['unmatchedRoots']+=j['total']
                else:n['rootRoutesChecked']+=j['checked']
            elif j['kind']=='street':n['streetTasks']+=j['total'];n['streetTasksChecked']+=j['checked']
            else:raise ValueError('Unknown job kind')
        if not j['settlement_code']:nodes[j['cluster_code']]['directScopeTasks']+=j['total']
    for e in data['events']:
        for n in walk(e['settlement_code'] or e['cluster_code']):
            if e['summary']:n['houseReferencesChecked']+=e['house_refs']
            else:n['outcomes'][e['outcome']]=n['outcomes'].get(e['outcome'],0)+e['subjects']
            n['lastObservedAt']=latest(n['lastObservedAt'],e['last_seen'])
    output=[]
    for n in nodes.values():
        if n['level']>3:continue
        connected=n['region_code'] in configured
        status='not_connected' if not connected else 'territory_hold' if n['tasks'] and n['territoryHeldTasks']>=n['tasks'] else 'waiting_source' if n['retrying'] else 'mapping_gap' if not n['tasks'] else 'queued' if not n['attempted'] else 'in_progress' if n['checked']<n['tasks'] else 'checked_known_tasks'
        output.append({
          'code':n['code'],'parentCode':n['parent_code'],'level':n['level'],'category':n['category'],
          'name':n['name'],'regionCode':n['region_code'],'districtCode':n['district_code'],
          'communityCode':n['community_code'],'connected':connected,'status':status,
          'settlements':n['settlements'], 'territoryCounts':n['territoryCounts'],'territoryHeldTasks':n['territoryHeldTasks'], 'settlementsWithoutAnyRoute':n['settlementsWithoutRoute'] if connected else None,
          'potentialSourceRoutes':len(n['potentialRoutes']) if connected else None,
          'ambiguousSourceRoutes':len(n['ambiguousRoutes']) if connected else None,
          'knownTasks':n['tasks'] if connected else None,'checkedTasks':n['checked'] if connected else None,
          'tasksWaitingSource':n['retrying'] if connected else None,'coarseScopeTasks':n['directScopeTasks'] if connected else None,
          'sourceRouteDiscovery':{'checked':n['rootRoutesChecked'],'handled':n['rootRoutesHandled'],'total':n['rootRoutes'],'unmatched':n['unmatchedRoots']} if connected else None,
          'streetAudit':{'checked':n['streetTasksChecked'],'totalKnown':n['streetTasks'],'denominatorComplete':n['rootRoutes']>0 and n['rootRoutes']==n['rootRoutesChecked']} if connected else None,
          'houseSourceReferencesChecked':n['houseReferencesChecked'] if connected else None,
          'outcomes':n['outcomes'] if connected else {},'lastAttemptAt':n['lastAttemptAt'],'lastObservedAt':n['lastObservedAt'],
        })
    result={'schemaVersion':1,'generatedAt':generated_at or dt.datetime.now(dt.timezone.utc).isoformat(),
      'refreshSeconds':60,'scope':'aggregate_provider_discovery','directoryVersion':'geo-20261105-v1',
      'territory':(data.get('territory') or [None])[0],
      'nodes':output,'activeClusters':data['active'],'collector':(data['state'] or [None])[0],
      'sourceDirectories':[{k:r.get(k) for k in ('operator_id','region_code','enabled','status','directory_complete','last_attempt_at','last_success_at','next_at','error_code','routes','mapped','queue_lookup','directory_scope','accepted_rows','skipped_rows')} for r in data.get('directories',[])],
      'semantics':{'geographicCoverageConfirmed':False,'streets':'checked / known source street tasks; denominator grows during discovery',
        'houses':'source references, not deduplicated physical buildings','ambiguous':'tasks remain at the justified common ancestor; never copied into all candidate communities',
        'errors':'transport failures are not evidence that an address is absent','history':'outcomes are retained within the collector retention window, not only current failures'}}
    result['revision']=hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()[:16]
    return result

def main():
    output=Path(sys.argv[1]) if len(sys.argv)>1 else Path('/var/lib/svitlo-coverage/coverage.json')
    sql=(HERE/'coverage.sql').read_text()
    r=subprocess.run(['docker','exec','-i','svitlo-postgres-1','psql','-X','-q','-U','svitlo_owner','-d','svitlo_staging','-At','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,timeout=20,check=True)
    data={x['kind']:(x['rows'] or []) for line in r.stdout.splitlines() if line.startswith('{') for x in [json.loads(line)]}
    result=aggregate(data)
    content=json.dumps(result,ensure_ascii=False,separators=(',',':')).encode()
    if len(content)>2_000_000:raise ValueError('Aggregate output unexpectedly large')
    tmp=output.with_suffix('.tmp')
    with open(tmp,'wb') as f:f.write(content);f.flush();os.fsync(f.fileno())
    os.chmod(tmp,0o644);os.replace(tmp,output)
    print(json.dumps({'ok':True,'generatedAt':result['generatedAt'],'nodes':len(result['nodes']),'bytes':len(content),'revision':result['revision']}))
if __name__=='__main__': main()
