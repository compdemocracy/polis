#!/usr/bin/env python3
"""Peak memory of each Delphi shadow graph stage on one public conversation.

    graph_stage_memory.py run IMAGE OUT [COMMENTS_CSV]

Runs the four graph stages (graph_embed, graph_cluster, graph_topics,
graph_narrative) one after another, each in a fresh container of IMAGE (a
Delphi image built from delphi/Dockerfile) under the graph executor's default
limits (DELPHI_SHADOW_GRAPH_CONTAINER_MEMORY 6 GiB, or GRAPH_STAGE_MEMORY_LIMIT;
_CPUS 2) and the thread
settings the executor's daemon sets behind a 2-CPU limit, with the models the
shadow's graph declares (the image's pinned embedding model, UMAP with EVoC,
TF-IDF keywords, keyword labels) and the embeddings table on, as the executor
runs them. Each stage is called through the adapter the stage child calls
(delphi_graph_stages.execute), on the previous stage's output; the executor's
own queue, claim and artifact writes are not part of it. One line per stage
in OUT/memory.json: the stage process's peak resident set (getrusage), the
container's peak memory charge (cgroup memory.peak, which counts the page
cache of the model files it read) and its seconds.

The comments are a public export's (default: the public biodiversity
conversation in delphi/real_data), every comment with text, in comment-id
order. No vote is read.
"""
import csv
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess as sp
import sys
import time

HERE = Path(__file__).resolve().parent
DEFAULT_CSV = 'real_data/r4tykwac8thvzv35jrn53-biodiversity/2025-11-11-1704-r4tykwac8thvzv35jrn53-comments.csv'
STAGES = ['graph_embed', 'graph_cluster', 'graph_topics', 'graph_narrative']
MODEL_DIR = '/opt/polis/embedding/granite-embedding-311m-multilingual-r2'
# GRAPH_STAGE_MEMORY_LIMIT tries another ceiling (a Docker memory value).
LIMITS = dict(memory=os.environ.get('GRAPH_STAGE_MEMORY_LIMIT', '6g'), cpus='2', threads='2')


def run(image, out, comments_csv):
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    work = out / 'work'
    work.mkdir(exist_ok=True)
    rows = sorted((r for r in csv.DictReader(open(comments_csv, newline='')) if r['comment-body'].strip()),
                  key=lambda r: int(r['comment-id']))
    snapshot = dict(ids=[int(r['comment-id']) for r in rows], texts=[r['comment-body'] for r in rows])
    (work / 'snapshot.json').write_text(json.dumps(snapshot))
    results = []
    for stage in STAGES:
        args = ['docker', 'run', '--rm', '--memory', LIMITS['memory'], '--cpus', LIMITS['cpus'],
                '-v', f'{HERE}:/measure:ro', '-v', f'{work}:/work', '--entrypoint', 'python3']
        env = dict(DELPHI_EMBED_MODEL_PATH=MODEL_DIR, DELPHI_EMBED_MODEL_LOCK=MODEL_DIR + '.lock.json',
                   HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', DELPHI_OUTPUT_MANIFEST='/work/manifest.json',
                   **{k: LIMITS['threads'] for k in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMBA_NUM_THREADS')})
        for key, value in env.items():
            args += ['-e', f'{key}={value}']
        p = sp.run(args + [image, '/measure/graph_stage_memory.py', 'stage', stage, '/work'],
                   capture_output=True, text=True)
        (out / f'{stage}.log').write_text(p.stdout + p.stderr)
        if p.returncode != 0:
            raise SystemExit(f'{stage} failed ({p.returncode}); see {out / (stage + ".log")}')
        line = json.loads(p.stdout.strip().splitlines()[-1])
        results.append(line)
        print(json.dumps(line), flush=True)
    image_id = sp.run(['docker', 'image', 'inspect', '-f', '{{.Id}}', image], capture_output=True, text=True).stdout.strip()
    (out / 'memory.json').write_text(json.dumps(dict(image=image, image_id=image_id, limits=LIMITS,
        comments=len(rows), source=str(comments_csv), stages=results), indent=2) + '\n')


def stage(name, work):
    work = Path(work)
    sys.path.insert(0, '/app/scripts')
    import delphi_graph_stages as stages
    snap = json.loads((work / 'snapshot.json').read_text())
    config = dict(comment_ids=snap['ids'], adapter_sha256=stages.code_digest())
    model = {'graph_embed': stages.GRANITE, 'graph_narrative': stages.KEYWORD_MODEL}.get(name, stages.MODELS[name])
    artifacts = {}

    def artifact(stage_name, role):
        value = json.loads((work / f'{stage_name}.json').read_text())
        value.pop('family_files', None)
        payload = json.dumps(value)
        return dict(schema=stage_name + '/1', payload=payload, producer=stage_name + '-job',
                    sha256=hashlib.sha256(payload.encode()).hexdigest())

    frame = dict(schema='polis-job-stage-frame/1', stage=name, zid=1, job_id=name + '-job',
                 run_id='run', attempt_id='attempt')
    if name == 'graph_embed':
        config['model_sha256'] = stages.model_digest(os.environ['DELPHI_EMBED_MODEL_PATH'])
        frame['embeddings_table'] = True
    elif name == 'graph_cluster':
        data = (work / 'embeddings.set.spool').read_bytes()
        frame['embeddings_table'] = True
        frame['embedding_spool'] = dict(file='embeddings.set.spool', sha256=hashlib.sha256(data).hexdigest())
    elif name == 'graph_topics':
        artifacts['clusters'] = artifact('graph_cluster', 'clusters')
    else:
        artifacts['topics'] = artifact('graph_topics', 'topics')
    frame['input'] = dict(schema='polis-job-input/1', artifacts=artifacts, declared=dict(
        model=model, mode='full', seed=42, snapshot=dict(data=dict(texts=snap['texts'])), config=config))
    t0 = time.monotonic()
    output = stages.execute(frame)
    seconds = time.monotonic() - t0
    if name == 'graph_embed':
        # The spool the executor's daemon writes for graph_cluster, written
        # by the module the stage adapter itself loads.
        rows = output.pop('_embedding_rows')
        data = stages._espool.write_spool(rows['model'], rows['dims'],
                           [(row['tid'], bytes.fromhex(row['text_sha']), row['vector']) for row in rows['rows']])
        (work / 'embeddings.set.spool').write_bytes(data)
    (work / f'{name}.json').write_text(json.dumps(output))
    peak = Path('/sys/fs/cgroup/memory.peak')
    print(json.dumps(dict(stage=name, model=model, comments=len(snap['ids']), seconds=round(seconds, 2),
        peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        cgroup_peak_bytes=int(peak.read_text()) if peak.exists() else None)))


if __name__ == '__main__':
    if sys.argv[1:2] == ['run'] and len(sys.argv) in (4, 5):
        run(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) == 5 else HERE.parents[1] / DEFAULT_CSV)
    elif sys.argv[1:2] == ['stage'] and len(sys.argv) == 4:
        stage(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
