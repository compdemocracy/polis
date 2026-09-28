#!/usr/bin/env python3
"""Verify public warm-resume receipts; capacity and full-contract admission stay closed."""
import argparse
import copy
import hashlib
import json
from pathlib import Path

PROFILES=('vw-warm','vw-snapshot','biodiversity-warm','biodiversity-snapshot')


def inventory(profile,controls=False):
    if profile not in PROFILES:raise ValueError('profile')
    names=['prepare/source-and-runtime']
    if controls:names.append('controls/runtime-authority-observer')
    def add(*items):names.extend(profile+'/'+v for v in items)
    def legacy(label,bootstrap=False):
        if bootstrap:add(*(label+'/'+s for s in ('bootstrap-no-history','bootstrap-live-empty-actor','quarter/source')))
        add(*(label+'/'+s for s in ('real-clojure','negative-nologin-retains-session','excluded','coherent-after-exclusion')))
    def readers(label,p=False):
        for i,reader in enumerate(('reader_p1','reader_p2') if p else ('server','reader_l2')):
            root=label+'/'+reader
            add(root+'/namespace')
            for mode in ('cold','warm','prefetched'):
                add(root+'/'+mode)
                if i:add(root+'/'+mode+'/same-namespace-bytes')
                add(root+'/'+mode+'/current-etag')
            add(*(root+'/'+s for s in ('report','votes-csv','groups-csv','owner-auth','missing-auth')))
    def publish(label):add(label,*(label+'/'+s for s in ('coherent','independent-input-fold','observer','exact-operation-receipts')))
    legacy('L-quarter',True);readers('L-initial');publish('P-quarter')
    add('negative-no-floor','reset-unfloored/reader_p1','L-to-P/floor');publish('P-floor')
    add('negative-retained-reader','drain-L/server','drain-L/reader_l2');readers('P-serving',True)
    for cut in ('half','full'):
        add(cut+'/negative-missing-suffix',cut+'/source');publish('P-'+cut)
        add('refresh-'+cut+'/reader_p1','refresh-'+cut+'/reader_p2');readers('P-'+cut+'-served',True)
    add('legacy-rows-retained')
    if profile.endswith('-snapshot'):add('negative-partial-snapshot','snapshot-restored')
    add('drain','withdraw-P/floor','restart-denied');legacy('L-recovery')
    add('source-survives-recovery','route-L/floor','drain-P/reader_p1','drain-P/reader_p2')
    readers('L-returned');add('strictly-new-L-token','finish/server','finish/reader_l2')
    return names


def require(condition,message):
    if not condition:raise ValueError(message)


def validate(r):
    require(r['schema']=='polis-d07-public/1' and r['status']=='PASS' and r['rehearsal']=='PASS','not a complete rehearsal')
    require(r['capacity']=='UNADMITTED' and r['full_contract_gate']=='FAIL' and
            r['alarm_delivery']=='OPERATOR_NOT_EVALUATED','unearned admission')
    require([c['name'] for c in r['cases']]==inventory(r['profile'],r['runtime_controls']) and
            all(c['passed'] is True for c in r['cases']),'case inventory')
    require(set(r['remaining_resources'])=={'container','network','volume'} and
            not any(r['remaining_resources'].values()),'cleanup')
    require(len(r['legacy_processes'])==2 and all(p['recompute'] is False for p in r['legacy_processes']),'warm profile')
    require(len(r['exclusions'])==2 and all(e['old_denied'] and e['reconnect_denied'] and e['container_removed'] for e in r['exclusions']),'legacy exclusion')
    slug=r['profile'].rsplit('-',1)[0];cuts=r['public_inputs'][slug]['cuts']
    require([c['cut'] for c in r['cuts']]==cuts and all(c['events']==c['cut'] for c in r['cuts']),'input cuts')
    require(len(r['measurements'])==6 and {m['cut'] for m in r['measurements']}==set(cuts),'measurements')
    require(all(m['capacity']=='UNADMITTED' and m['wall_seconds']>0 and m['database_bytes']>0
                and m['publication_row_bytes'] for m in r['measurements']),'measurement fields')
    require(len(r['python_processes'])==4 and all(p['peak_rss_bytes']>0 for p in r['python_processes']),'python processes')
    require(len(r['observations'])==4 and all(o['sample']['ObserverHealthy']==1 and
        o['sample']['PollHealthy']==1 and o['sample']['PendingOperations']==0 and
        o['sample']['UnresolvedOperations']==0 for o in r['observations']),'observer')
    require(len(r['source_sha256'])>100 and len(r['migrations'])==21 and len(r['cached_images'])==7,'attribution')
    require(bool(r['artifact_sha256']) and 'source-reconciliation.json' in r['artifact_sha256'],'artifact inventory')


def verify(directory):
    r=json.loads((directory/'receipt.json').read_text());validate(r)
    actual={str(p.relative_to(directory)) for p in directory.rglob('*') if p.is_file() and p.name!='receipt.json'}
    require(set(r['artifact_sha256'])==actual,'missing or additional artifacts')
    for name,expected in r['artifact_sha256'].items():
        path=directory/name
        require(not path.is_symlink() and path.resolve().is_relative_to(directory.resolve()),'artifact path')
        require(hashlib.sha256(path.read_bytes()).hexdigest()==expected,'artifact drift: '+name)
    return r


def controls(r):
    mutations=[lambda r:r.update(status='MEASURED'),lambda r:r.update(capacity='PASS'),
        lambda r:r.update(full_contract_gate='PASS'),lambda r:r['cases'].pop(),
        lambda r:r['cases'].reverse(),lambda r:r['cases'].append(r['cases'][0]),
        lambda r:r['cases'][0].update(passed=False),lambda r:r['remaining_resources']['container'].append('leftover'),
        lambda r:r['legacy_processes'][1].update(recompute=True),lambda r:r['exclusions'][1].update(old_denied=False),
        lambda r:r['cuts'].pop(),lambda r:r['measurements'].pop(),lambda r:r['python_processes'].clear(),
        lambda r:r['observations'][0]['sample'].update(UnresolvedOperations=1),
        lambda r:r['artifact_sha256'].clear()]
    for mutate in mutations:
        broken=copy.deepcopy(r);mutate(broken)
        try:validate(broken)
        except ValueError:pass
        else:raise AssertionError('bad receipt admitted')
    return len(mutations)


def main():
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);p.add_argument('--controls',action='store_true');a=p.parse_args()
    r=verify(a.directory)
    print(json.dumps({'verification':'PASS','profile':r['profile'],'cases':len(r['cases']),
        'refusal_controls':controls(r) if a.controls else 0,'capacity':'UNADMITTED'}))


if __name__=='__main__':main()
