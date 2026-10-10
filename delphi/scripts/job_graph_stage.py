#!/usr/bin/env python3
"""Small, offline reference graph stages. No live DB, provider, reset or serving writes.

This adapter proves the artifact contract, not migration of Delphi's UMAP/LLM
pipeline. Its closed model IDs distinguish it from production model outputs.
"""
import hashlib
import json
import os
from pathlib import Path
import sys


def run(frame):
    if frame['schema'] != 'polis-job-stage-frame/1':
        raise ValueError('unsupported frame')
    inp = frame['input']
    if hashlib.sha256(frame['input_json'].encode()).hexdigest() != frame['input_sha256'] or json.loads(frame['input_json']) != inp:
        raise ValueError('resolved input digest mismatch')
    declared = inp['declared']
    if inp['schema'] != 'polis-job-input/1' or declared['mode'] != 'full':
        raise ValueError('unsupported execution mode')
    if declared['code'] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest() or declared['runtime'] != 'python-'+sys.version.split()[0]:
        raise ValueError('worker code/runtime differs from declared provenance')
    stage = frame['stage']
    for artifact in inp['artifacts'].values():
        if hashlib.sha256(artifact['payload'].encode()).hexdigest() != artifact['sha256']:
            raise ValueError('artifact content mismatch')
    if stage == 'graph_embed':
        if declared['model'] != 'local-token-count/1':
            raise ValueError('unsupported embedding model')
        texts = declared['snapshot']['data']['texts']
        if not texts or len(texts) > 100 or any(not isinstance(t, str) or len(t)>4096 for t in texts):
            raise ValueError('bounded text snapshot required')
        vocabulary = sorted({word for text in texts for word in text.lower().split()})
        output = {'vocabulary': vocabulary, 'vectors': [[text.lower().split().count(w) for w in vocabulary] for text in texts]}
    elif stage == 'graph_cluster':
        if declared['model'] != 'local-nearest-centroid/1':
            raise ValueError('unsupported cluster model')
        vectors = json.loads(inp['artifacts']['embeddings']['payload'])['vectors']
        # Deterministic small reference Lloyd fit; independent of legacy resets.
        centers = [list(map(float, v)) for v in (vectors[0], vectors[-1])]
        labels = []
        for _ in range(20):
            labels = [min(range(len(centers)), key=lambda k: sum((a-b)**2 for a,b in zip(v, centers[k]))) for v in vectors]
            updated = [[sum(v[d] for v,l in zip(vectors, labels) if l==k)/labels.count(k) if k in labels else centers[k][d] for d in range(len(vectors[0]))] for k in range(len(centers))]
            if updated == centers:
                break
            centers = updated
        output = {'labels': labels, 'centers': centers}
    elif stage == 'graph_narrative':
        if declared['model'] != 'local-cluster-summary/1':
            raise ValueError('unsupported narrative model; paid adapters need admission and budget integration')
        clusters = json.loads(inp['artifacts']['clusters']['payload'])
        output = {'text': f"{len(clusters['labels'])} statements in {len(set(clusters['labels']))} clusters.", 'labels': clusters['labels']}
    else:
        raise ValueError('unsupported stage')
    payload = json.dumps(output, sort_keys=True, separators=(',', ':'))
    return dict(schema='polis-job-artifact-manifest/1',job_id=frame['job_id'],run_id=frame['run_id'],attempt_id=frame['attempt_id'],stage=stage,
                input_sha256=frame['input_sha256'],outcome='succeeded',output=dict(role='result',schema=stage+'/1',payload=payload,sha256=hashlib.sha256(payload.encode()).hexdigest()))


if __name__ == '__main__':
    frame = json.loads(Path(os.environ['DELPHI_FRAME']).read_text())
    manifest = run(frame)
    path = Path(os.environ['DELPHI_OUTPUT_MANIFEST'])
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(manifest, sort_keys=True, separators=(',', ':')))
    temporary.replace(path)
