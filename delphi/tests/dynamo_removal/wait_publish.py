from contextlib import closing
"""Observe actual jobs, assert independent retry, then publish one coherent bundle."""
import json,os,time
from pathlib import Path
import psycopg2
from job_graph_client import GraphClient
from polismath.delphi_storage.postgres import PostgresResultReader
root=Path('/proof'); admitted=json.loads((root/'demo-admitted.json').read_text())
with closing(psycopg2.connect(os.environ['QUEUE_DATABASE_URL'])) as conn:
    client=GraphClient(conn,'demo1424')
    # Bound the proof without changing worker leases.
    deadline=time.monotonic()+1800
    prior=None
    while time.monotonic()<deadline:
        state=client.status(admitted['graph_id'])
        status={n['key']:n['readiness']['state'] for n in state['nodes']}
        if status!=prior: print(json.dumps(status),flush=True);prior=status
        if all(s=='succeeded' for s in status.values()):break
        if any(s in ('dead','cancelled','parked') for s in status.values()):raise RuntimeError(state)
        time.sleep(1)
    else:raise RuntimeError('graph completion deadline exceeded')
    nodes={n['key']:n for n in state['nodes']}
    publication=client.publish(admitted['graph_id'],nodes['n']['job_id'],0)
    assert publication['outcome']=='published',publication
    bundle=PostgresResultReader(conn,'demo1424').read_served_bundle(1424,'delphi')
    counts={k:len(v) for k,v in bundle['families'].items()}
    assert counts['Delphi_CommentEmbeddings']==admitted['statements']==316
    assert counts['Delphi_CommentHierarchicalClusterAssignments']==316
    assert counts['Delphi_CommentClustersLLMTopicNames']>0
    assert counts['Delphi_NarrativeReports']>0
    # Bind coverage to the computed topic structure, so omitting a name and its
    # report together cannot make a partial narrative publication pass.
    job=nodes['n']['job_id']
    structure=bundle['families']['Delphi_CommentClustersStructureKeywords']
    expected_topics={f"{job}#{int(t['layer_id'])}#{int(t['cluster_id'])}" for t in structure}
    assert len(expected_topics)==len(structure)>0, 'duplicate computed topic'
    names=bundle['families']['Delphi_CommentClustersLLMTopicNames']
    assert len(names)==len(expected_topics) and {t['topic_key'] for t in names}==expected_topics, 'complete topic names required'
    expected_sections={key.replace('#','_') for key in expected_topics}
    expected_sections.update(f'{job}_global_{name}' for name in ('groups','group_informed_consensus','uncertainty'))
    reports=bundle['families']['Delphi_NarrativeReports']
    assert len(reports)==len(expected_sections), 'duplicate or missing report section'
    assert {row['section'] for row in reports}==expected_sections, 'complete topic and global reports required'
    assert all(row['job_id']==job for row in reports), 'reports must belong to published narrative job'
    assert all(row['metadata']['provider_fixture'] is True and json.loads(row['report_data'])['provider_fixture'] is True for row in reports)
    assert all(row['model']=='local-narrative-fixture/1' for row in reports)
with psycopg2.connect(os.environ['DATABASE_URL']) as conn:
    with conn.cursor() as cur:
        cur.execute('SELECT stage,attempt_count FROM polis_queue_jobs WHERE env=%s AND job_id=ANY(%s::uuid[])',('demo1424',[n['job_id'] for n in nodes.values()]))
        attempts=dict(cur.fetchall())
        assert attempts['graph_embed']==1 and attempts['graph_cluster']==2,attempts
        assert attempts['graph_topics']==1 and attempts['graph_narrative']==1,attempts
receipt={'statement_count':316,'attempts':attempts,'published_generation':bundle['generation'],'family_rows':counts,'provider':'fixed stand-in; no LLM calls'}
(root/'demo-result.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt),flush=True)
