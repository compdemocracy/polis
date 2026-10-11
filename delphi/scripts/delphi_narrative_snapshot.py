"""Read one consistent, sign-aware narrative summary from local Postgres.

Uses the existing Delphi GroupDataProcessor and semantic vote loader. No votes
are written; no Dynamo client is initialized. Raw votes never enter job frames.
"""
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
for path in [ROOT, ROOT/'umap_narrative']:
    if str(path) not in sys.path:
        sys.path.insert(0,str(path))



def unfold_group_assignments(math):
    """Expand the math contract's base-cluster IDs, never mistake them for PIDs."""
    base = math.get('base-clusters')
    groups = math.get('group-clusters')
    if (not isinstance(base, dict) or not isinstance(base.get('id'), list)
            or not isinstance(base.get('members'), list)
            or len(base['id']) != len(base['members']) or not isinstance(groups, list)):
        raise ValueError('invalid folded group mapping shape')

    def identity(value):
        if type(value) is not int or value < 0:
            raise ValueError('invalid folded group mapping identity')
        return value

    mapping = {}
    participants = set()
    for bid, members in zip(base['id'], base['members']):
        identity(bid)
        if bid in mapping or not isinstance(members, list):
            raise ValueError('duplicate or invalid base cluster')
        mapping[bid] = members
        for pid in members:
            identity(pid)
            if pid in participants:
                raise ValueError('duplicate participant in base clusters')
            participants.add(pid)
    assignments, unfolded, used_bids, seen_groups = {}, [], set(), set()
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('members'), list):
            raise ValueError('invalid folded group')
        gid = identity(group.get('id'))
        if gid in seen_groups:
            raise ValueError('duplicate group identity')
        seen_groups.add(gid)
        members = []
        for bid in group['members']:
            identity(bid)
            if bid not in mapping or bid in used_bids:
                raise ValueError('missing or multiply assigned base cluster')
            used_bids.add(bid)
            members.extend(mapping[bid])
        for pid in members:
            assignments[str(pid)] = gid
        unfolded.append((gid, members))
    if not assignments:
        raise ValueError('empty folded group assignments')
    if 'group_clusters' in math:
        alias = math['group_clusters']
        if not isinstance(alias, list) or len(alias) != len(unfolded):
            raise ValueError('unfolded group alias mismatch')
        for group, (gid, members) in zip(alias, unfolded):
            if not isinstance(group, dict) or not isinstance(group.get('members'), list):
                raise ValueError('invalid unfolded group alias')
            identity(group.get('id'))
            for pid in group['members']:
                identity(pid)
            if group['id'] != gid or group['members'] != members:
                raise ValueError('unfolded group alias mismatch')
    return assignments


def build_narrative_context(connection, zid, math_env):
    from psycopg2.extras import RealDictCursor
    from polismath_commentgraph.utils.storage import PostgresClient
    from polismath_commentgraph.utils.group_data import GroupDataProcessor
    from polismath.utils.vote_convention import RowConventionSource, database_row_fetcher, using_convention_source

    class BoundClient(PostgresClient):
        def __init__(self):
            pass

        def query(self, query, params=None):
            query = re.sub(r'(?<!:):([A-Za-z_]\w*)', r'%(\1)s', query)
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(query, params or {})
                return [dict(row) for row in cursor.fetchall()]

    client = BoundClient()
    math_rows = client.query('SELECT data FROM math_main WHERE zid=:zid AND math_env=:math_env ORDER BY modified DESC LIMIT 1',
                             dict(zid=zid,math_env=math_env))
    if not math_rows:
        raise ValueError('required math result unavailable for narrative snapshot')
    math = math_rows[0]['data']
    if isinstance(math,str):
        math=json.loads(math)

    assignments = unfold_group_assignments(math)
    snapshot_math = dict(math, group_assignments=assignments)

    class SnapshotProcessor(GroupDataProcessor):
        def init_dynamodb(self):
            self.dynamodb = self.extremity_table = None

        def store_comment_extremity(self, *args, **kwargs):
            pass

        def get_math_main_by_conversation(self, zid):
            return snapshot_math

    with using_convention_source(RowConventionSource(database_row_fetcher(client.query))):
        exported = SnapshotProcessor(client).get_export_data(zid, False)
    comments = exported.get('comments',[])
    if not comments:
        raise ValueError('empty narrative export; refuse missing vote evidence')
    extremity = dict(zip(map(str,math.get('tids',[])),math.get('pca',{}).get('comment-extremity',[])))
    consensus = math.get('group-aware-consensus',{})
    for comment in comments:
        tid=str(comment['comment_id'])
        comment.pop('comment',None)  # Text comes from the separately bound statement snapshot.
        comment['comment_extremity']=extremity.get(tid,0)
        comment['group_aware_consensus']=consensus.get(tid,0)
    wire=json.dumps(math,sort_keys=True,separators=(',',':'),allow_nan=False)
    return dict(schema='delphi-narrative-context/1',math_env=math_env,math_sha256=hashlib.sha256(wire.encode()).hexdigest(),
                comments=comments,source_convention='semantic:+1=agree',
                group_mapping='base-clusters-unfold/1',
                group_assignments_sha256=hashlib.sha256(json.dumps(assignments,sort_keys=True,separators=(',',':')).encode()).hexdigest())
