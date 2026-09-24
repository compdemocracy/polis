"""Replay-only paired decision observations. Never changes returned engine values."""
from contextlib import contextmanager
from unittest.mock import patch
import numpy as np
from polismath.pca_kmeans_rep import legacy_kmeans as km
from polismath.utils.clj_hash import clojure_hash_map_key_order

LIMIT = 100000


@contextmanager
def capture(enabled):
    doc = dict(schema='polis-decision-trace/1', complete=True, events=[], outcomes=[])
    if not enabled:
        yield doc
        return
    from polismath.conversation import conversation
    scope = ['base', 0, 0]
    def emit(kind, subject, candidates, scores, selected, threshold=None):
        try:
            if len(doc['events']) >= LIMIT:
                doc['complete'] = False
                return
            doc['events'].append(dict(scope=scope[0], call=scope[1], cluster_bound=scope[2], kind=kind,
                subject=str(subject), candidates=list(map(str,candidates)),
                scores=list(map(float,scores)), selected=selected, threshold=threshold))
        except Exception:
            doc['complete'] = False
    original_kmeans, original_step, original_same = km.kmeans, km.cluster_step, km.same_clustering
    original_distal = km.most_distal
    def kmeans(data,k,*args,**kwargs):
        # The production callers supply weights by keyword.
        scope[0] = 'group' if kwargs.get('weights') is not None else 'base'
        scope[1] += 1
        scope[2] = min(int(k), len(data.row_names))
        result = original_kmeans(data,k,*args,**kwargs)
        try:
            doc['outcomes'].append(dict(scope=scope[0], call=scope[1],
                clusters=[dict(id=str(c['id']), members=sorted(map(str,c['members']))) for c in result]))
        except Exception:doc['complete']=False
        return result
    def step(data,clusters,weights=None):
        result=original_step(data,clusters,weights)
        try:
            order=[c['id'] for c in clusters]
            if len(order)>8:order=clojure_hash_map_key_order(order)
            by_id={c['id']:c for c in clusters};membership={p:c['id'] for c in result for p in c['members']}
            norms=km._row_norms(data.matrix)
            columns=np.column_stack([km._euclidean_col(data.matrix,np.asarray(by_id[c]['center']),norms) for c in order])
            for p,scores in zip(data.row_names,columns):
                emit('min-last',p,order,scores,str(membership[p]))
        except Exception:doc['complete']=False
        return result
    def same(a,b,threshold=km.SAME_CLUSTERING_THRESHOLD):
        result=original_same(a,b,threshold)
        try:
            left=sorted((np.asarray(c['center']) for c in a),key=lambda x:tuple(x))
            right=sorted((np.asarray(c['center']) for c in b),key=lambda x:tuple(x))
            observed = True
            for i,(x,y) in enumerate(zip(left,right)):
                distance=km._center_distance(x,y)
                emit('lt','convergence:'+str(i),[],[distance],bool(distance<threshold),float(threshold))
                if not distance<threshold:
                    observed = False
                    break # actual short-circuit
            if bool(result) != observed:doc['complete']=False
        except Exception:doc['complete']=False
        return result
    def distal(data,clusters):
        result=original_distal(data,clusters)
        try:
            if not data.row_names:return result
            norms=km._row_norms(data.matrix)
            columns=[(km._euclidean_col(data.matrix,np.asarray(c['center']),norms)
                      if data.matrix_backed else km._named_row_distance_col(data.matrix,np.asarray(c['center']))) for c in clusters]
            distances=np.column_stack(columns);near=[];nearest=[]
            for p,row in zip(data.row_names,distances):
                j=len(row)-1-int(np.argmin(row[::-1]));near.append(float(row[j]));nearest.append(clusters[j]['id'])
                emit('min-last','distal-nearest:'+str(p),[c['id'] for c in clusters],row,str(clusters[j]['id']))
            winner=len(near)-1-int(np.argmax(near[::-1]))
            if (result['id'] != data.row_names[winner] or result['clst_id'] != nearest[winner]
                    or result['dist'] != near[winner]):doc['complete']=False
            emit('max-last','distal-farthest',data.row_names,near,str(result['id']))
            emit('gt','split-radius',[],[result['dist']],bool(result['dist']>0),0.)
        except Exception:doc['complete']=False
        return result
    with patch.object(conversation,'legacy_kmeans',kmeans),patch.object(km,'kmeans',kmeans),patch.object(km,'cluster_step',step),patch.object(km,'same_clustering',same),patch.object(km,'most_distal',distal):
        yield doc


def seal(directory):
    """Bind observations to the exact recording just written; failure stays unavailable."""
    import hashlib
    import json
    from pathlib import Path
    directory=Path(directory)
    for path in (directory/'py-decisions').glob('step-*.json'):
        try:
            doc=json.loads(path.read_text())
            doc['record_sha256']=hashlib.sha256((directory/'py'/path.name).read_bytes()).hexdigest()
            path.write_text(json.dumps(doc,allow_nan=False))
        except Exception:
            pass


def observed_recompute(conv, enabled):
    """An observer setup/teardown failure never reruns completed science."""
    missing = object()
    result = missing
    engine_failed = False
    unavailable = dict(schema='polis-decision-trace/1', complete=False, events=[])
    try:
        with capture(enabled) as doc:
            try:
                result = conv.recompute()
            except BaseException:
                engine_failed = True
                raise
        return result, doc
    except Exception:
        if engine_failed:
            raise
        return (conv.recompute() if result is missing else result), unavailable
