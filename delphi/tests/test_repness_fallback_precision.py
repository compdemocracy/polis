"""Fallback selection uses the legacy finalized float32 comparison state."""
import json
from pathlib import Path
import random

import numpy as np
import pandas as pd
import pytest

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep import repness
from polismath.replay import driver, fixture_generate as fg, schedule
from polismath.replay.types import ReplayDataset
from polismath.replay.certify import _acceptance_projecting_comparer


def count_stats(tids=(0, 1)):
    return repness._comment_stats_from_counts(pd.DataFrame([
        dict(comment=tid, group_id=0, na=0, nd=1, ns=3,
             other_agree=0, other_disagree=0, other_votes=3) for tid in tids
    ]))


@pytest.mark.parametrize('preserve_order', [False, True])
def test_integer_count_witness(preserve_order):
    stats = count_stats()
    assert stats.iloc[0].rdt == pytest.approx(0.7302967433402214)
    assert float(np.float32(stats.iloc[0].rdt)) < stats.iloc[0].rdt
    rows, best_agree = repness.select_rep_comments_df(stats, preserve_order=preserve_order)
    assert best_agree is None
    assert rows.comment_id.tolist() == [1]
    published = Conversation._legacy_repness_entry(rows.to_dict('records')[0])
    assert published['tid'] == 1
    assert published['repness-test'] == float(np.float32(stats.iloc[0].rdt))
    # Publication conversion must not round the raw statistics in the selector.
    assert rows.iloc[0].rdt == stats.iloc[1].rdt


@pytest.mark.parametrize('first,second,winner', [
    (0.7302967433402214, 0.7302967433402214, 1),  # rounded down: later wins
    (0.7, 0.7, 1),                              # rounded down
    (0.8, 0.8, 0),                              # rounded up: first wins
    (0.75, 0.75, 0),                            # exactly representable tie
    (0.8, 0.800000005, 0),                       # raw improvement below rounded best
    (0.8, 0.80000002, 1),                        # above rounded best
    (0.7302967433402214, 0.73029674, 1),           # raw decrease above rounded best
])
def test_fallback_precision_boundaries(first, second, winner):
    stats = count_stats()
    stats['rdt'] = [first, second]
    rows, best_agree = repness.select_rep_comments_df(stats, preserve_order=True)
    assert best_agree is None
    assert rows.comment_id.tolist() == [winner]


@pytest.mark.parametrize('preserve_order,expected', [(True, 0), (False, 1)])
def test_order_and_moderation_are_preserved(preserve_order, expected):
    stats = count_stats((1, 0))
    rows, _ = repness.select_rep_comments_df(stats, preserve_order=preserve_order)
    assert rows.comment_id.tolist() == [expected]
    rows, _ = repness.select_rep_comments_df(stats, mod_out=[expected], preserve_order=preserve_order)
    assert rows.comment_id.tolist() == [1 - expected]


def test_six_cut_public_paired_counts_match_legacy():
    fixture = json.loads((Path(__file__).parent / 'replay_harness/fixtures/repness_paired_counts.json').read_text())
    votes, _, _ = fg.build_case_rows(
        dict(shape='sparse-strip', participants=72, comments=60, votes_per_participant=60),
        random.Random(20260923))
    rng = random.Random(20260923)
    values = {(p, t): int(rng.random() < .3) for p in range(72) for t in range(30)}
    # Generated event rows use raw-DB signs; ReplayDataset accepts export signs.
    dataset = ReplayDataset.build([(v['created'], v['pid'], v['tid'],
                                    -values[v['pid'], v['tid'] // 2]) for v in votes])
    spec = schedule.ScheduleSpec.from_dict(fixture['schedule'])
    records = driver.run_replay(dataset, spec)
    assert len(records) == 6
    for record, expected in zip(records, fixture['repness']):
        actual = json.loads(json.dumps(record.blob['repness']))
        assert _acceptance_projecting_comparer().compare_step(
            {'repness': expected}, {'repness': actual}, record.index)['match']
        assert actual.keys() == expected.keys()
        for gid, rows in expected.items():
            assert len(actual[gid]) == len(rows)
            for got, want in zip(actual[gid], rows):
                assert got.keys() == want.keys()
                for key in ('tid', 'n-success', 'n-trials', 'repful-for'):
                    assert got[key] == want[key]
                # Cheshire prints a Float's shortest decimal, Python a double's.
                # Compare their exact float32 bit patterns, not decimal spelling.
                assert np.float32(got['repness-test']).tobytes() == np.float32(want['repness-test']).tobytes()
