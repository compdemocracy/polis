"""The topic map step (polismath/delphi_storage/topic_map.py) on a real attempt
writer: off, a run stores what it always did; on, the run's map is stored in
its own batch, from the families it wrote, as the generator wrote it.

Generated rows only (a generated conversation of 60 comments in three topics:
positions, clusters and topic names, no comment text and no vote). Needs the
polis-topic-map binary: on PATH (the Delphi image installs it) or named by
DELPHI_TOPIC_MAP_BIN; without it the tests that run the generator are skipped.
"""
import gzip
import hashlib
import json
import logging
import shutil
import uuid
from decimal import Decimal

import pytest

from polismath import step_log
from polismath.delphi_storage import topic_map
from polismath.delphi_storage.codec import (FAMILIES, POSTGRES_FAMILIES, decode_family, encode_family,
                                            item_from_python, key_of)
from polismath.delphi_storage.postgres import RESULT_FAMILIES, TOPIC_MAP_FAMILY
from polismath.delphi_storage.writer import WriterResource

PRESERVED = {'Delphi_NarrativeReports', 'report_narrative_store', 'Delphi_CollectiveStatement', 'Delphi_TopicAgendaSelections'}
MODELS = {"embed": "generated-embedding@0:384", "topic": "none", "narrative": None,
          "cluster": "delphi-umap-evoc/1", "cluster_seed": 42}


def _binary():
    import os
    return os.environ.get(topic_map.BINARY) or shutil.which("polis-topic-map")


needs_generator = pytest.mark.skipif(_binary() is None, reason="polis-topic-map is not installed")


def _writer(tmp_path, monkeypatch, base_families=None, scope='delphi'):
    jid, run, attempt = [str(uuid.uuid4()) for _ in range(3)]
    frame = dict(schema='polis-jobs.frame/1', env='shadow-proof', zid=7, job_id=jid, run_id=run, attempt_id=attempt,
                 lease_epoch='1', config={'result_backend': 'postgres', 'result_scope': scope},
                 writer_base={'schema': 'delphi-writer-base/1', 'zid': 7, 'families': base_families or {}})
    (tmp_path / 'frame.json').write_text(json.dumps(frame))
    for key, value in dict(DELPHI_RESULT_BACKEND='postgres', DELPHI_OUTPUT_MANIFEST=str(tmp_path / 'manifest.json'),
                           DELPHI_FRAME=str(tmp_path / 'frame.json'), DELPHI_JOB_ID=jid, DELPHI_RUN_ID=run,
                           DELPHI_ATTEMPT_ID=attempt).items():
        monkeypatch.setenv(key, value)
    return WriterResource()


def _write_run(writer, zid='7'):
    """A full run's writes of the three families the map is drawn from, in
    the pipeline's row shapes: 60 comments in three topics at layer 0, one at
    layer 1."""
    writer.reset()
    graph = writer.Table('Delphi_UMAPGraph')
    clusters = writer.Table('Delphi_CommentHierarchicalClusterAssignments')
    names = writer.Table('Delphi_CommentClustersLLMTopicNames')
    centres = [(0, 0), (6, 1), (2, 7)]
    for tid in range(60):
        topic = tid % 3
        cx, cy = centres[topic]
        x = Decimal(cx) + Decimal((tid * 37) % 100) / 50
        y = Decimal(cy) + Decimal((tid * 53) % 100) / 50
        graph.put_item(Item={'conversation_id': zid, 'edge_id': f'{tid}_{tid}', 'source_id': tid, 'target_id': tid,
                             'weight': Decimal(1), 'distance': Decimal(0), 'is_nearest_neighbor': False,
                             'shared_layers': [0, 1], 'position': {'x': x, 'y': y}})
        if tid:
            graph.put_item(Item={'conversation_id': zid, 'edge_id': f'{tid - 1}_{tid}', 'source_id': tid - 1,
                                 'target_id': tid, 'weight': Decimal('0.5'), 'distance': Decimal('0.5'),
                                 'is_nearest_neighbor': True, 'shared_layers': []})
        clusters.put_item(Item={'conversation_id': zid, 'comment_id': tid, 'layer0_cluster_id': topic,
                                'layer1_cluster_id': 0, 'layer2_cluster_id': None})
    for layer, count in ((0, 3), (1, 1)):
        for cluster in range(count):
            names.put_item(Item={'conversation_id': zid, 'topic_key': f'job#{layer}#{cluster}', 'layer_id': layer,
                                 'cluster_id': cluster, 'topic_name': f'{layer}_{cluster}: Generated topic {layer}.{cluster}',
                                 'model_name': 'none'})


def _spooled(writer):
    files = writer.spool()
    return {family: decode_family((writer.directory / d['file']).read_bytes()) for family, d in files.items()}, files


@pytest.mark.parametrize('value', [None, '', '0', 'true', ' 1x'])
def test_off_nothing_runs_and_the_run_stores_what_it_always_did(tmp_path, monkeypatch, caplog, value):
    if value is None:
        monkeypatch.delenv(topic_map.SWITCH, raising=False)
    else:
        monkeypatch.setenv(topic_map.SWITCH, value)
    monkeypatch.setenv(topic_map.BINARY, '/nonexistent/polis-topic-map')
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    with caplog.at_level(logging.DEBUG):
        assert topic_map.store_run_map(7, 'participant_visible/1', MODELS, writer=writer) is None
    assert caplog.records == []
    spooled, _ = _spooled(writer)
    # A full run's reset emits these fourteen families, and never the map.
    assert set(spooled) == RESULT_FAMILIES - PRESERVED and len(spooled) == 14
    assert TOPIC_MAP_FAMILY not in spooled
    assert list(tmp_path.glob('**/topic-map-*')) == []


@needs_generator
def test_on_the_runs_map_is_stored_in_its_own_batch_as_the_generator_wrote_it(tmp_path, monkeypatch):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    stored = topic_map.store_run_map(7, 'participant_visible/1', MODELS, writer=writer)
    assert stored['outcome'] == 'map' and stored['document_bytes'] > 0, stored
    spooled, files = _spooled(writer)
    assert set(spooled) == (RESULT_FAMILIES - PRESERVED) | {TOPIC_MAP_FAMILY}
    family, rows = spooled[TOPIC_MAP_FAMILY]
    assert [r['part']['S'] for r in rows] == ['document', 'document.gz', 'execution', 'sha256']
    frame = writer.frame
    assert all(r['job_id']['S'] == frame['job_id'] and r['conversation_id']['S'] == '7' for r in rows)
    document = rows[0]['body']['S']
    assert hashlib.sha256(document.encode()).hexdigest() == rows[3]['body']['S']
    # The codec reads a binary value back as its bytes.
    assert gzip.decompress(rows[1]['body']['B']).decode() == document
    assert stored['family_bytes'] == len((writer.directory / files[TOPIC_MAP_FAMILY]['file']).read_bytes())
    doc = json.loads(document)
    assert doc['points']['text'] == [] and doc['title'] == ''
    assert sorted(doc['points']['id']) == list(range(60))
    assert [lvl['topics'] for lvl in doc['levels']] == [3, 1]
    p = doc['provenance']
    assert (p['env'], p['jobId'], p['runId'], p['batchId']) == (
        frame['env'], frame['job_id'], frame['run_id'], frame['attempt_id'])
    assert (p['scope'], p['selection'], p['models']) == ('delphi', 'participant_visible/1', MODELS)
    # Drawn from exactly the bytes the run stores for its three families.
    for entry in p['inputs']:
        wire = (writer.directory / files[entry['family']]['file']).read_bytes()
        assert entry['sha256'] == hashlib.sha256(wire).hexdigest(), entry['family']
    # Nothing is left in the attempt's scratch.
    assert list(writer.directory.glob('topic-map-*')) == []


@needs_generator
def test_a_map_carried_in_the_base_is_never_this_runs(tmp_path, monkeypatch):
    earlier = [{'conversation_id': {'S': '7'}, 'part': {'S': 'no_map'}, 'job_id': {'S': 'earlier'},
                'reason': {'S': 'no_topics'}}]
    monkeypatch.delenv(topic_map.SWITCH, raising=False)
    (tmp_path / 'off').mkdir()
    off = _writer(tmp_path / 'off', monkeypatch, base_families={TOPIC_MAP_FAMILY: earlier})
    _write_run(off)
    spooled, _ = _spooled(off)
    assert TOPIC_MAP_FAMILY not in spooled
    monkeypatch.setenv(topic_map.SWITCH, '1')
    (tmp_path / 'on').mkdir()
    on = _writer(tmp_path / 'on', monkeypatch, base_families={TOPIC_MAP_FAMILY: earlier})
    _write_run(on)
    topic_map.store_run_map(7, None, MODELS, writer=on)
    spooled, _ = _spooled(on)
    rows = spooled[TOPIC_MAP_FAMILY][1]
    assert {r['job_id']['S'] for r in rows} == {on.frame['job_id']}
    assert json.loads(rows[0]['body']['S'])['provenance']['selection'] is None


@needs_generator
def test_two_rules_make_two_maps_each_naming_its_own_run(tmp_path, monkeypatch):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    docs = []
    for scope, rule in (('delphi', 'participant_visible/1'), ('delphi:all_comments', 'all_comments/1')):
        (tmp_path / rule.replace('/', '_')).mkdir()
        writer = _writer(tmp_path / rule.replace('/', '_'), monkeypatch, scope=scope)
        _write_run(writer)
        topic_map.store_run_map(7, rule, MODELS, writer=writer)
        rows = _spooled(writer)[0][TOPIC_MAP_FAMILY][1]
        docs.append((writer.frame['job_id'], json.loads(rows[0]['body']['S'])['provenance']))
    (job_a, a), (job_b, b) = docs
    assert job_a != job_b and (a['jobId'], b['jobId']) == (job_a, job_b)
    assert (a['scope'], a['selection']) == ('delphi', 'participant_visible/1')
    assert (b['scope'], b['selection']) == ('delphi:all_comments', 'all_comments/1')


@needs_generator
def test_a_run_with_nothing_to_draw_stores_one_no_map_row(tmp_path, monkeypatch):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    writer = _writer(tmp_path, monkeypatch)
    writer.reset()
    writer.Table('Delphi_UMAPGraph').put_item(Item={'conversation_id': '7', 'edge_id': '1_1', 'source_id': 1,
                                                    'target_id': 1, 'position': {'x': Decimal(1), 'y': Decimal(2)}})
    writer.Table('Delphi_CommentHierarchicalClusterAssignments').put_item(
        Item={'conversation_id': '7', 'comment_id': 1, 'layer0_cluster_id': 0})
    stored = topic_map.store_run_map(7, None, MODELS, writer=writer)
    assert stored == {'outcome': 'no_map', 'reason': 'no_topics', 'family_bytes': stored['family_bytes']}
    rows = _spooled(writer)[0][TOPIC_MAP_FAMILY][1]
    assert [r['part']['S'] for r in rows] == ['execution', 'no_map']
    assert rows[1]['reason']['S'] == 'no_topics'


def _generator(tmp_path, name, body):
    script = tmp_path / name
    script.write_text('#!/bin/sh\n' + body + '\n')
    script.chmod(0o755)
    return str(script)


def test_a_generator_that_fails_stores_one_failed_row_and_the_run_goes_on(tmp_path, monkeypatch, caplog):
    """The run's other results publish; the map's family is one typed no_map
    row saying the draw failed and why, never the generator's message; an
    error is logged."""
    monkeypatch.setenv(topic_map.SWITCH, '1')
    monkeypatch.setattr(topic_map, 'TIMEOUT_SECONDS', 0.5)
    secret = 'a sentence a participant wrote'
    cases = [
        ('/nonexistent/polis-topic-map', 'did_not_run'),
        (_generator(tmp_path, 'refuses', f'echo "{secret}" >&2; exit 3'), 'refused'),
        (_generator(tmp_path, 'slow', 'sleep 5'), 'timed_out'),
        (_generator(tmp_path, 'garbage', 'for a in "$@"; do [ "$prev" = --out ] && echo "{}" > "$a"; prev="$a"; done'),
         'wrong_output'),
        # Diagnostics that are not valid UTF-8 are still a refusal, not a failed run.
        (_generator(tmp_path, 'bad-bytes', "printf '\\377\\376 out\\n'; printf '\\377\\376 err\\n' >&2; exit 3"),
         'refused'),
    ]
    # A family the codec reads but that is not a whole map: a document with no
    # gzip row, and a no_map row with no reason.
    for name, rows in (('no-gzip', [{'part': 'document', 'body': '{}', 'bytes': 2}]),
                       ('no-reason', [{'part': 'no_map'}])):
        family = tmp_path / f'{name}.jsonl'
        family.write_bytes(encode_family(TOPIC_MAP_FAMILY, [
            item_from_python({'conversation_id': '7', 'job_id': 'generator', **row}) for row in rows]))
        cases.append((_generator(tmp_path, name, f'for a in "$@"; do [ "$prev" = --out ] && cp "{family}" "$a"; '
                                                  'prev="$a"; done'), 'wrong_output'))
    for i, (binary, failure) in enumerate(cases):
        (tmp_path / f'{i}-{failure}').mkdir()
        # A map an earlier batch carried forward is never left beside the row.
        earlier = [{'conversation_id': {'S': '7'}, 'part': {'S': 'document'}, 'job_id': {'S': 'earlier'},
                    'body': {'S': '{}'}, 'bytes': {'N': '2'}, 'schema': {'S': 'polis-topic-map/1'}}]
        writer = _writer(tmp_path / f'{i}-{failure}', monkeypatch, base_families={TOPIC_MAP_FAMILY: earlier})
        _write_run(writer)
        monkeypatch.setenv(topic_map.BINARY, binary)
        caplog.clear()
        with caplog.at_level(logging.INFO):
            stored = topic_map.store_run_map(7, None, MODELS, writer=writer)
        assert stored == {'outcome': 'no_map', 'reason': 'generator_failed', 'failure': failure,
                          'family_bytes': stored['family_bytes']}, failure
        errors = [r for r in caplog.records if r.levelno == logging.ERROR]
        assert len(errors) == 1 and failure in errors[0].getMessage(), failure
        spooled, files = _spooled(writer)
        assert set(spooled) == (RESULT_FAMILIES - PRESERVED) | {TOPIC_MAP_FAMILY}, failure
        rows = spooled[TOPIC_MAP_FAMILY][1]
        assert rows == [{'conversation_id': {'S': '7'}, 'part': {'S': 'no_map'}, 'job_id': {'S': writer.frame['job_id']},
                         'reason': {'S': 'generator_failed'}, 'failure': {'S': failure}}], failure
        wire = (writer.directory / files[TOPIC_MAP_FAMILY]['file']).read_bytes()
        assert stored['family_bytes'] == len(wire) and secret.encode() not in wire
        assert list(writer.directory.glob('topic-map-*')) == []
    assert set(f for _, f in cases) | {'not_installed'} == set(topic_map.DRAW_FAILURES)


def test_a_generator_that_is_not_installed_stores_one_failed_row(tmp_path, monkeypatch):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    monkeypatch.delenv(topic_map.BINARY, raising=False)
    monkeypatch.setattr(topic_map.shutil, 'which', lambda _name: None)
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    stored = topic_map.store_run_map(7, None, MODELS, writer=writer)
    assert (stored['reason'], stored['failure']) == ('generator_failed', 'not_installed')
    rows = _spooled(writer)[0][TOPIC_MAP_FAMILY][1]
    assert [(r['part']['S'], r['failure']['S']) for r in rows] == [('no_map', 'not_installed')]


def test_a_writer_that_cannot_hold_the_map_still_fails_the_run(tmp_path, monkeypatch):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    with pytest.raises(topic_map.TopicMapError):
        topic_map.store_run_map(8, None, MODELS, writer=writer)


def test_without_the_postgres_writer_nothing_is_stored(monkeypatch, caplog):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    monkeypatch.delenv('DELPHI_RESULT_BACKEND', raising=False)
    monkeypatch.delenv('DELPHI_OUTPUT_MANIFEST', raising=False)
    with caplog.at_level(logging.INFO):
        assert topic_map.store_run_map(7, None, MODELS) is None
    assert 'not stored' in caplog.text


@pytest.fixture
def recording(monkeypatch):
    monkeypatch.setattr(step_log, '_record', None)
    monkeypatch.delenv(step_log.SWITCH, raising=False)
    yield
    step_log._record = None


@needs_generator
def test_the_runs_record_of_its_steps_is_stored_with_its_map(tmp_path, monkeypatch, recording, capsys):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    step_log.record()
    with step_log.step('inputs') as facts:
        facts.update(selection='participant_visible/1', strict_moderation=False, comments_read=64,
                     comments_embedded=62, comments_selected=60, left_out_rejected=2)
    with step_log.step('umap', n_comments=60):
        pass
    step_log.note('umap', n_components=2, metric='cosine', n_neighbors=15, random_state=42)
    step_log.note('topic_names', layer=0, provider='anthropic', model='none', clusters=3, written_by_model=0)
    execution = topic_map.execution_record(step_log.recorded(), 'participant_visible/1')
    assert capsys.readouterr().out == ''  # recording prints nothing without DELPHI_STEP_LOG
    assert [s['step'] for s in execution['steps']] == ['inputs', 'umap']
    assert execution['selection'] == {'rule': 'participant_visible/1', 'strict_moderation': False, 'comments_read': 64,
                                      'comments_embedded': 62, 'comments_selected': 60, 'left_out': {'rejected': 2}}
    assert execution['algorithms']['umap']['n_neighbors'] == 15
    assert execution['algorithms']['topic_names'] == [
        {'layer': 0, 'provider': 'anthropic', 'model': 'none', 'clusters': 3, 'written_by_model': 0}]
    assert set(execution['unavailable']) == {'code_version', 'image'}
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    topic_map.store_run_map(7, 'participant_visible/1', MODELS, writer=writer, execution=execution)
    rows = {r['part']['S']: r for r in _spooled(writer)[0][TOPIC_MAP_FAMILY][1]}
    assert json.loads(rows['execution']['body']['S']) == execution
    assert json.loads(rows['document']['body']['S'])['provenance']['execution'] == execution


def test_without_record_a_step_keeps_nothing(recording):
    with step_log.step('umap', n_comments=1):
        pass
    step_log.note('umap', n_neighbors=15)
    assert step_log.recorded() == [] and not step_log.recording()


@needs_generator
def test_no_example_comment_of_a_keyword_label_is_stored(tmp_path, monkeypatch):
    """The reviewer's reproduction: the keyword fallback's own label for a
    cluster whose sample comment is a generated marker."""
    topic_naming = pytest.importorskip('umap_narrative.topic_naming')
    monkeypatch.setenv(topic_map.SWITCH, '1')
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    marker = 'generated-only-example'
    labels = topic_naming._conventional_labels({
        0: {'top_words': [], 'sample_comments': [marker]},
        1: {'top_words': ['water', 'land'], 'sample_comments': [marker]},
        2: {'top_words': [], 'sample_comments': []}})
    for cluster, label in labels.items():
        writer.Table('Delphi_CommentClustersLLMTopicNames').put_item(Item={
            'conversation_id': '7', 'topic_key': f'job#0#{cluster}', 'layer_id': 0,
            'cluster_id': cluster, 'topic_name': label, 'model_name': 'none'})
    topic_map.store_run_map(7, 'participant_visible/1', MODELS, writer=writer)
    rows = {r['part']['S']: r for r in _spooled(writer)[0][TOPIC_MAP_FAMILY][1]}
    document = rows['document']['body']['S']
    assert 'generated-only' not in document and 'Example' not in document
    names = {t['id']: t['name'] for t in json.loads(document)['topics']}
    assert (names['0_0'], names['0_1'], names['0_2']) == ('Topic 0', 'Keywords: water, land', 'Topic 2')
    # The layer-1 name has no recorded origin (no execution record): it is
    # not a shape the rule can check, so it is replaced.
    assert json.loads(document)['provenance']['names'] == {
        'rule': 'polis-topic-map.names/3', 'written_by_model': 0, 'generic': 1, 'keywords': 1, 'replaced': 2}


@needs_generator
def test_a_name_the_naming_recorded_as_its_models_is_stored_as_written(tmp_path, monkeypatch, recording):
    monkeypatch.setenv(topic_map.SWITCH, '1')
    step_log.record()
    step_log.note('topic_names', layer=0, provider='anthropic', model='m', clusters=3, written_by_model=2,
                  fallback=1, origin_unknown=0, model_clusters=[0, 2])
    execution = topic_map.execution_record(step_log.recorded(), None)
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    topic_map.store_run_map(7, None, MODELS, writer=writer, execution=execution)
    rows = {r['part']['S']: r for r in _spooled(writer)[0][TOPIC_MAP_FAMILY][1]}
    doc = json.loads(rows['document']['body']['S'])
    names = {t['id']: t['name'] for t in doc['topics']}
    # Layer 0's clusters 0 and 2 are the model's, as written; cluster 1 was a
    # fallback and layer 1 has no recorded origin: neither is a shape the
    # rule keeps.
    assert names == {'0_0': '0_0: Generated topic 0.0', '0_1': 'Topic 1', '0_2': '0_2: Generated topic 0.2',
                     '1_0': 'Topic 0'}
    assert doc['provenance']['names'] == {
        'rule': 'polis-topic-map.names/3', 'written_by_model': 2, 'generic': 0, 'keywords': 0, 'replaced': 2}


def test_the_map_family_is_postgres_only_and_keyed_as_its_catalog_row():
    import os
    from pathlib import Path
    assert TOPIC_MAP_FAMILY in POSTGRES_FAMILIES and TOPIC_MAP_FAMILY not in FAMILIES
    assert TOPIC_MAP_FAMILY not in RESULT_FAMILIES
    assert key_of(TOPIC_MAP_FAMILY) == [('conversation_id', 'S'), ('part', 'S')]
    root = Path(os.environ.get('POLIS_CHECKOUT_DIR') or Path(__file__).resolve().parents[2])
    migration = root / 'server/postgres/migrations/000049_add_topic_map_document_family.sql'
    if not migration.exists():
        pytest.skip('no repository checkout beside the tests')
    assert ("VALUES('Delphi_TopicMapDocument','[[\"conversation_id\", \"S\"], [\"part\", \"S\"]]'::jsonb)"
            in migration.read_text())
