"""
Tests for D11 cascade fix in `delphi/polismath/database/dynamodb.py`.

Investigation B (2026-06-11) found three sites in the DynamoDB writer/reader
that either dropped the new D11 `consensus_comments` dict shape
(`{'agree': [...], 'disagree': [...]}`) or defaulted to the obsolete empty
list. These tests assert that, given the new shape, the writer preserves
BOTH agree and disagree lists into the `Delphi_PCAResults` table, and that
the reader defaults to the new dict shape when no item is present.

The boto3 `Table` resource is replaced with a `unittest.mock.MagicMock`,
so no DynamoDB process is required.
"""

from unittest.mock import MagicMock

import pytest

from polismath.database.dynamodb import DynamoDBClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Entries use the Clojure blob shape (tid + hyphenated stats keys) — the
# shape `select_consensus_comments_df` emits since 2026-07-04 (narrowed S1
# deferral; server-helpers.ts and majorityStrict.jsx pluck `tid`).
_AGREE_ENTRY = {
    'tid': 1,
    'n-success': 3,
    'n-trials': 5,
    'p-success': 0.6,
    'p-test': 1.5,
}

_DISAGREE_ENTRY = {
    'tid': 2,
    'n-success': 4,
    'n-trials': 5,
    'p-success': 0.8,
    'p-test': 2.0,
}


def _make_consensus_dict():
    """Return a fresh D11-shape consensus dict (copy per test)."""
    return {
        'agree': [dict(_AGREE_ENTRY)],
        'disagree': [dict(_DISAGREE_ENTRY)],
    }


class _StubConversation:
    """Minimal Conversation-like stub for the writer's legacy branch.

    The writer only touches a handful of attributes for the PCAResults
    write path, so we keep this stub deliberately tiny. The DynamoDB
    `Delphi_PCAResults` write is independent of group_clusters /
    comment_priorities / etc. — those affect other tables we are not
    exercising here.
    """

    def __init__(self, repness):
        self.conversation_id = 42
        self.participant_count = 10
        self.comment_count = 3
        self.group_clusters = []
        self.pca = {}
        self.repness = repness
        # `consensus` attribute is intentionally NOT set — Site 2 must
        # source from `self.repness['consensus_comments']`, not from
        # the deprecated `self.consensus` attribute.


def _client_with_pca_results_only():
    """Build a DynamoDBClient with ONLY the PCAResults table mocked.

    All other tables are None so the writer short-circuits early at each
    later step. This keeps the test focused on the consensus write site.
    """
    client = DynamoDBClient()
    pca_results_table = MagicMock(name='Delphi_PCAResults')
    client.tables = {
        'Delphi_PCAConversationConfig': None,
        'Delphi_PCAResults': pca_results_table,
        'Delphi_KMeansClusters': None,
        'Delphi_CommentRouting': None,
        'Delphi_RepresentativeComments': None,
        'Delphi_ParticipantProjections': None,
    }
    return client, pca_results_table


# ---------------------------------------------------------------------------
# Site 1 — `dynamo_data` branch (preferred path)
# ---------------------------------------------------------------------------

class TestSite1DynamoDataBranch:
    """When `conv.to_dynamo_dict()` returns the new shape, both lists land."""

    def test_writes_both_agree_and_disagree(self):
        client, pca_results_table = _client_with_pca_results_only()

        # Stub the conversation so the writer takes the `dynamo_data` branch.
        conv = MagicMock(name='Conversation')
        conv.conversation_id = 42
        # REAL `to_dynamo_dict()` shape (verified 2026-07-04): consensus is
        # TOP-LEVEL `result['consensus']`; `repness` carries only
        # `comment_repness`. The previous stub nested `consensus_comments`
        # inside `repness` — matching the writer's (buggy) read path instead
        # of the producer, so the test passed while production silently
        # wrote the empty default.
        conv.to_dynamo_dict.return_value = {
            'participant_count': 10,
            'comment_count': 3,
            'group_count': 0,
            'pca': {},
            'math_tick': 30000,
            'consensus': _make_consensus_dict(),
            'repness': {
                'comment_repness': [],
            },
        }

        ok = client.write_conversation(conv)
        assert ok is True

        assert pca_results_table.put_item.called, \
            "Writer did not call put_item on Delphi_PCAResults"
        item = pca_results_table.put_item.call_args.kwargs['Item']

        written = item['consensus_comments']
        assert isinstance(written, dict), \
            f"Expected dict shape, got {type(written).__name__}: {written!r}"
        assert 'agree' in written, f"Missing 'agree' key: {written!r}"
        assert 'disagree' in written, f"Missing 'disagree' key: {written!r}"
        # The writer Decimal-converts at the boto3 boundary (belt-and-braces
        # with to_dynamo_dict's own conversion — the raw-float write crashed
        # CI's e2e run 2026-07-05). Compare keys and numeric values, not types.
        for side, expected_entries in (('agree', [_AGREE_ENTRY]),
                                       ('disagree', [_DISAGREE_ENTRY])):
            got_entries = written[side]
            assert len(got_entries) == len(expected_entries)
            for got, expected in zip(got_entries, expected_entries):
                assert set(got.keys()) == set(expected.keys())
                for k, v in expected.items():
                    assert float(got[k]) == pytest.approx(float(v)), \
                        f"{side} entry key {k}: {got[k]!r} != {v!r}"

    def test_missing_consensus_uses_dict_default(self):
        """No top-level consensus in dynamo_data → empty dict, not list,
        not crash."""
        client, pca_results_table = _client_with_pca_results_only()

        conv = MagicMock(name='Conversation')
        conv.conversation_id = 42
        conv.to_dynamo_dict.return_value = {
            'participant_count': 10,
            'comment_count': 3,
            'group_count': 0,
            'pca': {},
            'math_tick': 30000,
            # 'consensus' intentionally absent
        }

        ok = client.write_conversation(conv)
        assert ok is True

        item = pca_results_table.put_item.call_args.kwargs['Item']
        assert item['consensus_comments'] == {'agree': [], 'disagree': []}


# ---------------------------------------------------------------------------
# Site 2 — legacy branch (no `to_dynamo_dict`)
# ---------------------------------------------------------------------------

class TestSite2LegacyBranch:
    """When `to_dynamo_dict` is absent, the writer sources from conv.repness."""

    def test_writes_both_agree_and_disagree_from_repness(self):
        client, pca_results_table = _client_with_pca_results_only()

        # Plain object without `to_dynamo_dict` → legacy branch.
        conv = _StubConversation(
            repness={'consensus_comments': _make_consensus_dict()}
        )

        ok = client.write_conversation(conv)
        assert ok is True

        item = pca_results_table.put_item.call_args.kwargs['Item']
        written = item['consensus_comments']
        assert isinstance(written, dict), \
            f"Legacy branch produced non-dict: {type(written).__name__}: {written!r}"
        assert set(written.keys()) >= {'agree', 'disagree'}
        # _replace_floats_with_decimals converts floats to Decimal but
        # preserves the list structure and integer fields. Confirm the
        # tids round-trip cleanly.
        assert [c['tid'] for c in written['agree']] == [1]
        assert [c['tid'] for c in written['disagree']] == [2]

    def test_missing_repness_uses_dict_default(self):
        client, pca_results_table = _client_with_pca_results_only()

        # `repness` is None — writer must default to the dict shape.
        conv = _StubConversation(repness=None)

        ok = client.write_conversation(conv)
        assert ok is True

        item = pca_results_table.put_item.call_args.kwargs['Item']
        assert item['consensus_comments'] == {'agree': [], 'disagree': []}


# ---------------------------------------------------------------------------
# Site 3 — reader default
# ---------------------------------------------------------------------------

class TestSite3ReaderDefault:
    """`read_math_by_tick` must default consensus to the new dict shape."""

    def test_missing_consensus_comments_returns_dict(self):
        client = DynamoDBClient()
        analysis_table = MagicMock(name='Delphi_PCAResults')
        # Returned Item lacks `consensus_comments` entirely.
        analysis_table.get_item.return_value = {
            'Item': {
                'participant_count': 10,
                'comment_count': 3,
                'pca': {'center': [], 'components': []},
            }
        }
        client.tables = {
            'Delphi_PCAResults': analysis_table,
            'Delphi_KMeansClusters': None,
            'Delphi_CommentRouting': None,
            'Delphi_RepresentativeComments': None,
            'Delphi_ParticipantProjections': None,
        }

        result = client.read_math_by_tick('42', 30000)
        assert result['consensus'] == {'agree': [], 'disagree': []}

    def test_present_consensus_comments_round_trip(self):
        """When the stored Item already has the dict shape, it's returned verbatim."""
        client = DynamoDBClient()
        analysis_table = MagicMock(name='Delphi_PCAResults')
        stored = _make_consensus_dict()
        analysis_table.get_item.return_value = {
            'Item': {
                'participant_count': 10,
                'comment_count': 3,
                'pca': {'center': [], 'components': []},
                'consensus_comments': stored,
            }
        }
        client.tables = {
            'Delphi_PCAResults': analysis_table,
            'Delphi_KMeansClusters': None,
            'Delphi_CommentRouting': None,
            'Delphi_RepresentativeComments': None,
            'Delphi_ParticipantProjections': None,
        }

        result = client.read_math_by_tick('42', 30000)
        assert result['consensus'] == stored

    def test_legacy_list_consensus_normalized_to_dict(self):
        """Pre-D11 blobs stored consensus as a (hardcoded-empty) LIST.
        The reader must normalize it to the dict shape so downstream
        consumers never see a list (Copilot review 2026-07-04, g3)."""
        client = DynamoDBClient()
        analysis_table = MagicMock(name='Delphi_PCAResults')
        analysis_table.get_item.return_value = {
            'Item': {
                'participant_count': 10,
                'comment_count': 3,
                'pca': {'center': [], 'components': []},
                'consensus_comments': [],  # legacy list shape
            }
        }
        client.tables = {
            'Delphi_PCAResults': analysis_table,
            'Delphi_KMeansClusters': None,
            'Delphi_CommentRouting': None,
            'Delphi_RepresentativeComments': None,
            'Delphi_ParticipantProjections': None,
        }

        result = client.read_math_by_tick('42', 30000)
        assert result['consensus'] == {'agree': [], 'disagree': []}, \
            f"legacy list must normalize to dict, got {result['consensus']!r}"

    def test_present_but_none_consensus_normalized_to_dict(self):
        """`consensus_comments` present-but-`None` (or any non-dict) must
        normalize to the dict shape. A present key with value None makes
        `.get(..., default)` return None (not the default), so the reader
        must guard on "not a dict", not just "is a list" (Copilot review
        on #2591). Otherwise `result['consensus']` is None and breaks the
        post-D11 contract that both keys are always present."""
        client = DynamoDBClient()
        analysis_table = MagicMock(name='Delphi_PCAResults')
        analysis_table.get_item.return_value = {
            'Item': {
                'participant_count': 10,
                'comment_count': 3,
                'pca': {'center': [], 'components': []},
                'consensus_comments': None,  # present-but-None
            }
        }
        client.tables = {
            'Delphi_PCAResults': analysis_table,
            'Delphi_KMeansClusters': None,
            'Delphi_CommentRouting': None,
            'Delphi_RepresentativeComments': None,
            'Delphi_ParticipantProjections': None,
        }

        result = client.read_math_by_tick('42', 30000)
        assert result['consensus'] == {'agree': [], 'disagree': []}, \
            f"present-but-None must normalize to dict, got {result['consensus']!r}"


# ---------------------------------------------------------------------------
# Round-trip — write then read on the same in-memory store
# ---------------------------------------------------------------------------

class TestRoundTrip:
    """Smoke-test: writer output, fed back through the reader, preserves shape."""

    def test_write_then_read_preserves_both_lists(self):
        client, pca_results_table = _client_with_pca_results_only()

        # Record what the writer puts (REAL to_dynamo_dict shape: top-level
        # consensus, repness with only comment_repness — verified 2026-07-04).
        conv = MagicMock(name='Conversation')
        conv.conversation_id = 42
        conv.to_dynamo_dict.return_value = {
            'participant_count': 10,
            'comment_count': 3,
            'group_count': 0,
            'pca': {},
            'math_tick': 30000,
            'consensus': _make_consensus_dict(),
            'repness': {
                'comment_repness': [],
            },
        }
        client.write_conversation(conv)
        written_item = pca_results_table.put_item.call_args.kwargs['Item']

        # Replay the written Item back through the reader.
        pca_results_table.get_item.return_value = {'Item': written_item}

        result = client.read_math_by_tick('42', 30000)
        consensus = result['consensus']
        assert isinstance(consensus, dict)
        assert [c['tid'] for c in consensus['agree']] == [1]
        assert [c['tid'] for c in consensus['disagree']] == [2]
