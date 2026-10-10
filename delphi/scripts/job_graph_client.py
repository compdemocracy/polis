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


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env',required=True)
    sub=parser.add_subparsers(dest='command',required=True)
    status=sub.add_parser('status'); status.add_argument('graph_id')
    served=sub.add_parser('served'); served.add_argument('zid',type=int);served.add_argument('scope')
    args=parser.parse_args()
    with closing(psycopg2.connect(os.environ['QUEUE_DATABASE_URL'])) as connection:
        client=GraphClient(connection,args.env)
        result=client.status(args.graph_id) if args.command=='status' else client.served(args.zid,args.scope)
        print(json.dumps(result,sort_keys=True,indent=2))
