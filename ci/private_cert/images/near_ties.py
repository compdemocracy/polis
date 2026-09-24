"""Admit paired private decision traces. Raw quantities never enter receipts."""
import json
import hashlib
import re
from pathlib import Path
from polismath.replay.decision_ties import Decision, _valid, close, is_near_tie
from polismath.replay import legacy_pca

NAMES = {'assignment':'accepted-tie-cluster-assignment',
         'distal':'accepted-tie-most-distal', 'convergence':'accepted-tie-cluster-convergence'}
FIELDS = {'scope','call','cluster_bound','kind','subject','candidates','scores','selected','threshold'}
PATHS = sorted(legacy_pca.DOWNSTREAM_KEYS)


def admit(doc, checkpoint):
    if (type(doc) is not dict or set(doc) != {'schema','complete','events','checkpoint','record_sha256','outcomes'}
            or type(doc['record_sha256']) is not str or re.fullmatch('[0-9a-f]{64}',doc['record_sha256']) is None
            or doc['schema'] != 'polis-decision-trace/1' or doc['complete'] is not True
            or type(doc['checkpoint']) is not int or doc['checkpoint'] != checkpoint
            or type(doc['outcomes']) is not list
            or type(doc['events']) is not list or len(doc['events']) > 100000):
        raise ValueError('TIE_TRACE_SCHEMA')
    result=[]
    for row in doc['events']:
        if (type(row) is not dict or set(row) != FIELDS or row['scope'] not in ('base','group')
                or type(row['call']) is not int or row['call'] < 1
                or type(row['cluster_bound']) is not int or row['cluster_bound'] < 1 or type(row['subject']) is not str
                or type(row['candidates']) is not list or type(row['scores']) is not list):
            raise ValueError('TIE_TRACE_EVENT')
        subject = row['subject']
        supported = ((row['kind']=='min-last' and re.fullmatch(r'(?:distal-nearest:)?-?\d+',subject))
                     or (row['kind']=='max-last' and subject=='distal-farthest')
                     or (row['kind']=='lt' and re.fullmatch(r'convergence:\d+',subject))
                     or (row['kind']=='gt' and subject=='split-radius'))
        if not supported:raise ValueError('TIE_TRACE_SUBJECT')
        decision=Decision(row['kind'],tuple(row['candidates']),tuple(row['scores']),row['selected'],row['threshold'])
        if not _valid(decision):raise ValueError('TIE_TRACE_CHOICE')
        result.append((row,decision))
    return result


def first_tie(left,right,checkpoint):
    """Require a paired, close decision prefix before the FIRST branch change."""
    a,b=admit(left,checkpoint),admit(right,checkpoint)
    for (x,da),(y,db) in zip(a,b):
        if any(x[k]!=y[k] for k in ('scope','call','cluster_bound','kind','subject','candidates','threshold')):
            return None
        # Nearest-center identity is discarded by most-distal. Only its score
        # feeds the farthest-point and split decisions below.
        if x['subject'].startswith('distal-nearest:'):
            if not all(close(u,v) for u,v in zip(da.scores,db.scores)):
                return None
            continue
        if da.selected != db.selected:
            if not is_near_tie(da,db):return None
            family=('convergence' if da.kind=='lt' else
                    'distal' if x['subject'].startswith(('distal-','split-')) else 'assignment')
            return {'checkpoint':checkpoint,'name':NAMES[family],'scope':x['scope']}
        if len(da.scores)!=len(db.scores) or not all(close(u,v) for u,v in zip(da.scores,db.scores)):
            return None
    return None


def corroborate(doc, blob):
    """Match actual returned kmeans assignments to the published assignments.

    Intermediate assignment rows are observed from cluster_step's return.
    Kmeans may subsequently merge centers, so its final return is captured
    separately. Base output and the selected group output must both match.
    """
    def partition(clusters):
        result = {}
        for c in clusters:
            if type(c) is not dict or set(c) != {'id','members'}:
                raise ValueError('TIE_OUTCOME_SCHEMA')
            if type(c['id']) is not str or type(c['members']) is not list:
                raise ValueError('TIE_OUTCOME_SCHEMA')
            if c['id'] in result or any(type(p) is not str for p in c['members']):
                raise ValueError('TIE_OUTCOME_SCHEMA')
            result[c['id']] = sorted(c['members'])
        return result
    outcomes = {}
    for row in doc['outcomes']:
        if (type(row) is not dict or set(row) != {'scope','call','clusters'}
                or row['scope'] not in ('base','group') or type(row['call']) is not int
                or row['call'] < 1 or type(row['clusters']) is not list):
            return False
        key = row['scope'], row['call']
        if key in outcomes:return False
        outcomes[key] = partition(row['clusters'])
    if any((e['scope'],e['call']) not in outcomes for e in doc['events']):return False
    base = blob.get('base-clusters')
    groups = blob.get('group-clusters')
    if type(base) is not dict or type(groups) is not list:return False
    if len(base['id']) != len(base['members']):return False
    wanted_base = {str(i):sorted(map(str,m)) for i,m in zip(base['id'],base['members'])}
    wanted_group = {str(c['id']):sorted(map(str,c['members'])) for c in groups}
    bases = [v for (scope,_),v in outcomes.items() if scope=='base']
    groups = [v for (scope,_),v in outcomes.items() if scope=='group']
    return bool(bases and bases[-1]==wanted_base and wanted_group in groups)


def measure_recording(directory,observations, *, accept_tie=None):
    """No paired evidence, equal fold or close input projections: no exception."""
    for row in observations:
        if not (row['folded_matrix']==row['moderated_matrix']=='equal'
                and row['person_projection']=='pass'):
            continue
        i=row['checkpoint']
        try:
            a=json.loads((directory/'clj-decisions'/f'step-{i:03d}.json').read_text())
            b=json.loads((directory/'py-decisions'/f'step-{i:03d}.json').read_text())
            if type(a) is not dict or type(b) is not dict:
                continue
            if a.get('record_sha256') != hashlib.sha256((directory/'clj'/f'step-{i:03d}.blob.json').read_bytes()).hexdigest():
                continue
            if b.get('record_sha256') != hashlib.sha256((directory/'py'/f'step-{i:03d}.json').read_bytes()).hexdigest():
                continue
            admit(a,i); admit(b,i)
            left=json.loads((directory/'clj'/f'step-{i:03d}.blob.json').read_text())
            right=json.loads((directory/'py'/f'step-{i:03d}.json').read_text())['blob']
            if not corroborate(a,left) or not corroborate(b,right):continue
            tie=first_tie(a,b,i)
            if tie and accept_tie is not None and accept_tie(tie):return tie
        except (OSError,ValueError,TypeError,KeyError,OverflowError):
            continue
    return None
