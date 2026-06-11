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

_AGREE_ENTRY = {
    'comment_id': 1,
    'n_success': 3,
    'n_trials': 5,
    'p_success': 0.6,
    'p_test': 1.5,
}

_DISAGREE_ENTRY = {
    'comment_id': 2,
    'n_success': 4,
    'n_trials': 5,
    'p_success': 0.8,
    'p_test': 2.0,
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
        conv.to_dynamo_dict.return_value = {
            'participant_count': 10,
            'comment_count': 3,
            'group_count': 0,
            'pca': {},
            'math_tick': 30000,
            'repness': {
                'comment_repness': [],
                'consensus_comments': _make_consensus_dict(),
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
        assert written['agree'] == [_AGREE_ENTRY]
        assert written['disagree'] == [_DISAGREE_ENTRY]

    def test_missing_repness_uses_dict_default(self):
        """No repness in dynamo_data → empty dict, not list, not crash."""
        client, pca_results_table = _client_with_pca_results_only()

        conv = MagicMock(name='Conversation')
        conv.conversation_id = 42
        conv.to_dynamo_dict.return_value = {
            'participant_count': 10,
            'comment_count': 3,
            'group_count': 0,
            'pca': {},
            'math_tick': 30000,
            # repness intentionally absent
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
        # comment_ids round-trip cleanly.
        assert [c['comment_id'] for c in written['agree']] == [1]
        assert [c['comment_id'] for c in written['disagree']] == [2]

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


# ---------------------------------------------------------------------------
# Round-trip — write then read on the same in-memory store
# ---------------------------------------------------------------------------

class TestRoundTrip:
    """Smoke-test: writer output, fed back through the reader, preserves shape."""

    def test_write_then_read_preserves_both_lists(self):
        client, pca_results_table = _client_with_pca_results_only()

        # Record what the writer puts.
        conv = MagicMock(name='Conversation')
        conv.conversation_id = 42
        conv.to_dynamo_dict.return_value = {
            'participant_count': 10,
            'comment_count': 3,
            'group_count': 0,
            'pca': {},
            'math_tick': 30000,
            'repness': {
                'comment_repness': [],
                'consensus_comments': _make_consensus_dict(),
            },
        }
        client.write_conversation(conv)
        written_item = pca_results_table.put_item.call_args.kwargs['Item']

        # Replay the written Item back through the reader.
        pca_results_table.get_item.return_value = {'Item': written_item}

        result = client.read_math_by_tick('42', 30000)
        consensus = result['consensus']
        assert isinstance(consensus, dict)
        assert [c['comment_id'] for c in consensus['agree']] == [1]
        assert [c['comment_id'] for c in consensus['disagree']] == [2]
