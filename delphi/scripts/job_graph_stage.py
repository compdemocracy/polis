#!/usr/bin/env python3
"""Offline graph dispatch with image provenance and typed producer checks.

Durable writes stay in the daemon. Reference implementations are available
only when the separate test adapter module is installed.
"""
import hashlib
import json
import os
from pathlib import Path
import sys


def run(frame):
    if frame['schema'] != 'polis-job-stage-frame/1':
        raise ValueError('unsupported frame')
    if hashlib.sha256(frame['input_json'].encode()).hexdigest() != frame['input_sha256']:
        raise ValueError('resolved input digest mismatch')
    # Execute the exact digest-bound SQL wire. The redundant Rust JSON value may
    # reserialize floating-point summary metrics differently; it is never input.
    inp = json.loads(frame['input_json'])
    frame = {**frame, 'input': inp}
    declared = inp['declared']
    if inp['schema'] != 'polis-job-input/1' or declared['mode'] != 'full':
        raise ValueError('unsupported execution mode')
    if declared['code'] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest() or declared['runtime'] != 'python-'+sys.version.split()[0]:
        raise ValueError('worker code/runtime differs from declared provenance')
    stage = frame['stage']
    from graph_registry import validate_inputs
    implementation = validate_inputs(frame)
    if implementation['adapter'] == 'import':
        from polismath.delphi_storage.legacy_import import execute_import
        output = execute_import(frame)
        payload = json.dumps(output, sort_keys=True, separators=(',', ':'), allow_nan=False)
        if len(payload.encode()) > 524288:
            raise ValueError('stage artifact exceeds 512 KiB')
        return dict(schema='polis-job-artifact-manifest/1',job_id=frame['job_id'],run_id=frame['run_id'],attempt_id=frame['attempt_id'],stage=stage,
                    input_sha256=frame['input_sha256'],outcome='succeeded',output=dict(role='result',schema=stage+'/1',payload=payload,sha256=hashlib.sha256(payload.encode()).hexdigest()))
    if implementation['adapter'] == 'numerical':
        from delphi_graph_stages import execute, code_digest
        if declared['config'].get('adapter_sha256') != code_digest():
            raise ValueError('numerical adapter provenance mismatch')
        output = execute(frame)
        if os.environ.get('DELPHI_OUTPUT_MANIFEST'):
            files = output.pop('family_files')
            directory = Path(os.environ['DELPHI_OUTPUT_MANIFEST']).parent
            output['family_spool'] = {}
            for family, wire in files.items():
                filename = family + '.jsonl'
                (directory / filename).write_text(wire, encoding='utf-8')
                output['family_spool'][family] = dict(file=filename, sha256=hashlib.sha256(wire.encode()).hexdigest())
            # With the embeddings table on, graph_embed returns rows to spool for
            # the daemon's pd_embedding_put instead of a codec family.
            embedding_rows = output.pop('_embedding_rows', None)
            if embedding_rows is not None:
                from polismath.delphi_storage.embedding_spool import write_spool
                spool_rows = [(row['tid'], bytes.fromhex(row['text_sha']), row['vector']) for row in embedding_rows['rows']]
                data = write_spool(embedding_rows['model'], embedding_rows['dims'], spool_rows)
                (directory / 'embeddings.spool').write_bytes(data)
                output['embedding_spool'] = dict(file='embeddings.spool', sha256=hashlib.sha256(data).hexdigest(),
                    model=embedding_rows['model'], dims=embedding_rows['dims'], rows=len(spool_rows))
        payload = json.dumps(output, sort_keys=True, separators=(',', ':'), allow_nan=False)
        if len(payload.encode()) > 524288:
            raise ValueError('stage artifact exceeds 512 KiB')
        return dict(schema='polis-job-artifact-manifest/1',job_id=frame['job_id'],run_id=frame['run_id'],attempt_id=frame['attempt_id'],stage=stage,
                    input_sha256=frame['input_sha256'],outcome='succeeded',output=dict(role='result',schema=stage+'/1',payload=payload,sha256=hashlib.sha256(payload.encode()).hexdigest()))
    from graph_registry import _test_models
    if _test_models is None:
        raise ValueError('reference adapter absent from this build')
    output = _test_models.reference(frame)
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
