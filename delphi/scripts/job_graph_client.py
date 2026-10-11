#!/usr/bin/env python3
"""Internal graph admission/status/result adapter. Caller supplies authorized namespace.

A queue executor connection, never the main application/admin DB credential.
No HTTP endpoint or end-user authentication is implied by this internal adapter.
"""
import argparse
from contextlib import closing
import json
import os
import psycopg2


class GraphClient:
    def __init__(self, connection, environment):
        self.connection = connection
        self.environment = environment

    def _call(self, function, *arguments):
        with self.connection:
            with self.connection.cursor() as cursor:
                cursor.execute('SELECT public.'+function+'('+','.join(['%s']*(len(arguments)+1))+')', (self.environment,)+arguments)
                return cursor.fetchone()[0]

    def admit(self, zid, scope, request_key, specification, supersedes=None):
        return self._call('pd_graph_admit',zid,scope,request_key,json.dumps(specification),supersedes)

    def status(self, graph_id):
        return self._call('pd_graph_view',graph_id)

    def served(self, zid, scope):
        return self._call('pd_graph_served',zid,scope)

    def publish(self, graph_id, job_id, expected_generation):
        return self._call('pd_graph_publish',graph_id,job_id,expected_generation)




def numerical_spec(texts, comment_ids, report_id, snapshot_sha256, model_sha256, *, max_attempts=3, narrative_context=None):
    """Build four independent jobs; pg computes snapshot_sha256 with pd_graph_hash.

    Result families use the daemon spool; numerical artifacts retain a strict
    512 KiB cap. Input is never truncated to meet that cap.
    """
    import hashlib
    from pathlib import Path
    import sys
    from delphi_graph_stages import MODELS, code_digest
    if not 5 <= len(texts) <= 2000 or len(comment_ids) != len(texts):
        raise ValueError('expected 5–2000 explicitly identified statements')
    config = dict(comment_ids=comment_ids, report_id=report_id, model_sha256=model_sha256,
                  adapter_sha256=code_digest())
    snapshot = dict(data=dict(texts=texts), sha256=snapshot_sha256)
    code = hashlib.sha256(Path(__file__).with_name('job_graph_stage.py').read_bytes()).hexdigest()
    nodes = []
    for key, stage, inputs in [('e','graph_embed',[]), ('c','graph_cluster',[dict(node='e',role='embeddings')]),
                              ('t','graph_topics',[dict(node='c',role='clusters')]),
                              ('n','graph_narrative',[dict(node='t',role='topics')])]:
        nodes.append(dict(key=key,stage=stage,**{'class':'delphi'},
            declared=dict(snapshot=snapshot,code=code,model=MODELS[stage],runtime='python-'+sys.version.split()[0],
                          seed=42,config=({**config, 'narrative_context': narrative_context} if stage == 'graph_narrative' and narrative_context is not None else config),mode='full',memory_bytes=4294967296,work_units=len(texts)),
            inputs=inputs,max_attempts=max_attempts))
    return dict(schema='polis-job-graph/1',nodes=nodes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env',required=True)
    sub = parser.add_subparsers(dest='command',required=True)
    status = sub.add_parser('status'); status.add_argument('graph_id')
    served = sub.add_parser('served'); served.add_argument('zid',type=int); served.add_argument('scope')
    admit = sub.add_parser('admit-snapshot')
    admit.add_argument('zid',type=int); admit.add_argument('scope'); admit.add_argument('request_key')
    admit.add_argument('snapshot',help='JSON object: texts, comment_ids, report_id; demo only')
    admit.add_argument('--model-path',required=True)
    args = parser.parse_args()
    with closing(psycopg2.connect(os.environ['QUEUE_DATABASE_URL'])) as connection:
        client = GraphClient(connection,args.env)
        if args.command == 'admit-snapshot':
            from pathlib import Path
            from delphi_graph_stages import model_digest
            snapshot = json.loads(Path(args.snapshot).read_text())
            with connection.cursor() as cursor:
                cursor.execute('SELECT public.pd_graph_hash(%s::jsonb)',(json.dumps(dict(texts=snapshot['texts'])),))
                snapshot_sha = cursor.fetchone()[0]
            spec = numerical_spec(snapshot['texts'],snapshot['comment_ids'],snapshot['report_id'],snapshot_sha,
                                  model_digest(args.model_path))
            result = client.admit(args.zid,args.scope,args.request_key,spec)
        elif args.command == 'status':
            result = client.status(args.graph_id)
        else:
            result = client.served(args.zid,args.scope)
        print(json.dumps(result,sort_keys=True,indent=2))


if __name__ == '__main__':
    main()
