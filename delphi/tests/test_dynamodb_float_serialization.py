"""
Regression test for the production Delphi_RepresentativeComments write crash:

    botocore ...: Float types are not supported. Use Decimal types instead.
    File ".../polismath/database/dynamodb.py", line 462, in write_conversation
        batch.put_item(Item={...})

Root cause (SYSTEMATIC, not data-dependent)
--------------------------------------------
`conv_repness` builds the `group_id` column with
`.map(ptpt_to_group)` (repness.py:239). Any participant who voted but is
not assigned to a group maps to NaN, which upcasts the *entire* `group_id`
column to float64. `dropna(subset=['group_id'])` removes those rows but the
column keeps its float64 dtype. Every `gid` that then flows out through
`comment_repness.to_dict('records')` (repness.py:~831) is therefore a
`numpy.float64`.

`to_dynamo_dict` passes that value straight through
(`'group_id': gid`, conversation.py:~2485) — only the `repness` score is
Decimal-converted — and `write_conversation` writes it raw into the
`Delphi_RepresentativeComments` item. `numpy.float64` is a subclass of
Python `float`, so boto3's serializer raises the exact error above.

Because real conversations almost always contain at least one ungrouped
voter, the column is float64 on essentially every grouped conversation —
hence "systematic", as reported.

Why CI never caught this
------------------------
The existing DynamoDB tests (e.g. test_dynamodb_consensus_roundtrip.py)
replace the boto3 `Table` with a `unittest.mock.MagicMock`. A MagicMock
`put_item` / `batch_writer` merely *records* the Item — it never runs
boto3's real `TypeSerializer`, which is the only thing that raises on a
float. The only tests that exercise a real DynamoDB serializer
(test_batch_id.py, test_math_pipeline_runs_e2e.py, test_postgres_real_data.py)
are all in the skip list (no DynamoDB in CI/VM).

These tests use boto3's REAL `TypeSerializer` — the same code path
`batch.put_item` runs — so they reproduce the production failure with no
live DynamoDB, and would have caught it in CI.
"""

import pandas as pd
import pytest
from boto3.dynamodb.types import TypeSerializer

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep.repness import conv_repness


# ---------------------------------------------------------------------------
# Fixtures — a tiny but realistic grouped conversation
# ---------------------------------------------------------------------------

# AGREE=1, DISAGREE=-1, PASS=0, unvoted=NaN. Rows are pids, columns are tids.
# pid 4 votes but belongs to NO group: that is what injects a NaN into the
# `.map(ptpt_to_group)` result and upcasts the group_id column to float64.
# This mirrors every real conversation, where some voters are ungrouped.
def _vote_matrix() -> pd.DataFrame:
    return pd.DataFrame(
        [
            [1.0, 1.0, -1.0],   # pid 0  -> group 0
            [1.0, -1.0, 0.0],   # pid 1  -> group 0
            [-1.0, 1.0, 1.0],   # pid 2  -> group 1
            [-1.0, 1.0, -1.0],  # pid 3  -> group 1
            [1.0, 0.0, -1.0],   # pid 4  -> ungrouped (drives the float64 upcast)
        ],
        index=[0, 1, 2, 3, 4],
        columns=[10, 11, 12],
    )


def _groups():
    return [
        {'id': 0, 'members': [0, 1]},
        {'id': 1, 'members': [2, 3]},
    ]


def _assert_dynamodb_serializable(value, *, context):
    """Run boto3's real serializer — the same one `batch.put_item` uses.

    Raises the production TypeError ("Float types are not supported. Use
    Decimal types instead.") on any Python/numpy float, and "Unsupported
    type" on a bare numpy.int64. Passing means the value is a clean
    DynamoDB scalar (int / Decimal / str).
    """
    try:
        TypeSerializer().serialize(value)
    except TypeError as exc:  # pragma: no cover - the assertion is the point
        pytest.fail(
            f"{context} is not DynamoDB-serializable "
            f"({type(value).__name__}={value!r}): {exc}"
        )


# ---------------------------------------------------------------------------
# Layer 1 — root cause: conv_repness emits a float gid
# ---------------------------------------------------------------------------

class TestConvRepnessGidType:
    """`comment_repness` rows must carry a DynamoDB-serializable group id."""

    def test_gid_is_dynamodb_serializable(self):
        result = conv_repness(_vote_matrix(), _groups())
        records = result['comment_repness']

        assert records, (
            "fixture must produce representative-comment rows; got an empty "
            "comment_repness — adjust the vote matrix so the test is not vacuous"
        )

        for rec in records:
            _assert_dynamodb_serializable(
                rec['gid'], context=f"comment_repness gid (tid={rec.get('tid')})"
            )


# ---------------------------------------------------------------------------
# Layer 2 — end-to-end: to_dynamo_dict output, serialized like write_conversation
# ---------------------------------------------------------------------------

class TestToDynamoDictRepnessSerialization:
    """The repness records `write_conversation` writes must serialize cleanly."""

    def _conversation_with_real_repness(self):
        conv = Conversation(conversation_id='ztest-float-gid')
        conv.repness = conv_repness(_vote_matrix(), _groups())
        conv.comment_priorities = {}
        return conv

    def test_repness_records_serialize(self):
        conv = self._conversation_with_real_repness()
        dynamo_data = conv.to_dynamo_dict()

        comment_repness = dynamo_data['repness']['comment_repness']
        assert comment_repness, "expected non-empty comment_repness from to_dynamo_dict"

        # Reproduce the exact Item that write_conversation builds in step 5
        # (Delphi_RepresentativeComments) and serialize the whole thing.
        for item in comment_repness:
            put_item = {
                'zid_tick_gid': f"42:30000:{item.get('group_id', 0)}",
                'comment_id': str(item.get('comment_id', '')),
                'repness': item.get('repness'),
                'group_id': item.get('group_id', 0),
                'zid': '42',
            }
            _assert_dynamodb_serializable(
                put_item, context="Delphi_RepresentativeComments Item"
            )


# ---------------------------------------------------------------------------
# Layer 2b — comment priorities: value-preserving AND serializable
# ---------------------------------------------------------------------------

class TestToDynamoDictPrioritiesSerialization:
    """`to_dynamo_dict` must preserve priority VALUES, not truncate them.

    The old code did `int(priority)`: harmless today (the D12.6 bug-mirror
    makes every priority exactly 49.0) but a landmine for the day issue
    #2571 resolves and the real formula returns — real-data priorities span
    ~0.18–31.46 (decisions doc D12.6), so `int()` floors sub-1 priorities
    to 0. The TS server's weighted routing treats 0 as "no priority data":
    those comments would silently never be routed. Values must round-trip
    as Decimal (raw floats crash boto3's TypeSerializer).
    """

    # Real-data-shaped values: sub-1 (floors to 0 under int()), fractional
    # mid-range (loses 46% of its weight under int()), and the current
    # bug-mirror constant.
    _PRIORITIES = {10: 0.18, 11: 31.46, 12: 49.0}

    def _conversation_with_priorities(self):
        conv = Conversation(conversation_id='ztest-priorities')
        conv.repness = conv_repness(_vote_matrix(), _groups())
        conv.comment_priorities = dict(self._PRIORITIES)
        return conv

    def test_priorities_preserve_values(self):
        conv = self._conversation_with_priorities()
        dynamo_data = conv.to_dynamo_dict()

        priorities = dynamo_data['comment_priorities']
        assert priorities, "expected non-empty comment_priorities"

        for tid, expected in self._PRIORITIES.items():
            got = priorities[tid]
            assert float(got) == pytest.approx(expected, abs=1e-9), (
                f"priority for tid {tid} not preserved: expected {expected}, "
                f"got {got!r} (int() truncation floors sub-1 priorities to 0)"
            )

    def test_priorities_serialize_for_dynamodb(self):
        conv = self._conversation_with_priorities()
        dynamo_data = conv.to_dynamo_dict()

        for tid, value in dynamo_data['comment_priorities'].items():
            _assert_dynamodb_serializable(
                value, context=f"comment_priorities[{tid}]"
            )
            # The CommentRouting write path (dynamodb.py step 4) writes this
            # value raw into `'priority': priorities.get(comment_id, 0)` —
            # it must already be a DynamoDB scalar at this point.

