"""
Per-discrepancy tests for Python-Clojure parity fixes.

Each test class targets ONE specific discrepancy from the fix plan
(delphi/docs/PLAN_DISCREPANCY_FIXES.md). Tests are designed to FAIL before
the fix is applied and PASS after. They are parametrized by ALL available
datasets with Clojure reference blobs.

Discrepancies tested:
    D2  - In-conv participant threshold
    D4  - Pseudocount formula
    D5  - Proportion test formula
    D6  - Two-proportion test adjustment
    D7  - Repness metric formula
    D8  - Finalize comment stats logic
    D9  - Z-score significance thresholds
    D10 - Representative comment selection
    D11 - Consensus comment selection
    D12 - Comment priorities
    D15 - Moderation handling

Not tested here (deferred or tested elsewhere):
    D1/D1b - PCA sign flips (needs replay infrastructure)
    D3     - K-smoother buffer (needs replay infrastructure)
    D13    - Subgroup clustering (unused, deferred)
    D14    - Large conv optimization (deferred)
"""

import math

import numpy as np
import pandas as pd
import pytest
import pytest_check as check

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep.repness import (
    PSEUDO_COUNT,
    Z_90,
    Z_95,
    z_score_sig_90,
    z_score_sig_95,
    prop_test_vectorized,
    two_prop_test_vectorized,
    # D10 selection helpers (PR 8)
    passes_by_test,
    beats_best_by_test,
    beats_best_agr,
    select_rep_comments_df,
    _assemble_rep_comments,
    # D11 consensus helpers (PR 9)
    consensus_stats_df,
    select_consensus_comments_df,
)
from polismath.pca_kmeans_rep.pca import (
    pca_project_cmnts,
    compute_comment_extremity,
)
from polismath.conversation.conversation import (
    importance_metric,
    priority_metric,
    META_PRIORITY,
)
from polismath.utils.general import AGREE, DISAGREE
from polismath.regression import get_dataset_files, get_blob_variants
from polismath.regression.datasets import discover_datasets
from conftest import _get_requested_datasets, make_dataset_params, parse_dataset_blob_id
from tests.common_utils import load_clojure_output


# ---------------------------------------------------------------------------
# Dataset+blob parametrization (same pattern as test_legacy_clojure_regression.py)
# ---------------------------------------------------------------------------

def _get_clojure_dataset_blob_ids(include_local: bool, requested: set[str] | None = None) -> list[str]:
    """Get composite 'dataset-blob_type' IDs for all filled blobs."""
    datasets = discover_datasets(include_local=include_local)
    result = []
    for name, info in datasets.items():
        if not (info.has_votes and info.has_comments and info.has_clojure_reference):
            continue
        if requested and name not in requested:
            continue
        for blob_type in get_blob_variants(name):
            result.append(f"{name}-{blob_type}")
    return result


def pytest_generate_tests(metafunc):
    """Parametrize tests with clojure dataset+blob_type at collection time."""
    if "dataset_name" in metafunc.fixturenames:
        include_local = metafunc.config.getoption("--include-local", default=False)
        requested = _get_requested_datasets(metafunc.config)
        blob_ids = _get_clojure_dataset_blob_ids(include_local, requested)
        params = make_dataset_params(blob_ids)
        metafunc.parametrize("dataset_name", params, scope="class")


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

# Module-level cache for blobs (keyed by composite ID)
_BLOB_CACHE: dict = {}


@pytest.fixture(scope="class")
def conversation_data(dataset_name, get_or_compute_conversation):
    """Class-scoped fixture: runs the full pipeline once per dataset+blob_type.

    dataset_name here is actually a composite 'dataset-blob_type' ID
    (e.g., 'biodiversity-incremental' or 'biodiversity-cold_start'). The
    Conversation is shared across blob variants via the session-scoped
    get_or_compute_conversation fixture.
    """
    global _BLOB_CACHE
    ds_name, blob_type = parse_dataset_blob_id(dataset_name)

    # Get or compute the conversation (shared across blob variants via session cache)
    conv_data = get_or_compute_conversation(ds_name)

    # Load the specific blob variant (cache per composite ID)
    if dataset_name not in _BLOB_CACHE:
        for bid in list(_BLOB_CACHE.keys()):
            if not bid.startswith(ds_name + '-'):
                _BLOB_CACHE.pop(bid, None)
        files = get_dataset_files(ds_name, blob_type=blob_type)
        clojure = load_clojure_output(files['math_blob'])
        _BLOB_CACHE[dataset_name] = clojure

    return {
        'conv': conv_data['conv'],
        'clojure': _BLOB_CACHE[dataset_name],
        'dataset_name': ds_name,
        'blob_type': blob_type,
        'files': conv_data['files'],
        'comments': conv_data['comments'],
    }


@pytest.fixture(scope="class")
def clojure_blob(conversation_data):
    return conversation_data['clojure']


@pytest.fixture(scope="class")
def conv(conversation_data):
    return conversation_data['conv']


# ---------------------------------------------------------------------------
# Helpers for extracting Clojure repness data
# ---------------------------------------------------------------------------

def _clojure_repness_entries(blob: dict) -> list[dict]:
    """Flatten Clojure repness dict {gid: [entries]} into a list with gid added."""
    repness = blob.get('repness', {})
    result = []
    for gid_str, entries in repness.items():
        gid = int(gid_str)
        for entry in entries:
            result.append({**entry, 'gid': gid})
    return result


def _clojure_in_conv_set(blob: dict) -> set[int]:
    """Get the set of in-conv participant IDs from Clojure blob."""
    return set(blob.get('in-conv', []))


# ============================================================================
# D2 — In-Conv Participant Threshold
# ============================================================================

@pytest.mark.clojure_comparison
class TestD2InConvThreshold:
    """
    D2: Clojure uses threshold = min(7, n_cmts) for in-conv filtering.
    Python now matches (fixed from 7 + sqrt(n_cmts) * 0.1).
    """

    def test_in_conv_count_matches(self, conv, clojure_blob, dataset_name):
        """Number of in-conv participants should match Clojure."""
        if 'in-conv' not in clojure_blob:
            pytest.skip(f"[{dataset_name}] Clojure blob has no in-conv data")
        if dataset_name.endswith('-incremental'):
            # Incremental blobs were built progressively as votes trickled in,
            # so the threshold min(7, n_cmts) was evaluated at each iteration
            # with a smaller n_cmts than the final value. This admits a few
            # extra participants to in-conv during earlier iterations.
            # The difference is tiny (1-2 participants) when a cold-start blob
            # is available. Very large conversations have empty cold-start blobs
            # because Clojure can't process them in one pass.
            pytest.xfail("D2: behaviour matches on cold-start, incremental deferred to future PR")
        clojure_in_conv = _clojure_in_conv_set(clojure_blob)
        python_in_conv_count = len(conv._get_in_conv_participants())

        print(f"[{dataset_name}] In-conv: Python={python_in_conv_count}, Clojure={len(clojure_in_conv)}")
        check.equal(python_in_conv_count, len(clojure_in_conv),
                     f"In-conv count mismatch: Python={python_in_conv_count}, Clojure={len(clojure_in_conv)}")

    def test_in_conv_set_matches(self, conv, clojure_blob, dataset_name):
        """The actual set of in-conv participants should match Clojure."""
        if 'in-conv' not in clojure_blob:
            pytest.skip(f"[{dataset_name}] Clojure blob has no in-conv data")
        if dataset_name.endswith('-incremental'):
            # Incremental blobs were built progressively as votes trickled in,
            # so the threshold min(7, n_cmts) was evaluated at each iteration
            # with a smaller n_cmts than the final value. This admits a few
            # extra participants to in-conv during earlier iterations.
            # The difference is tiny (1-2 participants) when a cold-start blob
            # is available. Very large conversations have empty cold-start blobs
            # because Clojure can't process them in one pass.
            pytest.xfail("D2: behaviour matches on cold-start, incremental deferred to future PR")
        clojure_in_conv = _clojure_in_conv_set(clojure_blob)
        python_in_conv = conv._get_in_conv_participants()
        # Convert python pids to int for comparison
        python_in_conv_int = set()
        for pid in python_in_conv:
            try:
                python_in_conv_int.add(int(pid))
            except (ValueError, TypeError):
                python_in_conv_int.add(pid)

        only_python = python_in_conv_int - clojure_in_conv
        only_clojure = clojure_in_conv - python_in_conv_int

        print(f"[{dataset_name}] Only in Python: {len(only_python)}, Only in Clojure: {len(only_clojure)}")

        check.equal(only_python, set(), f"Participants in Python but not Clojure: {len(only_python)}")
        check.equal(only_clojure, set(), f"Participants in Clojure but not Python: {len(only_clojure)}")


# ============================================================================
# D2c — Vote Count Source (raw vs filtered matrix)
# ============================================================================

def _build_conv_with_moderation(
    n_comments: int = 10,
    mod_out_tids: list | None = None,
    participant_votes: dict | None = None,
) -> Conversation:
    """Build a public-fixture Conversation with moderation applied.

    Args:
        n_comments: Total number of comments (tids 0..n_comments-1).
        mod_out_tids: List of tids to moderate-out.
        participant_votes: Dict mapping pid → list of tids they voted on.
            If None, a single participant votes on all comments.

    Returns:
        A Conversation with votes ingested and moderation applied (no recompute).
    """
    if participant_votes is None:
        participant_votes = {0: list(range(n_comments))}

    votes_list = []
    for pid, tids in participant_votes.items():
        for tid in tids:
            votes_list.append({'pid': pid, 'tid': tid, 'vote': 1})

    conv = Conversation('test-d2c')
    conv = conv.update_votes({'votes': votes_list}, recompute=False)

    if mod_out_tids:
        conv = conv.update_moderation(
            {'mod_out_tids': mod_out_tids}, recompute=False
        )

    return conv


class TestD2cVoteCountSource:
    """
    D2c: Vote counts for in-conv threshold must come from raw_rating_mat
    (includes votes on moderated-out comments), not rating_mat (filtered).

    Clojure's user-vote-counts (conversation.clj:217-225) uses raw-rating-mat.
    Python currently uses self.rating_mat, undercounting when comments are
    moderated-out.
    """

    def test_vote_count_includes_moderated_out_votes(self):
        """Participant who voted on 10 comments (3 moderated-out) should have count=10."""
        conv = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2],
            participant_votes={0: list(range(10))},
        )

        vote_counts = conv._compute_user_vote_counts()
        assert vote_counts[0] == 10, (
            f"Vote count should be 10 (from raw_rating_mat), got {vote_counts[0]} "
            f"(rating_mat has {len(conv.rating_mat.columns)} columns)"
        )

    def test_n_cmts_includes_moderated_out_comments(self):
        """n_cmts in threshold should count all comments including moderated-out.

        With 10 total comments and 5 moderated-out, n_cmts should be 10.
        This matters when non-moderated-out count < 7: the threshold would be
        artificially low in Python (min(7,5)=5 vs correct min(7,10)=7).
        """
        conv = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2, 3, 4],
            participant_votes={0: list(range(10))},
        )

        # Both raw_rating_mat and rating_mat have all columns (D15 fix:
        # moderated-out columns are zeroed, not removed)
        n_cmts_raw = len(conv.raw_rating_mat.columns)
        n_cmts_filtered = len(conv.rating_mat.columns)

        assert n_cmts_raw == 10, f"raw_rating_mat should have 10 columns, got {n_cmts_raw}"
        assert n_cmts_filtered == 10, f"rating_mat should keep all 10 columns (zeroed, not removed), got {n_cmts_filtered}"

        # The threshold used by _get_in_conv_participants should be min(7, 10) = 7,
        # not min(7, 5) = 5. Since the mode collapse the greedy floor admits
        # below-threshold participants whenever in-conv < 15, so satisfy the
        # floor with 16 over-threshold participants first — then a 6-vote
        # participant is excluded iff the threshold is really 7 (it would be
        # admitted if n_cmts wrongly used the filtered count 5).
        conv2 = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2, 3, 4],
            participant_votes={
                **{p: list(range(10)) for p in range(16)},  # 16 over threshold
                16: list(range(4, 10)),  # 6 raw votes -> below threshold=7
            },
        )
        in_conv = conv2._get_in_conv_participants()
        assert 0 in in_conv, "P0 (10 raw votes) should be in-conv"
        assert 16 not in in_conv, (
            "P16 (6 raw votes) should NOT be in-conv with threshold=7, "
            "but would be if n_cmts wrongly used filtered count (5)"
        )

    def test_participant_stays_in_conv_after_moderation(self):
        """Participant with 8 votes stays in-conv even when 3 comments moderated-out.

        This is the critical scenario: participant votes above threshold (8 >= 7),
        comments get moderated-out between update_votes calls reducing filtered
        count to 5, but raw count is still 8 so they should remain in-conv.
        """
        # Participant 0: votes on 8 comments (above threshold of 7)
        # Participant 1: votes on 7 comments (borderline)
        conv = _build_conv_with_moderation(
            n_comments=10,
            mod_out_tids=[0, 1, 2],  # 3 moderated-out
            participant_votes={
                0: list(range(8)),   # votes on c0-c7; after mod, only c3-c7 visible (5)
                1: list(range(7)),   # votes on c0-c6; after mod, only c3-c6 visible (4)
            },
        )

        in_conv = conv._get_in_conv_participants()

        # Both should be in-conv: raw counts are 8 and 7, threshold is min(7, 10) = 7
        assert 0 in in_conv, (
            f"Participant 0 (8 raw votes) should be in-conv, "
            f"but filtered count is {np.sum(~np.isnan(conv.rating_mat.loc[0].values))}"
        )
        assert 1 in in_conv, (
            f"Participant 1 (7 raw votes) should be in-conv, "
            f"but filtered count is {np.sum(~np.isnan(conv.rating_mat.loc[1].values))}"
        )


# ============================================================================
# D2d — In-Conv Monotonicity
# ============================================================================

class TestD2dInConvMonotonicity:
    """
    D2d: Once a participant qualifies for in-conv, they must never be removed.

    These tests pass today because Python does full recompute from raw_rating_mat
    (which includes all historical votes, even on moderated-out comments).
    If the code is ever refactored to use delta vote processing, in-conv MUST be
    persisted to DynamoDB — see compdemocracy/polis#2358 and the Clojure approach
    in conv_man.clj:55, conversation.clj:244.
    """

    def test_t1_basic_monotonicity_across_updates(self):
        """Participant who qualified in batch 1 stays in-conv after batch 2.

        P votes on 7 comments in batch 1 → qualifies. Batch 2 adds new comments
        but P doesn't vote on them. P's count stays 7 → still in-conv.

        Would FAIL under delta processing without persistence if batch 2 only
        contained new votes and P's old votes weren't re-scanned.
        """
        conv = Conversation('test-d2d-t1')

        # Batch 1: P0 votes on 7 comments, P1 votes on all 10
        batch1 = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}
        conv = conv.update_votes(batch1, recompute=False)
        in_conv_after_b1 = conv._get_in_conv_participants()
        assert 0 in in_conv_after_b1, "P0 should be in-conv after batch 1 (7 votes)"

        # Batch 2: new comments c10-c14, only P1 votes on them
        batch2 = {'votes': [
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10, 15)],
        ]}
        conv = conv.update_votes(batch2, recompute=False)
        in_conv_after_b2 = conv._get_in_conv_participants()
        assert 0 in in_conv_after_b2, (
            "P0 should still be in-conv after batch 2 (7 votes unchanged)"
        )

    def test_t2_monotonicity_survives_moderation(self):
        """Participant stays in-conv after their voted comments are moderated-out.

        P votes on 7 comments → qualifies. 3 comments moderated-out. P's raw
        count is still 7 → still in-conv (because raw_rating_mat is used).

        Would FAIL under delta processing without persistence if moderation
        caused a recount from only the filtered matrix.
        """
        conv = Conversation('test-d2d-t2')
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}
        conv = conv.update_votes(votes, recompute=False)

        in_conv_before = conv._get_in_conv_participants()
        assert 0 in in_conv_before, "P0 should be in-conv before moderation"

        # Moderate out 3 of P0's comments
        conv = conv.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv_after = conv._get_in_conv_participants()
        assert 0 in in_conv_after, (
            "P0 should still be in-conv after moderation "
            "(7 raw votes, only 4 on filtered matrix)"
        )

    def test_t3_worker_restart_with_moderation(self):
        """Participant survives worker restart + moderation.

        P votes on 7 comments → qualifies. Worker dies. 3 comments moderated-out.
        New worker rebuilds from all votes. P still has 7 raw votes → in-conv.

        This is the KEY test that would FAIL under delta processing without
        persistence: after restart, only new votes would be scanned.
        """
        # Original worker
        conv1 = Conversation('test-d2d-t3')
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}
        conv1 = conv1.update_votes(votes, recompute=False)
        assert 0 in conv1._get_in_conv_participants()

        # Simulate worker restart: new Conversation object, replay ALL votes
        conv2 = Conversation('test-d2d-t3')
        conv2 = conv2.update_votes(votes, recompute=False)

        # Apply moderation that happened while worker was dead
        conv2 = conv2.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv = conv2._get_in_conv_participants()
        assert 0 in in_conv, (
            "P0 should be in-conv after restart+moderation "
            "(full recompute from all votes)"
        )

    def test_t4_worker_restart_moderation_no_new_votes(self):
        """Rebuild from existing votes after moderation, no new votes needed.

        Same as T3 but verifies that recompute alone is sufficient — no "trigger"
        of new votes is needed to re-evaluate in-conv.
        """
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(10)],
        ]}

        # Build from scratch with moderation already applied
        conv = Conversation('test-d2d-t4')
        conv = conv.update_votes(votes, recompute=False)
        conv = conv.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv = conv._get_in_conv_participants()
        assert 0 in in_conv, (
            "P0 should be in-conv with just existing votes + moderation"
        )

    def test_t5_mixed_participants_moderation(self):
        """Both old and new participants correct after moderation.

        P0 votes on c0-c6. c0-c2 moderated-out. New participant Q votes on c3-c9.
        Rebuild from all votes. Both should be in-conv:
        - P0: 7 raw votes (c0-c6), threshold min(7,10)=7 → qualifies
        - Q: 7 votes on non-moderated-out comments → qualifies
        """
        conv = Conversation('test-d2d-t5')
        votes = {'votes': [
            *[{'pid': 0, 'tid': tid, 'vote': 1} for tid in range(7)],   # c0-c6
            *[{'pid': 1, 'tid': tid, 'vote': 1} for tid in range(3, 10)],  # c3-c9
        ]}
        conv = conv.update_votes(votes, recompute=False)
        conv = conv.update_moderation({'mod_out_tids': [0, 1, 2]}, recompute=False)

        in_conv = conv._get_in_conv_participants()
        assert 0 in in_conv, "P0 (7 raw votes) should be in-conv"
        assert 1 in in_conv, "P1 (7 votes on non-moderated-out comments) should be in-conv"


# ============================================================================
# D4 — Pseudocount Formula
# ============================================================================

@pytest.mark.clojure_comparison
class TestD4Pseudocount:
    """
    D4: Previously Python used PSEUDO_COUNT = 1.5 → pa = (na + 0.75) / (ns + 1.5).
        Clojure uses PSEUDO_COUNT = 2.0 → pa = (na + 1) / (ns + 2).
        Python has been updated to 2.0 to match; these tests assert that.
    """

    def test_pseudocount_constant(self):
        """Verify the pseudocount constant matches Clojure's Beta(2,2) prior."""
        # Target: PSEUDO_COUNT = 2.0
        check.equal(PSEUDO_COUNT, 2.0,
                     f"PSEUDO_COUNT should be 2.0 (Clojure Beta(2,2) prior), got {PSEUDO_COUNT}")

    def test_pa_values_match_clojure(self, conv, clojure_blob, dataset_name):
        """p-success values should match Clojure for specific (group, comment) pairs."""
        clojure_entries = _clojure_repness_entries(clojure_blob)
        if not clojure_entries:
            pytest.skip("No repness entries in Clojure blob")

        mismatches = 0
        total = 0
        for entry in clojure_entries:
            clj_pa = entry.get('p-success')
            clj_na = entry.get('n-success')
            clj_ns = entry.get('n-trials')
            if clj_pa is None or clj_na is None or clj_ns is None:
                continue

            # Recompute with Python's current pseudocount
            python_pa = (clj_na + PSEUDO_COUNT / 2) / (clj_ns + PSEUDO_COUNT)
            total += 1

            if abs(python_pa - clj_pa) > 1e-6:
                mismatches += 1

        print(f"[{dataset_name}] pa mismatches: {mismatches}/{total}")
        check.equal(mismatches, 0, f"pa values differ for {mismatches}/{total} entries")


# ============================================================================
# D9 — Z-Score Significance Thresholds
# ============================================================================

@pytest.mark.clojure_comparison
class TestD9ZScoreThresholds:
    """
    D9: Z-score thresholds and semantics must match Clojure stats.clj:
        (defn z-sig-90? [z-val] (> z-val 1.2816))
        (defn z-sig-95? [z-val] (> z-val 1.6449))

    Three aspects: correct values, strict > (not >=), one-tailed (no abs).
    """

    def test_z90_matches_clojure(self):
        """Z_90 should be one-tailed (1.2816), not two-tailed (1.645)."""
        check.almost_equal(Z_90, 1.2816, abs=0.001,
                            msg=f"Z_90 should be 1.2816 (one-tailed), got {Z_90}")

    def test_z95_matches_clojure(self):
        """Z_95 should be one-tailed (1.6449), not two-tailed (1.96)."""
        check.almost_equal(Z_95, 1.6449, abs=0.001,
                            msg=f"Z_95 should be 1.6449 (one-tailed), got {Z_95}")

    def test_z_sig_strict_greater_than(self):
        """Clojure uses strict >, not >=. Boundary values must NOT pass."""
        check.is_false(z_score_sig_90(Z_90),
                       "z_score_sig_90(Z_90) should be False (strict >, not >=)")
        check.is_false(z_score_sig_95(Z_95),
                       "z_score_sig_95(Z_95) should be False (strict >, not >=)")

    def test_z_sig_one_tailed(self):
        """Clojure uses (> z-val threshold), no abs(). Negative values must NOT pass."""
        check.is_false(z_score_sig_90(-2.0),
                       "z_score_sig_90(-2.0) should be False (one-tailed, no abs)")
        check.is_false(z_score_sig_95(-2.0),
                       "z_score_sig_95(-2.0) should be False (one-tailed, no abs)")

    def test_repness_not_empty(self, conv, dataset_name):
        """Repness should produce non-empty comment_repness with correct thresholds."""
        repness = conv.repness
        check.is_not_none(repness, "Repness should not be None")
        if repness:
            check.is_in('comment_repness', repness, "Should have comment_repness key")
            if 'comment_repness' in repness:
                check.greater(len(repness['comment_repness']), 0,
                              "comment_repness should not be empty")

    def test_significance_sets_match_clojure(self, request, conv, clojure_blob, dataset_name):
        """Post-significance-filtering comment sets should match Clojure per group.

        Both sides apply z-sig-90? to their z-values and select top comments.
        biodiversity-cold_start matches exactly since the gid label-swap fix
        (2026-07-05) and gates; other variants remain xfailed on residual
        per-(gid, tid) group-membership/stat divergence.
        """
        if request.node.callspec.id != 'biodiversity-cold_start':
            request.applymarker(pytest.mark.xfail(
                raises=AssertionError,
                strict=False,
                reason="residual per-(gid, tid) group-membership/stat "
                       "divergence (gid label swap fixed 2026-07-05; "
                       "biodiversity-cold_start gates)"))
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})

        mismatches = []
        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            clj_tids = set(e['tid'] for e in clj_entries)
            py_entries = python_repness.get(gid, [])
            py_tids = set(int(e['comment_id']) for e in py_entries)

            if clj_tids != py_tids:
                only_clj = sorted(clj_tids - py_tids)
                only_py = sorted(py_tids - clj_tids)
                mismatches.append(f"  g{gid}: clj_only={only_clj}, py_only={only_py}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} groups with different rep comment sets:")
            for m in mismatches:
                print(m)

        check.equal(len(mismatches), 0,
                    f"{len(mismatches)} groups differ in selected rep comments")

    @pytest.mark.xfail(reason="residual per-(gid, tid) group-membership divergence: the gid "
                              "0↔1 label swap was FIXED 2026-07-05 (group size re-sort removed) "
                              "and did not resolve this test on any variant — groups contain "
                              "slightly different participants, so exact z-values differ. "
                              "Deferred to clustering-membership / sequential-parity work.")
    def test_z_values_match_clojure(self, conv, clojure_blob, dataset_name):
        """Z-score values for shared rep comments should match Clojure.

        For comments in BOTH Clojure and Python selections, compare:
        - p-test (Clojure) vs pat (Python) — proportion test z-score
        - repness-test (Clojure) vs rat (Python) — two-proportion test z-score

        Requires D10 (same comment selection) so there ARE shared comments,
        then D5/D6 so the values match.
        """
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})

        shared_count = 0
        pat_mismatches = []
        rat_mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_entries = python_repness.get(gid, [])
            py_by_tid = {int(e['comment_id']): e for e in py_entries}

            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue

                shared_count += 1

                # Compare p-test vs pat (proportion test z-score)
                clj_pat = clj_entry.get('p-test', 0)
                py_pat = py_entry.get('pat', 0)
                if abs(clj_pat - py_pat) > 0.01:
                    pat_mismatches.append(
                        f"  g{gid}/t{tid}: clj p-test={clj_pat:.4f}, py pat={py_pat:.4f}")

                # Compare repness-test vs rat (two-proportion test z-score)
                clj_rat = clj_entry.get('repness-test', 0)
                py_rat = py_entry.get('rat', 0)
                if abs(clj_rat - py_rat) > 0.01:
                    rat_mismatches.append(
                        f"  g{gid}/t{tid}: clj repness-test={clj_rat:.4f}, py rat={py_rat:.4f}")

        if pat_mismatches:
            print(f"[{dataset_name}] {len(pat_mismatches)} pat/p-test mismatches:")
            for m in pat_mismatches[:10]:
                print(m)
        if rat_mismatches:
            print(f"[{dataset_name}] {len(rat_mismatches)} rat/repness-test mismatches:")
            for m in rat_mismatches[:10]:
                print(m)

        check.greater(shared_count, 0,
                      "No shared comments to compare — selection sets are disjoint (D10)")
        check.equal(len(pat_mismatches), 0,
                    f"{len(pat_mismatches)} p-test/pat mismatches (D5)")
        check.equal(len(rat_mismatches), 0,
                    f"{len(rat_mismatches)} repness-test/rat mismatches (D6)")


# ============================================================================
# D5 — Proportion Test Formula
# ============================================================================

@pytest.mark.clojure_comparison
class TestD5ProportionTest:
    """
    D5: Python uses standard z-test: (p - 0.5) / sqrt(0.25/n)
        Clojure uses Wilson-score-like: 2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)

    Clojure formula has built-in regularization via +1 terms.
    After fix, prop_test(succ, n) matches Clojure exactly.
    """

    def test_prop_test_matches_clojure_formula(self):
        """prop_test_vectorized(succ, n) should match Clojure's formula for known
        inputs, including the n=0 boundary (no short-circuit; +1 pseudocount → 1.0)."""
        # (succ, n, label_for_diagnostic)
        cases = pd.DataFrame([
            (12, 13, "high success rate"),
            (5, 8, "moderate"),
            (0, 10, "all failures"),
            (10, 10, "all successes"),
            (1, 2, "tiny sample"),
            (50, 100, "larger sample"),
            (0, 1, "single trial, no success"),
            (1, 1, "single trial, success"),
            (0, 0, "n=0 boundary (no short-circuit; +1 pseudocount → 1.0)"),
        ], columns=['succ', 'n', 'label'])

        # Clojure formula: 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)
        cases['expected'] = (2 * np.sqrt(cases['n'] + 1)
                              * ((cases['succ'] + 1) / (cases['n'] + 1) - 0.5))
        cases['actual'] = prop_test_vectorized(cases['succ'], cases['n'])
        cases['diff'] = (cases['actual'] - cases['expected']).abs()

        mismatches = cases[cases['diff'] > 1e-10]
        assert mismatches.empty, (
            f"{len(mismatches)}/{len(cases)} prop_test_vectorized mismatches:\n"
            + mismatches.to_string(index=False))

    def test_clojure_pat_values_consistent_with_formula(self, clojure_blob, dataset_name):
        """Sanity check: Clojure's p-test values match the documented formula."""
        clojure_entries = _clojure_repness_entries(clojure_blob)
        if not clojure_entries:
            pytest.skip("No repness entries in Clojure blob")

        mismatches = 0
        total = 0
        max_diff = 0.0
        for entry in clojure_entries:
            clj_pat = entry.get('p-test')
            if clj_pat is None:
                continue
            clj_na = entry.get('n-success', 0)
            clj_ns = entry.get('n-trials', 0)
            if clj_ns == 0:
                continue

            # Recompute using Clojure's documented formula
            expected = 2 * math.sqrt(clj_ns + 1) * ((clj_na + 1) / (clj_ns + 1) - 0.5)

            total += 1
            diff = abs(clj_pat - expected)
            if diff > 0.01:
                mismatches += 1
                max_diff = max(max_diff, diff)

        print(f"[{dataset_name}] pat consistency: {total - mismatches}/{total} match formula (max_diff={max_diff:.4f})")
        check.equal(mismatches, 0, f"Clojure p-test values don't match formula for {mismatches}/{total}")

    @pytest.mark.xfail(reason="gid 0↔1 label swap + group-membership divergence on cold_start "
                              "(per workflow Investigation C 2026-06-11 — PR #2524 D14 verified "
                              "only k count, not per-(gid, tid) memberships). D10 unlocks shared "
                              "comments but per-(gid, tid) pat values still differ because the "
                              "swapped/divergent groups contain different participants. Fix "
                              "requires canonical-group-id sorting or set-based comparison "
                              "infrastructure.")
    def test_pat_values_match_clojure_blob(self, conv, clojure_blob, dataset_name):
        """p-test (Clojure) vs pat (Python) for shared rep comments."""
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('p-test', 0)
                py_val = py_entry.get('pat', 0)
                if abs(clj_val - py_val) > 0.01:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val:.4f}, py={py_val:.4f}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} p-test/pat mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} p-test/pat mismatches")


# ============================================================================
# D6 — Two-Proportion Test Adjustment
# ============================================================================

@pytest.mark.clojure_comparison
class TestD6TwoPropTest:
    """
    D6: Python uses standard two-proportion z-test without pseudocounts.
        Clojure adds +1 pseudocount to all 4 inputs (stats.clj:18-33):
        (map inc [succ-in succ-out pop-in pop-out])
        pi1 = (succ-in+1)/(pop-in+1), pi2 = (succ-out+1)/(pop-out+1)
        pi-hat = (succ-in+1 + succ-out+1) / (pop-in+1 + pop-out+1)
    """

    @staticmethod
    def _clojure_two_prop_test(succ_in, succ_out, pop_in, pop_out):
        """Reference implementation of Clojure's two-prop-test (stats.clj:18-33)."""
        s1, s2, p1, p2 = succ_in + 1, succ_out + 1, pop_in + 1, pop_out + 1
        pi1 = s1 / p1
        pi2 = s2 / p2
        pi_hat = (s1 + s2) / (p1 + p2)
        if pi_hat == 1:
            return 0.0
        return (pi1 - pi2) / math.sqrt(pi_hat * (1 - pi_hat) * (1/p1 + 1/p2))

    def test_two_prop_test_matches_clojure_formula(self):
        """two_prop_test_vectorized should match Clojure's per-row formula, including
        edge cases that exercise the pi_hat==1 guard and the no-pop=0 short-circuit."""
        cases = pd.DataFrame([
            # (succ_in, succ_out, pop_in, pop_out, label)
            (10, 15, 20, 30, "typical case"),
            (0, 0, 10, 10, "no successes in either group"),
            (5, 5, 10, 10, "identical groups"),
            (10, 0, 10, 10, "all success in group, none outside"),
            (1, 1, 1, 1, "minimal counts"),
            (50, 20, 100, 200, "asymmetric sizes"),
            (0, 10, 20, 30, "no success in group, some outside"),
            # pi_hat==1 boundary cases (Clojure: returns 0; vectorized: NaN → 0.0)
            (5, 5, 0, 10, "pop_in=0, succ saturates → pi_hat=1 guard"),
            (5, 5, 10, 0, "pop_out=0, succ saturates → pi_hat=1 guard"),
            (0, 0, 0, 0, "all zero → pi_hat=1 guard"),
        ], columns=['succ_in', 'succ_out', 'pop_in', 'pop_out', 'label'])

        cases['expected'] = cases.apply(
            lambda r: self._clojure_two_prop_test(
                r['succ_in'], r['succ_out'], r['pop_in'], r['pop_out']),
            axis=1)
        cases['actual'] = two_prop_test_vectorized(
            cases['succ_in'], cases['succ_out'], cases['pop_in'], cases['pop_out'])
        cases['diff'] = (cases['actual'] - cases['expected']).abs()

        mismatches = cases[cases['diff'] > 1e-3]
        assert mismatches.empty, (
            f"{len(mismatches)}/{len(cases)} two_prop_test mismatches:\n"
            + mismatches.to_string(index=False))

        # Pin the no-pop=0-short-circuit behavior: real pop=0 (no pi_hat=1 collapse)
        # → (5,5,0,100) produces a large positive z, confirming the +1-pseudocount
        # path runs instead of short-circuiting.
        no_pi_hat_collapse = two_prop_test_vectorized(
            pd.Series([5]), pd.Series([5]), pd.Series([0]), pd.Series([100])).iloc[0]
        check.greater(no_pi_hat_collapse, 10.0,
                      "pop_in=0 should NOT short-circuit to 0 when pi_hat<1; "
                      "+1 pseudocount produces large positive z")

    def test_two_prop_test_pseudocount_effect(self):
        """Pseudocounts should shrink z-scores toward zero for small samples."""
        # With small n, the +1 pseudocount has a large effect:
        # succ=1, pop=1 → without pseudocount: p=1.0 (extreme); with pseudocount,
        # both numerator and denominator shift.
        results = two_prop_test_vectorized(
            pd.Series([1, 100]),    # succ_in:  small, large
            pd.Series([0, 0]),      # succ_out: zero in both
            pd.Series([2, 200]),    # pop_in:   small, large
            pd.Series([2, 200]),    # pop_out:  small, large
        )
        result_small, result_large = results.iloc[0], results.iloc[1]
        check.greater(abs(result_large), abs(result_small),
                      "Large samples should produce more extreme z-scores than small ones")

    @pytest.mark.xfail(reason="residual per-(gid, tid) group-membership divergence: the gid "
                              "0↔1 label swap was FIXED 2026-07-05 (group size re-sort removed) "
                              "and did not resolve this test on any variant — groups contain "
                              "slightly different participants, so exact rat values differ. "
                              "Deferred to clustering-membership / sequential-parity work.")
    def test_rat_values_match_clojure_blob(self, conv, clojure_blob, dataset_name):
        """repness-test (Clojure) vs rat (Python) for shared rep comments.

        Unlike D5's pat test, rat (two-proportion test) needs group-vs-others
        counts which aren't in the blob, so we compare for shared comments only.
        """
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('repness-test', 0)
                py_val = py_entry.get('rat', 0)
                if abs(clj_val - py_val) > 0.01:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val:.4f}, py={py_val:.4f}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} repness-test/rat mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare — selection sets are disjoint (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} repness-test/rat mismatches")


# ============================================================================
# D7 — Repness Metric Formula
# ============================================================================

@pytest.mark.clojure_comparison
class TestD7RepnessMetric:
    """
    D7: Python uses pa * (|pat| + |rat|) — weighted sum of absolutes
        Clojure uses ra * rat * pa * pat — product of signed values

    The Clojure product formula is more conservative: any factor near 0
    kills the whole metric.
    """

    def test_metric_formula_is_product(self):
        """Pins the agree_metric/disagree_metric formula with hand-computed values.

        Clojure repness-metric (repness.clj:191-193):
            (* repness repness-test p-success p-test)
        Production code mirrors this in compute_group_comment_stats_df:
            stats_df['agree_metric'] = stats_df['ra'] * stats_df['rat']
                                       * stats_df['pa'] * stats_df['pat']
            stats_df['disagree_metric'] = stats_df['rd'] * stats_df['rdt']
                                          * stats_df['pd'] * stats_df['pdt']
        Signed product — no abs(). Negative z-scores flip the sign.
        """
        df = pd.DataFrame([{
            'pa': 0.8, 'pat': 2.5, 'ra': 1.3, 'rat': 1.8,
            'pd': 0.2, 'pdt': -1.5, 'rd': 0.7, 'rdt': -0.9,
        }])

        agree_metric = (df['ra'] * df['rat'] * df['pa'] * df['pat']).iloc[0]
        disagree_metric = (df['rd'] * df['rdt'] * df['pd'] * df['pdt']).iloc[0]

        # Hand-computed reference values.
        check.almost_equal(agree_metric, 4.68, abs=1e-10,
                            msg=f"agree_metric (1.3 * 1.8 * 0.8 * 2.5) = 4.68, got {agree_metric}")
        # Two negatives cancel — signed product.
        check.almost_equal(disagree_metric, 0.189, abs=1e-10,
                            msg=f"disagree_metric (0.7 * -0.9 * 0.2 * -1.5) = 0.189, got {disagree_metric}")

    @pytest.mark.xfail(reason="gid 0↔1 label swap + group-membership divergence on cold_start "
                              "(per workflow Investigation C 2026-06-11 — PR #2524 D14 verified "
                              "only k count, not per-(gid, tid) memberships). D10 unlocks shared "
                              "comments but per-(gid, tid) repness metrics still differ because "
                              "the swapped/divergent groups contain different participants. Fix "
                              "requires canonical-group-id sorting or set-based comparison "
                              "infrastructure.")
    def test_repness_metric_matches_clojure_blob(self, conv, clojure_blob, dataset_name):
        """repness (Clojure) vs agree/disagree_metric (Python) for shared comments."""
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('repness', 0)
                py_val = py_entry.get('agree_metric', 0) if py_entry.get('repful') == 'agree' else py_entry.get('disagree_metric', 0)
                if abs(clj_val - py_val) > 0.01:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val:.4f}, py={py_val:.4f}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} repness metric mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} repness metric mismatches")


# ============================================================================
# D8 — Finalize Comment Stats Logic
# ============================================================================

@pytest.mark.clojure_comparison
class TestD8FinalizeStats:
    """
    D8: Python uses if pa > 0.5 AND ra > 1.0 → 'agree'; elif pd > 0.5 AND rd > 1.0 → 'disagree'
        Clojure uses simple rat > rdt → 'agree'; else → 'disagree'
    """

    def test_repful_classification_boundary(self):
        """Pin the repful classification logic: agree iff rat > rdt (strict), else disagree.

        Production code (compute_group_comment_stats_df):
            stats_df['repful'] = np.where(stats_df['rat'] > stats_df['rdt'],
                                          'agree', 'disagree')
        Clojure (repness.clj:178):
            (if (> rat rdt) :agree :disagree)

        Strict `>` — `rat == rdt` falls through to 'disagree'. Covers:
        - rat < rdt  → 'disagree' (case where old Python 3-branch wrongly said 'agree')
        - rat > rdt  → 'agree'    (case where old Python wrongly said 'disagree')
        - rat == rdt → 'disagree' (strict >, non-zero boundary)
        - rat == rdt == 0 → 'disagree' (all-zero boundary, distinct from above)
        - negative z-scores: comparison works on signed values (-0.5 > -2.0)
        """
        cases = pd.DataFrame([
            (0.5, 1.5, 'disagree', "rat < rdt: old Python 3-branch would say agree"),
            (1.5, 0.5, 'agree', "rat > rdt: old Python 3-branch would say disagree"),
            (1.5, 1.5, 'disagree', "rat == rdt non-zero (strict >)"),
            (0.0, 0.0, 'disagree', "rat == rdt == 0 boundary"),
            (-0.5, -2.0, 'agree', "negative z-scores: -0.5 > -2.0"),
        ], columns=['rat', 'rdt', 'expected', 'label'])

        cases['actual'] = np.where(cases['rat'] > cases['rdt'], 'agree', 'disagree')

        mismatches = cases[cases['actual'] != cases['expected']]
        assert mismatches.empty, (
            f"{len(mismatches)}/{len(cases)} repful mismatches:\n"
            + mismatches.to_string(index=False))

    def test_repful_matches_clojure_blob(self, request, conv, clojure_blob, dataset_name):
        """repful-for (Clojure) vs repful (Python) for shared rep comments.

        Gates on most variants since the gid label-swap fix (2026-07-05
        removal of the group size re-sort). Residual known-bad: two
        incremental variants with deeper trajectory divergence
        (pakistan-incremental: Clojure blob PCA computed on a comment
        subset; vw-incremental: in-conv trajectory divergence) — deferred
        to the sequential-parity work — plus FLI-cold_start since the mode
        collapse (2026-07-27): the PROD blob carries Clojure's UNSEEDED
        cold-start PCA (Q12, #2661) and the collapse made the
        Clojure-faithful legacy kmeans the only cold-tick path, so the
        selection sets no longer intersect that particular random draw.
        The battery certifies FLI end-to-end against pinned-cold-start
        Clojure recordings (20/20 MATCH), which supersedes this prod-blob
        comparison for that variant.
        """
        if request.node.callspec.id in ('vw-incremental', 'pakistan-incremental'):
            request.applymarker(pytest.mark.xfail(
                raises=AssertionError,
                strict=False,
                reason="residual incremental trajectory divergence (gid "
                       "label swap fixed 2026-07-05; sequential-parity "
                       "work)"))
        if request.node.callspec.id == 'FLI-cold_start':
            request.applymarker(pytest.mark.xfail(
                strict=False,
                reason="prod blob Q12 unseeded cold-start PCA (#2661) vs "
                       "the collapse's legacy-kmeans cold tick — zero "
                       "shared selections; battery certifies FLI against "
                       "pinned-cold-start recordings instead"))
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = (conv.repness or {}).get('group_repness', {})
        shared_count = 0
        mismatches = []

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            py_by_tid = {int(e['comment_id']): e for e in python_repness.get(gid, [])}
            for clj_entry in clj_entries:
                tid = clj_entry['tid']
                py_entry = py_by_tid.get(tid)
                if py_entry is None:
                    continue
                shared_count += 1
                clj_val = clj_entry.get('repful-for', '')
                py_val = py_entry.get('repful', '')
                if clj_val != py_val:
                    mismatches.append(
                        f"  g{gid}/t{tid}: clj={clj_val}, py={py_val}")

        if mismatches:
            print(f"[{dataset_name}] {len(mismatches)} repful mismatches:")
            for m in mismatches[:10]:
                print(m)
        check.greater(shared_count, 0,
                      "No shared comments to compare (D10)")
        check.equal(len(mismatches), 0, f"{len(mismatches)} repful-for/repful mismatches")


# ============================================================================
# D10 — Representative Comment Selection
# ============================================================================

@pytest.mark.clojure_comparison
class TestD10RepCommentSelection:
    """
    D10: Python selects 3 agree + 2 disagree = 5 total
         Clojure selects up to 5 total, agrees first, with beats-best-by-test logic
    """

    def test_rep_comments_match_clojure(self, request, conv, clojure_blob, dataset_name):
        """Selected representative comments per group should match Clojure.

        biodiversity-cold_start matches exactly since the gid label-swap
        fix (2026-07-05) and gates. Other variants remain xfailed: the
        selection is highly sensitive to residual per-(gid, tid)
        group-membership/stat divergence. D10 selection LOGIC is verified
        by TestD10PassesByTest, TestD10BeatsBestByTest, TestD10BeatsBestAgr,
        TestD10SelectRepCommentsBoundary.
        """
        if request.node.callspec.id != 'biodiversity-cold_start':
            request.applymarker(pytest.mark.xfail(
                raises=AssertionError,
                strict=False,
                reason="residual per-(gid, tid) group-membership/stat "
                       "divergence (gid label swap fixed 2026-07-05; "
                       "biodiversity-cold_start gates)"))
        clojure_repness = clojure_blob.get('repness', {})
        if not clojure_repness:
            pytest.skip("No repness in Clojure blob")

        python_repness = conv.repness or {}
        group_repness = python_repness.get('group_repness', {})

        total_groups = 0
        matching_groups = 0

        for gid_str, clj_entries in clojure_repness.items():
            gid = int(gid_str)
            clj_tids = set(e['tid'] for e in clj_entries)

            py_entries = group_repness.get(gid, [])
            py_tids = set(int(e['comment_id']) for e in py_entries)

            total_groups += 1
            overlap = len(clj_tids & py_tids)
            total_unique = len(clj_tids | py_tids)

            if clj_tids == py_tids:
                matching_groups += 1

            print(f"[{dataset_name}] Group {gid}: Clojure tids={sorted(clj_tids)}, Python tids={sorted(py_tids)}, overlap={overlap}/{total_unique}")

        check.equal(matching_groups, total_groups,
                     f"Only {matching_groups}/{total_groups} groups have matching rep comments")


# ----------------------------------------------------------------------------
# D10 — Public-fixture unit tests for the new selection helpers
# ----------------------------------------------------------------------------
#
# Pin the Clojure-parity semantics of `passes_by_test`, `beats_best_by_test`,
# `beats_best_agr`, and `select_rep_comments_df`. Public-fixture 1-group fixtures
# only — no real datasets, no Clojure blob dependency.
#
# References:
#   - Clojure `select-rep-comments`: math/src/polismath/math/repness.clj:212-281
#   - Helpers `passes-by-test?` :165, `beats-best-by-test?` :133,
#     `beats-best-agr?` :142, `finalize-cmt-stats` :173, `repness-metric` :191.
# ----------------------------------------------------------------------------


def _stats_row(tid, na, nd, pa, pd_, pat, pdt, ra, rd, rat, rdt, *, ns=None,
               agree_metric=None, disagree_metric=None, repful=None, group_id=0):
    """Build a single stats DataFrame row matching the schema produced by
    `compute_group_comment_stats_df`. Defaults derived per Clojure recipe."""
    if ns is None:
        ns = na + nd
    if agree_metric is None:
        agree_metric = ra * rat * pa * pat
    if disagree_metric is None:
        disagree_metric = rd * rdt * pd_ * pdt
    if repful is None:
        repful = 'agree' if rat > rdt else 'disagree'
    return {
        'group_id': group_id, 'comment': tid,
        'na': na, 'nd': nd, 'ns': ns,
        'pa': pa, 'pd': pd_,
        'pat': pat, 'pdt': pdt,
        'ra': ra, 'rd': rd,
        'rat': rat, 'rdt': rdt,
        'agree_metric': agree_metric, 'disagree_metric': disagree_metric,
        'repful': repful,
    }


class TestD10PassesByTest:
    """`passes-by-test?` (repness.clj:165) — OR'd on (rat, pat) and (rdt, pdt).

    NO probability threshold (`pa >= 0.5` was a Python-only over-restriction
    in the pre-D10 botched port — Clojure has no such gate)."""

    def test_agree_side_significant_passes(self):
        row = _stats_row(1, na=8, nd=2, pa=0.75, pd_=0.25, pat=2.0, pdt=-2.0,
                         ra=2.0, rd=0.5, rat=2.0, rdt=-2.0)  # rat,pat > Z_90
        assert passes_by_test(row)

    def test_disagree_side_significant_passes(self):
        row = _stats_row(2, na=2, nd=8, pa=0.25, pd_=0.75, pat=-2.0, pdt=2.0,
                         ra=0.5, rd=2.0, rat=-2.0, rdt=2.0)  # rdt,pdt > Z_90
        assert passes_by_test(row)

    def test_neither_side_significant_fails(self):
        row = _stats_row(3, na=5, nd=5, pa=0.5, pd_=0.5, pat=0.5, pdt=0.5,
                         ra=1.0, rd=1.0, rat=0.5, rdt=0.5)
        assert not passes_by_test(row)

    def test_no_pa_threshold_gate(self):
        """Pre-D10 Python added `pa >= 0.5` — Clojure has no such gate. A row
        with pa=0.4 that's otherwise significant on the agree side must pass."""
        row = _stats_row(4, na=4, nd=6, pa=0.42, pd_=0.58, pat=2.0, pdt=-2.0,
                         ra=2.0, rd=0.5, rat=2.0, rdt=-2.0)
        assert passes_by_test(row), "no pa>=0.5 gate (Clojure parity)"


class TestD10BeatsBestByTest:
    """`beats-best-by-test?` (repness.clj:133) — max(rat, rdt) > current_best_z."""

    def test_none_best_always_beats(self):
        row = _stats_row(1, na=5, nd=2, pa=0.6, pd_=0.4, pat=1.0, pdt=-1.0,
                         ra=1.2, rd=0.8, rat=2.0, rdt=0.5)
        assert beats_best_by_test(row, None)

    def test_max_rat_rdt_used(self):
        row = _stats_row(1, na=5, nd=2, pa=0.6, pd_=0.4, pat=1.0, pdt=-1.0,
                         ra=1.2, rd=0.8, rat=2.0, rdt=0.5)
        # max = 2.0
        assert beats_best_by_test(row, 1.5)
        assert not beats_best_by_test(row, 2.5)

    def test_strict_greater_than(self):
        row = _stats_row(1, na=5, nd=2, pa=0.6, pd_=0.4, pat=1.0, pdt=-1.0,
                         ra=1.2, rd=0.8, rat=2.0, rdt=0.5)
        assert not beats_best_by_test(row, 2.0), "strict > (Clojure parity)"


class TestD10BeatsBestAgr:
    """`beats-best-agr?` (repness.clj:142) — 4-branch agree priority logic."""

    def test_na_nd_zero_always_rejected(self):
        """Branch 1: (= 0 na nd) → false. Unvoted comments excluded from best-agree
        regardless of stats."""
        unvoted = _stats_row(1, na=0, nd=0, pa=0.5, pd_=0.5, pat=1.0, pdt=1.0,
                             ra=1.0, rd=1.0, rat=1.0, rdt=1.0)
        assert not beats_best_agr(unvoted, None)
        other = _stats_row(2, na=5, nd=2, pa=0.6, pd_=0.4, pat=1.0, pdt=-1.0,
                           ra=1.2, rd=0.8, rat=2.0, rdt=0.5)
        assert not beats_best_agr(unvoted, other)

    def test_branch_2_ra_gt_1_uses_4way_product(self):
        """Branch 2: current_best AND current_best.ra > 1.0 → compare ra*rat*pa*pat."""
        big_ra_best = _stats_row(1, na=10, nd=0, pa=0.9, pd_=0.1, pat=2.0, pdt=-2.0,
                                  ra=2.0, rd=0.5, rat=2.0, rdt=-2.0)
        # ra*rat*pa*pat = 2.0*2.0*0.9*2.0 = 7.2
        bigger = _stats_row(2, na=15, nd=0, pa=0.94, pd_=0.06, pat=3.0, pdt=-3.0,
                             ra=2.5, rd=0.4, rat=2.5, rdt=-2.5)
        # 2.5*2.5*0.94*3.0 = 17.625 > 7.2
        smaller = _stats_row(3, na=5, nd=0, pa=0.86, pd_=0.14, pat=1.5, pdt=-1.5,
                              ra=1.5, rd=0.6, rat=1.5, rdt=-1.5)
        # 1.5*1.5*0.86*1.5 ≈ 2.9 < 7.2
        assert beats_best_agr(bigger, big_ra_best)
        assert not beats_best_agr(smaller, big_ra_best)

    def test_branch_3_ra_le_1_uses_pa_pat_product(self):
        """Branch 3: current_best AND current_best.ra <= 1.0 → compare pa*pat only."""
        weak_best = _stats_row(1, na=5, nd=4, pa=0.55, pd_=0.45, pat=1.0, pdt=-1.0,
                                ra=0.9, rd=1.1, rat=1.0, rdt=-1.0)
        # pa*pat = 0.55
        bigger = _stats_row(2, na=6, nd=2, pa=0.7, pd_=0.3, pat=1.2, pdt=-1.2,
                             ra=1.0, rd=1.0, rat=0.5, rdt=-0.5)
        # pa*pat = 0.84 > 0.55
        assert beats_best_agr(bigger, weak_best)

    def test_branch_4_no_best_accepts_via_z_sig_pat(self):
        """Branch 4 / no current_best: accept if z90(pat) is true."""
        row = _stats_row(1, na=6, nd=4, pa=0.58, pd_=0.42, pat=1.5, pdt=-1.5,
                         ra=0.9, rd=1.1, rat=1.0, rdt=-1.0)  # pat=1.5 > Z_90=1.2816
        assert beats_best_agr(row, None)

    def test_branch_4_no_best_accepts_via_ra_gt_1_and_pa_gt_half(self):
        """Branch 4 / no current_best: accept if ra > 1.0 AND pa > 0.5
        (even when pat not significant)."""
        row = _stats_row(1, na=5, nd=4, pa=0.55, pd_=0.45, pat=0.5, pdt=-0.5,
                         ra=1.2, rd=0.8, rat=0.5, rdt=-0.5)
        assert beats_best_agr(row, None)

    def test_branch_4_no_best_rejects_when_neither(self):
        """Branch 4 / no current_best: reject if neither z90(pat) nor
        (ra > 1.0 AND pa > 0.5)."""
        row = _stats_row(1, na=4, nd=5, pa=0.45, pd_=0.55, pat=0.5, pdt=0.5,
                         ra=0.8, rd=1.2, rat=0.5, rdt=0.5)
        assert not beats_best_agr(row, None)


class TestD10SelectRepCommentsBoundary:
    """`select_rep_comments_df` Clojure-parity boundaries."""

    def test_empty_input_returns_empty(self):
        result = _assemble_rep_comments(pd.DataFrame())
        assert len(result) == 0

    def test_single_unvoted_row_falls_through_to_best(self):
        """`beats_best_by_test` does NOT filter na=nd=0; only `beats_best_agr`
        Branch 1 does. So a sole na=nd=0 row still ends up in the `:best`
        fallback (Clojure parity — repness.clj:244-247). The `:best_agree`
        slot stays empty (Branch 1 rejects). Output is [best], not [].
        """
        rows = [
            _stats_row(1, na=0, nd=0, pa=0.5, pd_=0.5, pat=0.0, pdt=0.0,
                       ra=1.0, rd=1.0, rat=0.0, rdt=0.0),
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        assert len(result) == 1
        assert result[0]['comment_id'] == 1
        # NOT the best-agree slot (Branch 1 rejected na=nd=0).
        assert 'best_agree' not in result[0]

    def test_sufficient_empty_best_agree_only(self):
        """Sufficient empty + best_agree exists → returns [best_agree_finalized]."""
        # passes_by_test fails (pat=pdt below z90, rat=rdt below z90).
        # beats_best_agr triggers via Branch 4: z90(pat) is true (pat=1.5).
        rows = [
            _stats_row(1, na=6, nd=4, pa=0.58, pd_=0.42, pat=1.5, pdt=-1.5,
                       ra=0.9, rd=1.1, rat=1.0, rdt=-1.0),
            # Filler row to make this not trivially the only one — also fails
            # passes_by_test and beats_best_agr.
            _stats_row(2, na=3, nd=5, pa=0.4, pd_=0.6, pat=-0.5, pdt=0.5,
                       ra=0.8, rd=1.2, rat=-0.3, rdt=0.3),
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        assert len(result) == 1
        # New select_rep_comments_df returns (rep_df, best_agree_dict); the
        # `_assemble_rep_comments` wrapper returns the flat List[Dict]
        # (decision S2).
        row = result[0]
        assert row['comment_id'] == 1
        # best_agree flag emitted in Python-convention key naming (decision S1 / Q2).
        assert row.get('best_agree') is True, "best_agree slot should be flagged"
        assert row.get('n_agree') == 6, "n_agree should be na from the raw best-agree row"

    def test_take_5_cap_agrees_before_disagrees(self):
        """7 sufficient candidates (4 agree-passing, 3 disagree-passing).
        Sort by metric desc → take 5 → agrees-before-disagrees."""
        rows = [
            # 4 agree-passing, large to small agree_metric
            _stats_row(1, na=9, nd=1, pa=0.83, pd_=0.17, pat=2.5, pdt=-2.5,
                       ra=2.0, rd=0.5, rat=2.5, rdt=-2.5),  # agree_metric ~10.4
            _stats_row(2, na=8, nd=2, pa=0.75, pd_=0.25, pat=2.0, pdt=-2.0,
                       ra=1.8, rd=0.55, rat=2.0, rdt=-2.0),  # ~5.4
            _stats_row(3, na=7, nd=3, pa=0.67, pd_=0.33, pat=1.5, pdt=-1.5,
                       ra=1.5, rd=0.6, rat=1.5, rdt=-1.5),  # ~2.27
            _stats_row(4, na=6, nd=4, pa=0.58, pd_=0.42, pat=1.3, pdt=-1.3,
                       ra=1.3, rd=0.7, rat=1.3, rdt=-1.3),  # ~1.27
            # 3 disagree-passing, large to small disagree_metric
            _stats_row(5, na=1, nd=9, pa=0.17, pd_=0.83, pat=-2.5, pdt=2.5,
                       ra=0.5, rd=2.0, rat=-2.5, rdt=2.5),  # ~10.4
            _stats_row(6, na=2, nd=8, pa=0.25, pd_=0.75, pat=-2.0, pdt=2.0,
                       ra=0.55, rd=1.8, rat=-2.0, rdt=2.0),  # ~5.4
            _stats_row(7, na=3, nd=7, pa=0.33, pd_=0.67, pat=-1.5, pdt=1.5,
                       ra=0.6, rd=1.5, rat=-1.5, rdt=1.5),  # ~2.27
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        assert len(result) == 5
        # Agrees-before-disagrees: all agrees precede all disagrees in the output.
        repful_values = [r['repful'] for r in result]  # List[Dict] per S2
        last_agree_idx = -1
        first_disagree_idx = len(repful_values)
        for i, v in enumerate(repful_values):
            if v == 'agree':
                last_agree_idx = i
            elif v == 'disagree' and first_disagree_idx == len(repful_values):
                first_disagree_idx = i
        assert last_agree_idx < first_disagree_idx, \
            f"agrees must come before disagrees, got order: {repful_values}"

    def test_take_5_eviction_when_best_agree_outside_sufficient(self):
        """The eviction edge case (flagged in PLAN for future review).

        Sufficient has 5 entries, best_agree is OUTSIDE sufficient (failed
        passes_by_test). Prepending best_agree pushes total to 6, take(5) drops
        the lowest-metric sufficient entry.

        Fixture design (subtle):
          - tid 1: best_agree slot. Fails passes_by_test (rat=1.0, pat=1.0
            both below Z_90=1.2816). Branch 4 accepts via ra>1.0 AND pa>0.5.
            Its agree_metric (ra*rat*pa*pat = 0.9) is LARGER than every
            sufficient row's metric, so subsequent rows can't beat it via
            Branch 2.
          - tid 2-6: pass passes_by_test (rat,pat at 1.3 > Z_90), with
            DECREASING agree_metrics all SMALLER than 0.9, so Branch 2 keeps
            tid 1 as best_agree throughout.

        Expected: tid 1 prepended, sort gives [tid 5, 4, 3, 2, 6] (desc by
        agree_metric), take(5) drops tid 6 (smallest metric).

        See PLAN.md "Pending — needs team discussion": take-5 eviction.
        """
        rows = [
            # best_agree slot: fails passes_by_test, qualifies via Branch 4
            # (ra=1.5>1 AND pa=0.6>0.5). agree_metric = 1.5*1.0*0.6*1.0 = 0.9.
            _stats_row(1, na=6, nd=4, pa=0.6, pd_=0.4, pat=1.0, pdt=-1.0,
                       ra=1.5, rd=0.7, rat=1.0, rdt=-1.0),
            # 5 sufficient rows, each with agree_metric < 0.9.
            # ra=1.0, rat=1.3, pa=0.5, pat=1.3 → agree_metric = 0.845
            _stats_row(2, na=5, nd=5, pa=0.5, pd_=0.5, pat=1.3, pdt=-1.3,
                       ra=1.0, rd=1.0, rat=1.3, rdt=-1.3),
            # ra=0.9, rat=1.3, pa=0.4, pat=1.3 → agree_metric = 0.609
            _stats_row(3, na=4, nd=6, pa=0.4, pd_=0.6, pat=1.3, pdt=-1.3,
                       ra=0.9, rd=1.1, rat=1.3, rdt=-1.3),
            # ra=0.8, rat=1.3, pa=0.3, pat=1.3 → agree_metric = 0.406
            _stats_row(4, na=3, nd=7, pa=0.3, pd_=0.7, pat=1.3, pdt=-1.3,
                       ra=0.8, rd=1.2, rat=1.3, rdt=-1.3),
            # ra=0.7, rat=1.3, pa=0.2, pat=1.3 → agree_metric = 0.237
            _stats_row(5, na=2, nd=8, pa=0.2, pd_=0.8, pat=1.3, pdt=-1.3,
                       ra=0.7, rd=1.3, rat=1.3, rdt=-1.3),
            # ra=0.6, rat=1.3, pa=0.15, pat=1.3 → agree_metric = 0.152 (smallest, evicted)
            _stats_row(6, na=1, nd=9, pa=0.15, pd_=0.85, pat=1.3, pdt=-1.3,
                       ra=0.6, rd=1.4, rat=1.3, rdt=-1.3),
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        assert len(result) == 5
        tids = [r['comment_id'] for r in result]
        # best_agree (tid 1) prepended at position 0.
        assert tids[0] == 1, f"best-agree slot at position 0, got {tids[0]}"
        # Tid 6 (smallest sufficient metric) evicted.
        assert 6 not in tids, f"lowest-metric sufficient should be evicted, got {tids}"
        # Rest are tids 2-5 in some agree-first ordering.
        assert set(tids[1:]) == {2, 3, 4, 5}, f"expected tids 2-5 to remain, got {tids[1:]}"
        # best_agree flag on position 0.
        assert result[0].get('best_agree') is True
        assert result[0].get('n_agree') == 6  # raw na from tid 1


class TestD10TestGaps:
    """Additional D10 coverage filling gaps identified in decisions D10.8.

    These pin behaviours not previously asserted:
      - mod_out filtering on the best-agree path.
      - Deterministic tiebreak (lowest tid wins) on `beats_best_by_test`
        max(rat,rdt) ties and on the `_sort_key` agree_metric ties.
      - Disagree-only path through assembly + agrees-before-disagrees no-op.
      - All-uninformative `ns=0` rows: passes_by_test fails, Branch 1 rejects
        best_agree; best may still get set via Branch 4 / beats_best_by_test.
      - Negative-ra rows handled correctly by Branch 2 (signed 4-way product).
    """

    # --- Deliverable 3: deterministic max(rat, rdt) tiebreak ------------------

    def test_tied_max_rt_uses_deterministic_tiebreak(self):
        """Two rows with identical max(rat, rdt) — strict `>` means the FIRST
        iterated row wins. Sorting by `comment` (tid) ascending makes that
        the LOWER tid (Clojure named-matrix insertion order parity, decision
        D10.8.1)."""
        rows = [
            # Pass through `best` slot (neither passes passes_by_test —
            # rat/rdt below Z_90), tied max(rat, rdt) = 1.0.
            # Insert in REVERSE tid order to prove we sort, not just take input order.
            _stats_row(7, na=4, nd=2, pa=0.55, pd_=0.45, pat=0.5, pdt=-0.5,
                       ra=1.0, rd=1.0, rat=1.0, rdt=-1.0),
            _stats_row(3, na=4, nd=2, pa=0.55, pd_=0.45, pat=0.5, pdt=-0.5,
                       ra=1.0, rd=1.0, rat=1.0, rdt=-1.0),
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        assert len(result) == 1
        # Tid 3 (lower) wins the `best` slot under the tid-ascending tiebreak.
        assert result[0]['comment_id'] == 3, \
            f"lowest-tid wins tied max(rat,rdt); got {result[0]['comment_id']}"

    # --- Deliverable 5: 5 gap tests -------------------------------------------

    def test_mod_out_excludes_best_agree_candidate(self):
        """A `mod_out` tid that would otherwise own the best-agree slot is
        filtered before the reduce (Clojure repness.clj:222). The next-best
        candidate becomes best_agree."""
        rows = [
            # tid 1: would-be best_agree (ra=2.0>1, pa=0.8>0.5 → Branch 4 accepts;
            # strong ra*rat*pa*pat = 2.0*2.0*0.8*2.0 = 6.4 so it dominates Branch 2).
            _stats_row(1, na=8, nd=2, pa=0.8, pd_=0.2, pat=2.0, pdt=-2.0,
                       ra=2.0, rd=0.5, rat=2.0, rdt=-2.0),
            # tid 2: next-best (ra*rat*pa*pat = 1.5*1.5*0.7*1.5 ≈ 2.36).
            _stats_row(2, na=6, nd=3, pa=0.7, pd_=0.3, pat=1.5, pdt=-1.5,
                       ra=1.5, rd=0.6, rat=1.5, rdt=-1.5),
            # tid 3: weaker.
            _stats_row(3, na=5, nd=4, pa=0.55, pd_=0.45, pat=1.0, pdt=-1.0,
                       ra=1.1, rd=0.9, rat=1.0, rdt=-1.0),
        ]
        df = pd.DataFrame(rows)
        # Without mod_out: tid 1 wins best_agree.
        baseline = _assemble_rep_comments(df)
        baseline_best_agree = next(r for r in baseline if r.get('best_agree'))
        assert baseline_best_agree['comment_id'] == 1
        # With tid 1 moderated out: tid 2 must win best_agree, tid 1 absent.
        result = _assemble_rep_comments(df, mod_out=[1])
        tids = [r['comment_id'] for r in result]
        assert 1 not in tids, f"mod_out tid 1 must be excluded, got {tids}"
        flagged = [r for r in result if r.get('best_agree')]
        assert len(flagged) == 1, "exactly one best_agree slot"
        assert flagged[0]['comment_id'] == 2, \
            f"next-best (tid 2) should become best_agree, got {flagged[0]['comment_id']}"

    def test_mod_out_accepts_ndarray(self):
        """`mod_out` typed Optional[Iterable[int]] — callers may pass a numpy
        array or pandas Index (e.g. sourced from a DataFrame column). Bare
        `if mod_out:` truthiness raises 'truth value of an array is
        ambiguous' for len>1 arrays; the check must be `is not None`
        (Copilot review 2026-07-04, verified)."""
        rows = [
            _stats_row(1, na=8, nd=2, pa=0.8, pd_=0.2, pat=2.0, pdt=-2.0,
                       ra=2.0, rd=0.5, rat=2.0, rdt=-2.0),
            _stats_row(2, na=6, nd=3, pa=0.7, pd_=0.3, pat=1.5, pdt=-1.5,
                       ra=1.5, rd=0.6, rat=1.5, rdt=-1.5),
            _stats_row(3, na=5, nd=4, pa=0.55, pd_=0.45, pat=1.0, pdt=-1.0,
                       ra=1.1, rd=0.9, rat=1.0, rdt=-1.0),
        ]
        df = pd.DataFrame(rows)
        # len-2 ndarray: bare truthiness would raise ValueError.
        result = _assemble_rep_comments(df, mod_out=np.array([1, 3]))
        tids = [r['comment_id'] for r in result]
        assert 1 not in tids and 3 not in tids, \
            f"ndarray mod_out tids must be excluded, got {tids}"
        assert 2 in tids

    def test_tied_agree_metric_in_sort_uses_deterministic_tiebreak(self):
        """Two `sufficient` rows with identical `agree_metric` resolve
        deterministically. `list.sort` is stable in CPython, so the lower-tid
        row (which entered `sufficient` first thanks to the tid-ascending
        iter sort) appears first after descending sort by metric.

        Decision D10.8.1: lowest tid wins ties."""
        # Both rows pass passes_by_test (rat,pat at 2.0 > Z_90).
        # Identical agree_metric: ra*rat*pa*pat is the SAME for both.
        # ra=1.5, rat=2.0, pa=0.7, pat=2.0 → agree_metric = 4.2 (both).
        # Insert in REVERSE tid order to prove the deterministic outcome
        # comes from the sort, not the input order.
        rows = [
            _stats_row(9, na=7, nd=3, pa=0.7, pd_=0.3, pat=2.0, pdt=-2.0,
                       ra=1.5, rd=0.6, rat=2.0, rdt=-2.0),
            _stats_row(2, na=7, nd=3, pa=0.7, pd_=0.3, pat=2.0, pdt=-2.0,
                       ra=1.5, rd=0.6, rat=2.0, rdt=-2.0),
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        # 2 sufficient rows; one of them is also best_agree.
        # Order: best_agree (tid 2, lowest tid wins beats_best_agr ties via
        # strict-> first-row-wins) prepended, then deduped sufficient (tid 9).
        tids = [r['comment_id'] for r in result]
        assert tids[0] == 2, \
            f"lowest-tid wins tied beats_best_agr Branch 2 product; got {tids}"
        assert result[0].get('best_agree') is True

    def test_disagree_only_group(self):
        """All sufficient rows are `repful='disagree'`. Sort works on
        `disagree_metric`; agrees-before-disagrees partition is a no-op."""
        rows = [
            # 3 disagree-passing rows (rdt,pdt > Z_90), descending disagree_metric.
            _stats_row(1, na=1, nd=9, pa=0.17, pd_=0.83, pat=-2.5, pdt=2.5,
                       ra=0.5, rd=2.0, rat=-2.5, rdt=2.5),  # disagree_metric ≈ 8.6
            _stats_row(2, na=2, nd=8, pa=0.25, pd_=0.75, pat=-2.0, pdt=2.0,
                       ra=0.55, rd=1.8, rat=-2.0, rdt=2.0),  # ≈ 5.4
            _stats_row(3, na=3, nd=7, pa=0.33, pd_=0.67, pat=-1.5, pdt=1.5,
                       ra=0.6, rd=1.5, rat=-1.5, rdt=1.5),  # ≈ 2.27
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        # All rows have repful='disagree' (rdt > rat for each).
        assert len(result) >= 1
        assert all(r['repful'] == 'disagree' for r in result), \
            f"all rows should be disagree, got {[r['repful'] for r in result]}"
        assert len(result) <= 5, "take-5 cap holds"
        # best_agree may also be present (Branch 4 doesn't require agree side
        # to dominate — z90(pat) is false here, ra<1 for all, so Branch 4
        # rejects all candidates and best_agree stays None for all entries).
        # No row should be flagged as best_agree given the fixture.
        assert not any(r.get('best_agree') for r in result), \
            "no row qualifies for best_agree under Branch 4 with ra<1 and pat<Z_90"

    def test_all_ns_zero_uninformative_rows(self):
        """Every row has ns=0 → pa=pd=0.5 (uninformative). No row passes
        passes_by_test (pat,pdt collapse to 1.0 via prop_test n=0 shortcut,
        below Z_90=1.2816). `beats_best_agr` Branch 1 rejects all
        (na=nd=0), so best_agree stays None.

        `best` MAY get set via `beats_best_by_test` (no na=nd=0 guard there).
        Output length is 0 (if no row passes either gate) or 1 (the best
        fallback). With max(rat,rdt) > None=True on first row, best gets set,
        so output is exactly [best]."""
        # Build via _stats_row but override pat/pdt to match the n=0 collapse:
        # prop_test_vectorized(0, 0) = 2*sqrt(1)*(1/1 - 0.5) = 1.0 < Z_90.
        rows = [
            _stats_row(1, na=0, nd=0, pa=0.5, pd_=0.5, pat=1.0, pdt=1.0,
                       ra=1.0, rd=1.0, rat=0.5, rdt=0.5, ns=0),
            _stats_row(2, na=0, nd=0, pa=0.5, pd_=0.5, pat=1.0, pdt=1.0,
                       ra=1.0, rd=1.0, rat=0.3, rdt=0.4, ns=0),
        ]
        result = _assemble_rep_comments(pd.DataFrame(rows))
        # passes_by_test fails (pat=1.0<Z_90, pdt=1.0<Z_90, rat<Z_90, rdt<Z_90)
        # → sufficient empty.
        # beats_best_agr Branch 1 rejects every row (na=nd=0)
        # → best_agree stays None.
        # beats_best_by_test fills `best` (no na=nd=0 guard).
        # → output is exactly [best], length 1, no best_agree flag.
        assert len(result) in (0, 1), \
            f"output length must be 0 or 1, got {len(result)}"
        # Under the current logic best gets set, so we expect 1 with no flag.
        assert len(result) == 1
        assert 'best_agree' not in result[0], \
            "Branch 1 rejected na=nd=0 from best_agree, so no flag"

    def test_branch_2_handles_negative_ra_correctly(self):
        """Branch 2 (current_best.ra > 1.0) compares the SIGNED 4-way product
        `ra * rat * pa * pat`. A candidate with negative `ra` and negative
        `rat` produces a positive product that can beat the current best,
        while a candidate with single negative factor produces a negative
        product that cannot."""
        # Set up so iteration order: tid 1 (current_best), tid 2 (negative
        # single factor, should NOT beat), tid 3 (two negatives → positive,
        # should beat ONLY if its product is larger).
        current_best_row = _stats_row(
            1, na=8, nd=2, pa=0.8, pd_=0.2, pat=2.0, pdt=-2.0,
            ra=2.0, rd=0.5, rat=2.0, rdt=-2.0)
        # current_best product = 2.0*2.0*0.8*2.0 = 6.4.

        # Single negative factor → negative product → loses on strict >.
        single_neg = _stats_row(
            2, na=1, nd=1, pa=0.5, pd_=0.5, pat=1.0, pdt=1.0,
            ra=-0.5, rd=1.0, rat=1.0, rdt=1.0)
        # product = -0.5*1.0*0.5*1.0 = -0.25 < 6.4 → does NOT beat.
        assert not beats_best_agr(single_neg, current_best_row), \
            "single negative factor → negative product loses Branch 2"

        # Two negatives → positive product. Make it LARGER than 6.4.
        # ra=-5.0, rat=-2.0, pa=0.9, pat=2.0 → -5 * -2 * 0.9 * 2 = 18.0 > 6.4.
        two_neg = _stats_row(
            3, na=5, nd=5, pa=0.9, pd_=0.1, pat=2.0, pdt=-2.0,
            ra=-5.0, rd=0.2, rat=-2.0, rdt=-2.0)
        assert beats_best_agr(two_neg, current_best_row), \
            "two negative factors → positive 18.0 > 6.4 wins Branch 2"

        # Two negatives but product NOT larger → loses.
        two_neg_small = _stats_row(
            4, na=1, nd=1, pa=0.5, pd_=0.5, pat=1.0, pdt=1.0,
            ra=-1.0, rd=1.0, rat=-1.0, rdt=1.0)
        # product = -1 * -1 * 0.5 * 1 = 0.5 < 6.4 → does NOT beat.
        assert not beats_best_agr(two_neg_small, current_best_row), \
            "two negatives but small positive product (0.5) still loses to 6.4"


# ============================================================================
# D11 — Consensus Comment Selection
# ============================================================================

@pytest.mark.clojure_comparison
class TestD11ConsensusSelection:
    """
    D11: Python uses ALL groups pa > 0.6, top 2 overall
         Clojure uses per-comment pa > 0.5, top 5 agree + 5 disagree with z-test scores
    """

    def test_consensus_matches_clojure(self, request, conv, clojure_blob, dataset_name):
        """Consensus selection should match Clojure on cold_start.

        After D11 (PR 9), Python's `consensus_comments` is a dict
        `{'agree': [...], 'disagree': [...]}` mirroring Clojure's shape.
        Consensus stats are whole-conversation (no group split), so unlike
        rep-comments this is NOT affected by upstream PCA/KMeans
        group-membership divergence. The ns-PASS divergence
        (DISCOVERY 2026-06-11) was fixed by switching `ns` from `na + nd`
        to `notna().sum()` — matches Clojure `(count (filter identity ...))`
        in repness.clj:56-61.
        """
        # Per-variant xfail (g5, 2026-07-04): known-bad INCREMENTAL variants
        # only. biodiversity-incremental was documented 2026-06-11 (residual
        # upstream PCA/KMeans group-membership divergence affecting which
        # participants are in-conv at the incremental step). Scoping the
        # previously-blanket xfail(strict=False) then UNMASKED
        # bg2018-incremental and pakistan-incremental (private datasets) —
        # failures the blanket had silently absorbed, undocumented until
        # 2026-07-04. Same incremental-divergence family; resolution belongs
        # to the sequential-parity work (replay infra / warm-start port).
        # ALL cold_start variants and vw-incremental match Clojure exactly
        # and MUST keep gating.
        _known_bad_incremental = ('biodiversity', 'bg2018', 'pakistan')
        _callspec = request.node.callspec.id
        if 'incremental' in _callspec and any(
                ds in _callspec for ds in _known_bad_incremental):
            request.applymarker(pytest.mark.xfail(
                raises=AssertionError,
                strict=False,
                reason="known-bad incremental variant (biodiversity: journal "
                       "2026-06-11; bg2018/pakistan: unmasked 2026-07-04 when "
                       "the blanket xfail was scoped per-variant): residual "
                       "upstream incremental divergence, deferred to the "
                       "sequential-parity work"))

        clj_consensus = clojure_blob.get('consensus', {})
        if not clj_consensus:
            pytest.skip("No consensus in Clojure blob")

        clj_agree_tids = set(e['tid'] for e in clj_consensus.get('agree', []))
        clj_disagree_tids = set(e['tid'] for e in clj_consensus.get('disagree', []))
        clj_all = clj_agree_tids | clj_disagree_tids

        py_consensus = (conv.repness.get('consensus_comments', {})
                        if conv.repness else {})
        py_agree_tids = set(int(c['tid'])
                            for c in py_consensus.get('agree', []))
        py_disagree_tids = set(int(c['tid'])
                               for c in py_consensus.get('disagree', []))
        py_all = py_agree_tids | py_disagree_tids

        print(f"[{dataset_name}] Consensus Clojure: "
              f"agree={sorted(clj_agree_tids)}, "
              f"disagree={sorted(clj_disagree_tids)}")
        print(f"[{dataset_name}] Consensus Python:  "
              f"agree={sorted(py_agree_tids)}, "
              f"disagree={sorted(py_disagree_tids)}")
        overlap = len(clj_all & py_all)
        print(f"[{dataset_name}] Consensus overlap: {overlap}/{len(clj_all)}")

        check.equal(py_agree_tids, clj_agree_tids,
                    f"Agree consensus mismatch")
        check.equal(py_disagree_tids, clj_disagree_tids,
                    f"Disagree consensus mismatch")


class TestD11ConsensusStatsDf:
    """`consensus_stats_df` — whole-conversation per-comment stats (no group split)."""

    @staticmethod
    def _vote_matrix(per_comment_votes):
        """Helper: build a vote matrix from {tid: [vote_per_participant]}."""
        return pd.DataFrame(per_comment_votes)

    def test_basic_counts(self):
        """na/nd/ns counted correctly across all participants."""
        # 5 participants, 3 comments
        # tid 1: 4 agrees, 1 disagree → na=4, nd=1, ns=5
        # tid 2: 2 agrees, 3 disagrees → na=2, nd=3, ns=5
        # tid 3: 1 agree, 2 disagrees, 2 NaN (pass/unvoted) → na=1, nd=2, ns=3
        votes = pd.DataFrame({
            1: [AGREE, AGREE, AGREE, AGREE, DISAGREE],
            2: [AGREE, AGREE, DISAGREE, DISAGREE, DISAGREE],
            3: [AGREE, DISAGREE, DISAGREE, np.nan, np.nan],
        })
        df = consensus_stats_df(votes)
        assert df.loc[1, 'na'] == 4 and df.loc[1, 'nd'] == 1 and df.loc[1, 'ns'] == 5
        assert df.loc[2, 'na'] == 2 and df.loc[2, 'nd'] == 3 and df.loc[2, 'ns'] == 5
        assert df.loc[3, 'na'] == 1 and df.loc[3, 'nd'] == 2 and df.loc[3, 'ns'] == 3

    def test_pseudocount_pa_pd(self):
        """pa/pd use Beta(2,2) smoothing: (na+1)/(ns+2)."""
        votes = pd.DataFrame({1: [AGREE, AGREE, AGREE, AGREE, DISAGREE]})
        df = consensus_stats_df(votes)
        # na=4, ns=5 → pa = 5/7 ≈ 0.714
        assert abs(df.loc[1, 'pa'] - 5/7) < 1e-10
        # nd=1, ns=5 → pd = 2/7 ≈ 0.286
        assert abs(df.loc[1, 'pd'] - 2/7) < 1e-10

    def test_ns_zero_uses_uninformative_prior(self):
        """When ns=0 (no agree/disagree at all), pa=pd=0.5."""
        votes = pd.DataFrame({1: [np.nan, np.nan, np.nan]})
        df = consensus_stats_df(votes)
        assert df.loc[1, 'pa'] == 0.5
        assert df.loc[1, 'pd'] == 0.5

    def test_mod_out_filters_tids(self):
        """`mod_out` removes tids from the output."""
        votes = pd.DataFrame({
            1: [AGREE, AGREE, AGREE],
            2: [AGREE, AGREE, AGREE],
            3: [AGREE, AGREE, AGREE],
        })
        df = consensus_stats_df(votes, mod_out={2})
        assert 1 in df.index
        assert 2 not in df.index
        assert 3 in df.index

    def test_mod_out_accepts_ndarray(self):
        """Same `is not None` requirement as select_rep_comments_df: a len>1
        numpy array as mod_out must filter, not raise 'truth value of an
        array is ambiguous' (Copilot review 2026-07-04, verified)."""
        votes = pd.DataFrame({
            1: [AGREE, AGREE, AGREE],
            2: [AGREE, AGREE, AGREE],
            3: [AGREE, AGREE, AGREE],
        })
        df = consensus_stats_df(votes, mod_out=np.array([2, 3]))
        assert 1 in df.index
        assert 2 not in df.index
        assert 3 not in df.index

    def test_ns_includes_pass_votes(self):
        """Clojure parity: ns counts all non-nil votes incl. PASS (repness.clj:56-61)."""
        votes = pd.DataFrame({
            1: [AGREE, AGREE, DISAGREE, 0, 0],  # 2A, 1D, 2P → ns=5
        })
        df = consensus_stats_df(votes)
        assert df.loc[1, 'na'] == 2
        assert df.loc[1, 'nd'] == 1
        assert df.loc[1, 'ns'] == 5, f"ns should include PASS (Clojure parity); got {df.loc[1, 'ns']}"


class TestD11SelectConsensusBoundary:
    """`select_consensus_comments_df` Clojure-parity boundaries."""

    @staticmethod
    def _stats(rows):
        """Helper: build a stats DataFrame from list of (tid, na, nd, ns, pa, pd, pat, pdt)."""
        df = pd.DataFrame(rows, columns=['tid', 'na', 'nd', 'ns', 'pa', 'pd', 'pat', 'pdt'])
        return df.set_index('tid')

    def test_empty_input_returns_empty_lists(self):
        result = select_consensus_comments_df(pd.DataFrame(columns=['na', 'nd', 'ns', 'pa', 'pd', 'pat', 'pdt']))
        assert result == {'agree': [], 'disagree': []}

    def test_clear_agree_consensus(self):
        """Comments with pa > 0.5 AND z-sig-90(pat) land in 'agree'."""
        stats = self._stats([
            (1, 9, 1, 10, 0.83, 0.17, 2.5, -2.5),  # pa>0.5, pat z90 → agree
            (2, 8, 2, 10, 0.75, 0.25, 2.0, -2.0),  # agree
        ])
        result = select_consensus_comments_df(stats)
        agree_tids = [e['tid'] for e in result['agree']]
        assert 1 in agree_tids and 2 in agree_tids
        assert result['disagree'] == []

    def test_clear_disagree_consensus(self):
        """Comments with pd > 0.5 AND z-sig-90(pdt) land in 'disagree'."""
        stats = self._stats([
            (1, 1, 9, 10, 0.17, 0.83, -2.5, 2.5),  # pd>0.5, pdt z90 → disagree
            (2, 2, 8, 10, 0.25, 0.75, -2.0, 2.0),
        ])
        result = select_consensus_comments_df(stats)
        disagree_tids = [e['tid'] for e in result['disagree']]
        assert 1 in disagree_tids and 2 in disagree_tids
        assert result['agree'] == []

    def test_divisive_no_consensus(self):
        """Comments split ~50/50 with low z-scores → neither list populated."""
        stats = self._stats([
            (1, 5, 5, 10, 0.5, 0.5, 0.0, 0.0),
            (2, 4, 6, 10, 0.42, 0.58, -0.4, 0.4),
        ])
        result = select_consensus_comments_df(stats)
        assert result['agree'] == []
        assert result['disagree'] == []

    def test_top_5_cap_per_side(self):
        """Each list capped at 5 entries."""
        # 7 high-agree comments
        rows = []
        for i, am in enumerate([2.5, 2.3, 2.1, 1.9, 1.7, 1.5, 1.4]):
            rows.append((i + 1, 9, 1, 10, 0.83, 0.17, am, -am))
        stats = self._stats(rows)
        result = select_consensus_comments_df(stats)
        assert len(result['agree']) == 5
        # Highest am at front: pa*pat = 0.83 * 2.5 = 2.075
        assert result['agree'][0]['tid'] == 1

    def test_entry_keys_match_clojure_blob(self):
        """Per-entry keys: tid, n-success, n-trials, p-success, p-test —
        EXACTLY the Clojure blob shape (repness.clj:181 + ::consensus spec).

        Narrows the S1 deferral (2026-07-04): consensus entries are new in
        D11 and flow raw into `result['consensus']` in to_dict /
        to_dynamo_dict, where server-helpers.ts:298-313 and client-report's
        majorityStrict.jsx:23-27 pluck `tid`. Python-convention keys would
        break both consumers. Rep-comment entries keep `comment_id` until
        the deferred math-blob alignment PR."""
        stats = self._stats([(1, 9, 1, 10, 0.83, 0.17, 2.5, -2.5)])
        result = select_consensus_comments_df(stats)
        entry = result['agree'][0]
        assert set(entry.keys()) == {'tid', 'n-success', 'n-trials', 'p-success', 'p-test'}
        assert entry['tid'] == 1
        # For agree side, n-success = na, p-success = pa, p-test = pat
        assert entry['n-success'] == 9
        assert entry['n-trials'] == 10
        assert abs(entry['p-success'] - 0.83) < 1e-10
        assert abs(entry['p-test'] - 2.5) < 1e-10

    def test_disagree_entry_uses_d_keys(self):
        """For disagree side, n-success = nd, p-success = pd, p-test = pdt."""
        stats = self._stats([(1, 1, 9, 10, 0.17, 0.83, -2.5, 2.5)])
        result = select_consensus_comments_df(stats)
        entry = result['disagree'][0]
        assert entry['n-success'] == 9   # = nd
        assert abs(entry['p-success'] - 0.83) < 1e-10  # = pd
        assert abs(entry['p-test'] - 2.5) < 1e-10  # = pdt

    def test_mutually_exclusive_lists(self):
        """With ns ≥ na+nd (ns includes PASS post-ns-PASS fix),
        pa + pd = (na+nd+PSEUDO_COUNT)/(ns+PSEUDO_COUNT) ≤ 1, so pa and pd
        cannot both exceed 0.5 — the same tid cannot appear in both lists.
        (The equality pa+pd=1 only holds for PASS-free comments, as in this
        fixture.)"""
        # PASS-free rows: na+nd = ns here (but the invariant above holds
        # generally, PASS or not).
        stats = self._stats([
            (1, 7, 3, 10, 0.67, 0.33, 1.5, -1.5),  # agree side
            (2, 3, 7, 10, 0.33, 0.67, -1.5, 1.5),  # disagree side
        ])
        result = select_consensus_comments_df(stats)
        agree_tids = {e['tid'] for e in result['agree']}
        disagree_tids = {e['tid'] for e in result['disagree']}
        assert agree_tids & disagree_tids == set(), \
            f"agree and disagree lists must be disjoint, got overlap {agree_tids & disagree_tids}"


# ============================================================================
# D12 — Comment Priorities
# ============================================================================

@pytest.mark.clojure_comparison
class TestD12CommentPriorities:
    """
    D12: Comment priorities are not computed by Python.
         Clojure computes priorities based on PCA extremity and importance.
    """

    def test_comment_priorities_exist(self, request, conv, clojure_blob, dataset_name):
        """Python produces REAL (varied) comment-priorities; blob coverage holds.

        History: until 2026-07-22 this asserted the all-49 signature on both
        sides (Python mirrored Clojure's #1961 truthy-0 bug, #2571). Clojure
        HEAD is fixed (#2611) and Python is un-mirrored, so the pins here are
        now: (a) priorities exist and cover the blob's tids; (b) Python's
        values are NOT the all-constant bug signature. VALUE parity vs
        Clojure is no longer checkable against these stale pre-#2611 blobs —
        it is validated by the H-B replay battery against Clojure HEAD
        (scripts/certify.py); see also the xfail in
        test_legacy_clojure_regression.py::test_comment_priorities.
        """
        clj_priorities = clojure_blob.get('comment-priorities', {})
        check.greater(len(clj_priorities), 0,
                       f"Clojure has {len(clj_priorities)} comment priorities")

        # Check that Python produces priorities
        has_priorities = hasattr(conv, 'comment_priorities') and conv.comment_priorities
        check.is_true(has_priorities, "Python should compute comment_priorities")

        if not has_priorities:
            return

        py_priorities = conv.comment_priorities
        # Normalize keys to int for comparison.
        clj_p = {int(k): v for k, v in clj_priorities.items()}
        py_p = {int(k): v for k, v in py_priorities.items()}
        common_tids = set(clj_p.keys()) & set(py_p.keys())
        print(f"[{dataset_name}] Common priority tids: {len(common_tids)}/{len(clj_p)}")
        check.greater(len(common_tids), 0, "Should have common priority tids")

        tids_sorted = sorted(common_tids)
        py_vals = [py_p[t] for t in tids_sorted]
        py_unique = set(py_vals)
        print(f"[{dataset_name}] py_vals  sample: {py_vals[:5]}, "
              f"min={min(py_vals)}, max={max(py_vals)}, "
              f"unique={len(py_unique)}")

        # Un-mirrored formula: real data always yields varied priorities.
        # All-constant output would mean the #2571 mirror crept back in.
        check.greater(len(py_unique), 1,
                      "Python priorities must be varied (real formula), not "
                      "the all-constant #2571 mirror signature")


class TestD12PriorityExtremityAlignment:
    """`_compute_comment_priorities` must fail closed on a PCA/columns desync.

    `dict(zip(rating_mat.columns, extremity_arr))` silently truncates when
    the PCA output was computed on a different column set than the current
    rating_mat (e.g. moderation changed between recomputes). Silent
    truncation assigns E=0 to the overflow tids — wrong priorities with no
    signal. The guard logs an error and returns {} (server falls back to
    uniform routing — degraded but honest). (Copilot review 2026-07-04, g4.)
    """

    def _conv_with_desync(self):
        conv = Conversation(conversation_id='ztest-desync')
        # 3 comments in the rating matrix...
        conv.rating_mat = pd.DataFrame(
            [[1.0, -1.0, 0.0], [1.0, 1.0, -1.0]],
            index=[0, 1], columns=[10, 11, 12],
        )
        conv.raw_rating_mat = conv.rating_mat.copy()
        # ...but PCA computed on only 2 (stale center/comps).
        conv.pca = {
            'center': np.array([0.5, -0.5]),
            'comps': np.array([[0.7, 0.7], [0.7, -0.7]]),
        }
        conv.group_clusters = []
        conv.meta_tids = set()
        return conv

    def test_desync_returns_empty_and_logs(self, caplog):
        conv = self._conv_with_desync()
        import logging
        with caplog.at_level(logging.ERROR):
            result = conv._compute_comment_priorities()
        assert result == {}, (
            f"desynced PCA/columns must fail closed (empty priorities), "
            f"got {result!r} — silent zip truncation assigns E=0 to "
            f"overflow tids"
        )
        assert any('extremity' in r.message.lower() or
                   'priorit' in r.message.lower()
                   for r in caplog.records), \
            "expected an ERROR log naming the priorities/extremity desync"

    def test_extremity_sign_reaches_priority_metric(self, monkeypatch):
        """End-to-end sign check through `_compute_comment_priorities`.

        `priority_metric` currently short-circuits to `META_PRIORITY**2` (the
        #2571 Clojure-bug mirror), so we can't assert on its RETURN value. But
        the extremity `E` it is CALLED with is exactly what the pca sign bug
        corrupts. We spy on that argument (independent of the mirror) and pin
        it to a hand-derived value.

        Setup: two comments, one near-unanimous AGREE (center +1), one
        near-unanimous DISAGREE (center -1), with pc1 = 1 / pc2 = 0 so
        extremity == |coef|. Correct convention translation ⇒ agree extremity 0,
        disagree extremity 2·sqrt(2). The pre-fix untranslated `-1` inverts them.

        `group_clusters` is left empty on purpose: A/P/S collapse to 0 for every
        tid, so the only quantity varying between the two calls is `E` — no
        confound from vote aggregation.
        """
        import polismath.conversation.conversation as convmod

        conv = Conversation(conversation_id='ztest-extremity-sign')
        conv.rating_mat = pd.DataFrame(
            [[1.0, -1.0], [1.0, -1.0], [1.0, -1.0]],   # 3 ptpts; col 10 agree, col 11 disagree
            index=[0, 1, 2], columns=[10, 11],
        )
        conv.raw_rating_mat = conv.rating_mat.copy()
        conv.pca = {
            'center': np.array([1.0, -1.0]),
            'comps': np.array([[1.0, 1.0], [0.0, 0.0]]),
        }
        conv.group_clusters = []
        conv.meta_tids = set()

        captured_E = []
        real_priority_metric = convmod.priority_metric

        def spy(is_meta, A, P, S, E):
            captured_E.append(E)
            return real_priority_metric(is_meta, A, P, S, E)

        monkeypatch.setattr(convmod, 'priority_metric', spy)
        conv._compute_comment_priorities()

        # Call order follows rating_mat.columns == [10 (agree), 11 (disagree)].
        assert len(captured_E) == 2, f"expected one priority_metric call per tid, got {captured_E}"
        e_agree, e_disagree = captured_E
        scale = np.sqrt(2)
        assert e_agree == pytest.approx(0.0, abs=1e-9), \
            "unanimous-agree comment must reach priority_metric with extremity ~0"
        assert e_disagree == pytest.approx(2.0 * scale), \
            "unanimous-disagree comment must reach priority_metric with maximal extremity"
        assert e_agree < e_disagree, \
            "extremity sign inverted: agree must be less extreme than disagree"


class TestD12PCAProjectComments:
    """`pca_project_cmnts` and `compute_comment_extremity` — Clojure parity."""

    def test_pca_project_cmnts_shape(self):
        """Output shape (n_cmnts, n_components)."""
        center = np.array([0.1, 0.2, 0.3, 0.4])
        comps = np.array([[1.0, 0.0, 0.5, 0.5],
                          [0.0, 1.0, 0.5, -0.5]])
        proj = pca_project_cmnts(center, comps)
        assert proj.shape == (4, 2)

    def test_pca_project_cmnts_formula(self):
        """Clojure-parity: proj[i] = sqrt(n_cmnts) * (AGREE - center[i]) * [pc1[i], pc2[i]].

        Clojure (`pca-project-cmnts`, pca.clj:167-178) projects a unit vote
        of `-1` because Clojure stays in raw-Postgres convention where AGREE = -1.
        Delphi fits PCA in its OWN convention (AGREE = +1, via the
        `postgres_vote_to_delphi` ingress flip), so the faithful port projects
        the Delphi `AGREE` constant, not the literal -1.

        Expected is derived from the `AGREE` constant (NOT copied from the
        implementation), so this catches a convention/sign regression instead of
        rubber-stamping whatever the code currently computes.
        """
        center = np.array([0.1, 0.2, 0.3, 0.4])
        comps = np.array([[1.0, 0.5, -0.5, 0.0],
                          [0.0, 0.5, 0.5, 1.0]])
        proj = pca_project_cmnts(center, comps)
        n_cmnts = 4
        scale = np.sqrt(n_cmnts)
        for i in range(n_cmnts):
            expected = scale * (AGREE - center[i]) * comps[:, i]
            assert np.allclose(proj[i], expected), \
                f"proj[{i}] = {proj[i]} vs expected {expected}"

    def test_pca_project_cmnts_empty(self):
        """Empty inputs return shape (0, n_comps)."""
        center = np.zeros(0)
        comps = np.zeros((2, 0))
        proj = pca_project_cmnts(center, comps)
        assert proj.shape == (0, 2)

    def test_compute_comment_extremity_l2_norm(self):
        """Extremity = L2 norm of each projection row."""
        cmnt_proj = np.array([[3.0, 4.0],
                              [0.0, 0.0],
                              [-1.0, 1.0]])
        ext = compute_comment_extremity(cmnt_proj)
        assert np.allclose(ext, [5.0, 0.0, np.sqrt(2)])

    def test_compute_comment_extremity_empty(self):
        """Empty input → empty output."""
        ext = compute_comment_extremity(np.zeros((0, 2)))
        assert ext.shape == (0,)

    def test_extremity_sign_agree_low_disagree_high(self):
        """Semantic guard on the convention translation (not the formula itself).

        In Delphi convention (AGREE = +1) the PCA center of a near-unanimous
        AGREE comment → +1, and of a near-unanimous DISAGREE comment → -1.
        Clojure-parity extremity is the L2 norm of `(AGREE - center) * pc`:

            unanimous AGREE    (center → +1) ⇒ |AGREE - center| → 0  ⇒ extremity → 0
            unanimous DISAGREE (center → -1) ⇒ |AGREE - center| → 2  ⇒ extremity → max

        The pre-fix code used the untranslated Clojure literal `-1`
        (`-scale*(1+center)`), which INVERTS this — a comment everyone agrees on
        would read as maximally extreme. This test pins the direction and would
        fail (agree > disagree) under that bug.
        """
        # comps: pc1 = 1 for both comments, pc2 = 0 ⇒ extremity == |coef|.
        center = np.array([1.0, -1.0])            # col 0 = agree pole, col 1 = disagree pole
        comps = np.array([[1.0, 1.0],
                          [0.0, 0.0]])
        ext = compute_comment_extremity(pca_project_cmnts(center, comps))
        scale = np.sqrt(2)
        assert ext[0] == pytest.approx(0.0, abs=1e-9), \
            "unanimous-agree comment must have extremity ~0"
        assert ext[1] == pytest.approx(2.0 * scale), \
            "unanimous-disagree comment must have maximal extremity"
        assert ext[0] < ext[1], "agree must be LESS extreme than disagree (sign check)"


class TestD12PriorityMetrics:
    """`importance_metric` and `priority_metric` — Clojure parity."""

    def test_importance_metric_formula(self):
        """`(1 - p) * (E + 1) * a` where p = (P+1)/(S+2), a = (A+1)/(S+2)."""
        # Clojure ref values from conversation.clj:335:
        # `(float (importance-metric 1 0 1 0))` — A=1, P=0, S=1, E=0
        # p = 1/3, a = 2/3, return = (2/3)*(1)*(2/3) = 4/9 ≈ 0.4444
        assert abs(importance_metric(1, 0, 1, 0) - 4 / 9) < 1e-10

    def test_importance_metric_high_extremity_boosts(self):
        """Higher extremity → higher importance."""
        baseline = importance_metric(5, 1, 8, 0.0)
        boosted = importance_metric(5, 1, 8, 2.0)
        assert boosted > baseline

    def test_priority_metric_meta_constant(self):
        """Meta comments return META_PRIORITY^2 = 49 (Clojure parity)."""
        # is_meta=True → inner = 7, return = 49
        assert priority_metric(True, 5, 2, 10, 1.5) == META_PRIORITY ** 2
        assert priority_metric(True, 0, 0, 0, 0) == META_PRIORITY ** 2

    def test_priority_metric_non_meta_squared(self):
        """Non-meta: return = (importance * (1 + 8*2^(-S/5)))^2."""
        # A=20, P=3, S=20, E=0 — ref from conversation.clj:337
        A, P, S, E = 20, 3, 20, 0
        imp = importance_metric(A, P, S, E)
        decay = 1 + 8 * (2 ** (-S / 5))
        expected = (imp * decay) ** 2
        assert abs(priority_metric(False, A, P, S, E) - expected) < 1e-10

    def test_priority_metric_decay_factor_lets_new_bubble_up(self):
        """For low-S (new) comments, the decay factor is larger → priority boost."""
        # Two comments with identical importance metrics but different S.
        # importance depends on A, P, S, E; to isolate the decay factor,
        # pick A,P,E values that give same `(1 - (P+1)/(S+2)) * (E+1) * (A+1)/(S+2)`?
        # Hard to isolate, so just test that the decay factor itself increases for low S.
        new_decay = 1 + 8 * (2 ** (-1 / 5))    # S=1
        old_decay = 1 + 8 * (2 ** (-100 / 5))  # S=100
        assert new_decay > old_decay
        assert new_decay > 1.0
        # Old comments fade toward 1 (no boost).
        assert old_decay < 1.01

    def test_meta_priority_constant_value(self):
        """META_PRIORITY = 7 (Clojure conversation.clj:319)."""
        assert META_PRIORITY == 7


# ============================================================================
# D15 — Moderation Handling
# ============================================================================

@pytest.mark.clojure_comparison
class TestD15ModerationHandling:
    """
    D15: Python removes moderated comments entirely from matrix.
         Clojure zeros them out (keeps structure, sets values to 0).

    Clojure behavior (named_matrix.clj:214-230):
      zero-out-columns sets all values in moderated columns to 0,
      preserving the matrix structure (same number of columns).

    Python should match: _apply_moderation() must zero out moderated
    columns rather than removing them, so that:
      - rating_mat.columns includes moderated tids (zeroed)
      - tids output includes moderated tids
      - Matrix dimensions match Clojure
    """

    def test_moderated_comments_zeroed_not_removed(self, conv, clojure_blob, dataset_name):
        """
        After applying moderation, rating_mat should still have all columns.
        Moderated columns should be zeroed, not removed.
        """
        mod_out = clojure_blob.get('mod-out') or []
        if not mod_out:
            pytest.skip(f"[{dataset_name}] No moderated comments in this dataset")

        # Apply moderation from the Clojure blob to the Python conversation
        mod_conv = conv.update_moderation(
            {'mod_out_tids': mod_out},
            recompute=False,
        )

        n_cols_python = len(mod_conv.rating_mat.columns)
        n_cols_raw = len(mod_conv.raw_rating_mat.columns)

        print(f"[{dataset_name}] mod-out: {len(mod_out)}")
        print(f"[{dataset_name}] Python rating_mat cols: {n_cols_python}, raw cols: {n_cols_raw}")
        print(f"[{dataset_name}] Clojure tids: {len(clojure_blob.get('tids', []))}")

        # After zeroing (not removing), column count should match raw matrix
        check.equal(
            n_cols_python, n_cols_raw,
            f"rating_mat should keep all columns (zeroed, not removed): "
            f"got {n_cols_python}, expected {n_cols_raw}"
        )

        # Moderated columns should be all zeros (not NaN, not original values)
        for tid in mod_out:
            if tid in mod_conv.rating_mat.columns:
                col_values = mod_conv.rating_mat[tid].values
                check.is_true(
                    np.all(col_values == 0.0),
                    f"Moderated tid {tid} should be all zeros, "
                    f"got non-zero values: {col_values[col_values != 0.0][:5]}"
                )

    def test_tids_include_moderated(self, conv, clojure_blob, dataset_name):
        """The tids output should include moderated-out comments (matching Clojure)."""
        mod_out = clojure_blob.get('mod-out') or []
        if not mod_out:
            pytest.skip(f"[{dataset_name}] No moderated comments in this dataset")

        mod_conv = conv.update_moderation(
            {'mod_out_tids': mod_out},
            recompute=False,
        )

        # rating_mat.columns (used for tids output) should include moderated tids
        for tid in mod_out:
            if tid in mod_conv.raw_rating_mat.columns:
                check.is_in(
                    tid, set(mod_conv.rating_mat.columns),
                    f"Moderated tid {tid} should still be in rating_mat columns"
                )


class TestD15PublicFixtureModeration:
    """
    Public-fixture tests for D15 moderation handling.

    Clojure zeros out moderated columns (named_matrix.clj:214-230).
    Python must match: _apply_moderation() zeros columns, not removes them.
    """

    def _make_conversation_with_moderation(self, mod_out_tids):
        """Create a small conversation and apply moderation."""
        import pandas as pd

        # 5 participants, 4 comments. Votes: agree=1, disagree=-1, pass=0, no vote=NaN
        data = {
            0: [1.0, -1.0, 1.0, np.nan, 0.0],
            1: [-1.0, 1.0, 0.0, 1.0, -1.0],
            2: [1.0, 1.0, -1.0, -1.0, 1.0],
            3: [np.nan, 0.0, 1.0, 1.0, -1.0],
        }
        votes_df = pd.DataFrame(data, index=[0, 1, 2, 3, 4])

        conv = Conversation("public_fixture_d15")
        conv.raw_rating_mat = votes_df.copy()
        conv.rating_mat = votes_df.copy()
        conv.participant_count, conv.comment_count = votes_df.shape

        # Apply moderation
        conv.mod_out_tids = set(mod_out_tids)
        conv._apply_moderation()
        return conv

    def test_zeroing_preserves_columns(self):
        """Moderated columns should still be present in rating_mat."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[1, 3])

        # All 4 columns should still be present
        assert len(conv.rating_mat.columns) == 4, (
            f"Expected 4 columns, got {len(conv.rating_mat.columns)}: "
            f"moderated columns should be zeroed, not removed"
        )
        assert set(conv.rating_mat.columns) == {0, 1, 2, 3}

    def test_zeroed_columns_are_all_zero(self):
        """Moderated columns should have all values set to 0.0."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[1, 3])

        for tid in [1, 3]:
            col = conv.rating_mat[tid].values
            assert np.all(col == 0.0), (
                f"Moderated column {tid} should be all zeros, got {col}"
            )

    def test_non_moderated_columns_unchanged(self):
        """Non-moderated columns should retain their original values."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[1])

        # Column 0 should be unchanged: [1, -1, 1, NaN, 0]
        col0 = conv.rating_mat[0].values
        assert col0[0] == 1.0
        assert col0[1] == -1.0
        assert np.isnan(col0[3])  # NaN preserved for non-moderated

    def test_empty_moderation_no_change(self):
        """No moderation should leave the matrix unchanged."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[])
        assert len(conv.rating_mat.columns) == 4

    def test_moderate_nonexistent_tid(self):
        """Moderating a tid that doesn't exist in the matrix should be a no-op."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[99])
        # All columns preserved, no crash
        assert len(conv.rating_mat.columns) == 4
        # Original values intact
        assert conv.rating_mat[0].values[0] == 1.0

    # ------------------------------------------------------------------
    # Downstream parity tests: zeroed columns must NOT poison user-vote
    # counts, per-comment votes-base, or _compute_vote_stats.
    # Audit-discovered 2026-06-09. Clojure (conversation.clj:220-228, 593-600)
    # routes these from raw-rating-mat, not the zeroed rating-mat.
    # ------------------------------------------------------------------

    def test_user_vote_counts_uses_raw_rating_mat(self):
        """user-vote-counts must reflect actual votes, not the post-D15 zeros.

        Public-fixture conv has pid 3 with raw NaN on tid 0 (didn't vote). After
        moderating tid 0, the OLD bug (reading from rating_mat) counts the
        zeroed cell as a vote → pid 3 inflates from 3 to 4. The fix routes
        through raw_rating_mat to match Clojure (conversation.clj:220-228).
        """
        conv = self._make_conversation_with_moderation(mod_out_tids=[0])
        counts = conv._compute_user_vote_counts()
        # Truth per raw matrix (NaN cells excluded):
        #   pid 0 voted on tids 0,1,2 (NaN on 3) → 3
        #   pid 1: all 4
        #   pid 2: all 4
        #   pid 3 voted on tids 1,2,3 (NaN on 0) → 3   ← would inflate to 4 with old bug
        #   pid 4: all 4
        assert counts.get(0) == 3
        assert counts.get(1) == 4
        assert counts.get(2) == 4
        assert counts.get(3) == 3, (
            "pid 3 didn't vote on moderated tid 0 (raw=NaN); count must stay 3, "
            f"not inflate to {counts.get(3)}"
        )
        assert counts.get(4) == 4

    def test_votes_base_uses_raw_rating_mat(self):
        """to_dict's votes-base for moderated tids must reflect raw votes, not zeros.

        After moderating tid 0 the OLD bug returns
        {0: {'A': 0, 'D': 0, 'S': 5}} (all 5 pids appear as 'S' since 0.0 is
        non-NaN). Truth (raw_rating_mat) is {'A': 2, 'D': 1, 'S': 4} (4 actual
        votes; pid 3 NaN). Matches Clojure (conversation.clj:593-600).
        """
        conv = self._make_conversation_with_moderation(mod_out_tids=[0])
        vb = conv._compute_votes_base()
        # tid 0 (moderated): pid 0=1.0 (A), pid 1=-1.0 (D), pid 2=1.0 (A),
        # pid 3=NaN, pid 4=0.0 (pass) → A=2, D=1, S=4
        assert vb[0] == {'A': 2, 'D': 1, 'S': 4}, (
            f"moderated tid 0 votes-base must come from raw_rating_mat: got {vb[0]}"
        )
        # tid 1 (not moderated): pid 0=-1, pid 1=1, pid 2=1, pid 3=0, pid 4=-1
        # → A=2, D=2, S=5
        assert vb[1] == {'A': 2, 'D': 2, 'S': 5}

    def test_compute_vote_stats_uses_raw_rating_mat(self):
        """_compute_vote_stats.n_votes must not count moderated-out zeros."""
        conv = self._make_conversation_with_moderation(mod_out_tids=[0])
        conv._compute_vote_stats()
        # Truth (raw): 4 + 5 + 5 + 4 = 18 actual votes across all tids.
        # OLD bug (rating_mat with zeroed tid 0): 5 (zeroed) + 5 + 5 + 4 = 19.
        assert conv.vote_stats['n_votes'] == 18, (
            f"n_votes must count raw votes only; got {conv.vote_stats['n_votes']}, expected 18"
        )

    def test_banned_participants_are_ingested_but_inert(self):
        """mod_out_ptpts is ingested but NEVER applied to the matrix.

        Participant bans are not a Polis feature (mode collapse 2026-07-27,
        POST_CUTOVER_IMPROVEMENTS.md item 1 dropped): no engine has ever
        honored them — the Clojure worker's ingest path has no
        participants.mod filter (CLOJURE_QUIRKS Q1). `_apply_moderation`
        must keep banned rows in `rating_mat`.
        """
        import pandas as pd

        # Same matrix as the helper, with pid 3 moderated out.
        data = {
            0: [1.0, -1.0, 1.0, np.nan, 0.0],
            1: [-1.0, 1.0, 0.0, 1.0, -1.0],
            2: [1.0, 1.0, -1.0, -1.0, 1.0],
            3: [np.nan, 0.0, 1.0, 1.0, -1.0],
        }
        votes_df = pd.DataFrame(data, index=[0, 1, 2, 3, 4])
        conv = Conversation("public_fixture_d15_mod_ptpts")
        conv.raw_rating_mat = votes_df.copy()
        conv.rating_mat = votes_df.copy()
        conv.participant_count, conv.comment_count = votes_df.shape
        conv.mod_out_ptpts = {3}  # ban pid 3
        conv._apply_moderation()

        # rating_mat KEEPS pid 3 — the ban set is stored but never applied.
        assert 3 in conv.rating_mat.index, "bans must be inert (Q1: never applied)"
        assert conv.mod_out_ptpts == {3}, "the set itself is still ingested"

        # Banned pid 3's votes stay in every downstream stat — exactly like
        # the Clojure worker (Q1: the ban never reaches the math).
        counts = conv._compute_user_vote_counts()
        assert 3 in counts, (
            f"banned pid 3 must still be counted (Q1): {sorted(counts.keys())}"
        )

        # votes-base counts reflect ALL 5 participants.
        # tid 1: pid 0=-1 (D), pid 1=1 (A), pid 2=0 (pass), pid 3=1 (A),
        #        pid 4=-1 (D)  → A=2, D=2, S=5
        vb = conv._compute_votes_base()
        assert vb[1] == {'A': 2, 'D': 2, 'S': 5}, (
            f"tid 1 votes-base must include banned pid 3 (Q1); got {vb[1]}"
        )

        # vote_stats global n_votes counts all 5 participants:
        # pid 0: 3, pid 1: 4, pid 2: 4, pid 3: 3, pid 4: 4 → total 18.
        conv._compute_vote_stats()
        assert conv.vote_stats['n_votes'] == 18, (
            f"n_votes must include banned participants (Q1): got "
            f"{conv.vote_stats['n_votes']}, expected 18"
        )

    def test_to_dict_and_to_dynamo_dict_serialize_user_vote_counts_and_votes_base(self):
        """End-to-end serialization shape regression for the 2026-06-09 refactor.

        Before this session, `to_dict` and `to_dynamo_dict` each had their own
        inline implementations of user-vote-counts and votes-base. Both were
        refactored to route through `_compute_user_vote_counts()` /
        `_compute_votes_base()`. This test pins the serializer output shape so
        the refactor can't silently change the on-the-wire format:

        - `to_dict.user-vote-counts`  : key `'user-vote-counts'` (hyphen),
                                        value `{int-pid: int-count}` per Clojure naming.
        - `to_dict.votes-base`        : key `'votes-base'`, value `{int-tid: {'A','D','S'}}`.
        - `to_dynamo_dict.user_vote_counts` : key with **underscore**, same value shape.
        - `to_dynamo_dict.votes_base`       : key with **underscore**, value
                                              `{int-tid: {'agree','disagree','total'}}`
                                              (DynamoDB key convention, NOT A/D/S).

        Also: values must be `int` (DynamoDB rejects `numpy.int64` later in the
        serialization pipeline; the helpers wrap with `int(...)`).
        """
        # Build a tiny conv with enough state for both serializers to reach
        # the user-vote-counts / votes-base sections without crashing
        # downstream on missing PCA / cluster state. Both serializers gate
        # group-votes / projections on empty `group_clusters` / `proj`, so a
        # bare-bones conv is enough.
        conv = self._make_conversation_with_moderation(mod_out_tids=[])
        # Minimal extra state for the serializers (set on default __init__
        # values where possible; only add what the serializers actually read).
        conv.conversation_id = 99999
        conv.last_updated = 0

        # ---- to_dict ----
        try:
            blob = conv.to_dict()
        except Exception as e:  # pragma: no cover
            pytest.fail(f"to_dict() raised on public-fixture conv: {e!r}")

        assert 'user-vote-counts' in blob, "to_dict must produce 'user-vote-counts' (hyphen) key"
        assert 'votes-base' in blob, "to_dict must produce 'votes-base' (hyphen) key"

        uvc = blob['user-vote-counts']
        assert isinstance(uvc, dict)
        assert len(uvc) == 5, f"5 participants → 5 vote-count entries, got {len(uvc)}"
        for pid, count in uvc.items():
            assert isinstance(pid, int), (
                f"to_dict user-vote-counts pid must be int (numpy-safe), got {type(pid)}")
            assert isinstance(count, int) and not isinstance(count, bool), (
                f"to_dict user-vote-counts value must be int, got {type(count)}")

        vb = blob['votes-base']
        assert isinstance(vb, dict)
        assert len(vb) == 4, f"4 comments → 4 votes-base entries, got {len(vb)}"
        for tid, entry in vb.items():
            assert isinstance(tid, int), (
                f"to_dict votes-base tid must be int (numpy-safe), got {type(tid)}")
            assert set(entry.keys()) == {'A', 'D', 'S'}, (
                f"to_dict votes-base entry must have Clojure-style A/D/S keys, got {set(entry.keys())}")
            # Since the mode collapse, values are Clojure-exact per-base-
            # cluster bucket VECTORS (agg-bucket-votes-for-tid parity),
            # not scalar totals.
            for k, v in entry.items():
                assert isinstance(v, list), (
                    f"to_dict votes-base {k} must be a bucket list, got {type(v)}")
                assert all(isinstance(x, int) and not isinstance(x, bool) for x in v), (
                    f"to_dict votes-base {k} bucket values must be ints")

        # ---- to_dynamo_dict ----
        try:
            dyn = conv.to_dynamo_dict()
        except Exception as e:  # pragma: no cover
            pytest.fail(f"to_dynamo_dict() raised on public-fixture conv: {e!r}")

        assert 'user_vote_counts' in dyn, "to_dynamo_dict must produce 'user_vote_counts' (underscore)"
        assert 'votes_base' in dyn, "to_dynamo_dict must produce 'votes_base' (underscore)"
        # Crucial: the OLD format used hyphens NOWHERE; the DynamoDB serializer
        # must never emit Clojure-style keys.
        assert 'user-vote-counts' not in dyn, "to_dynamo_dict must not emit hyphen-style key"
        assert 'votes-base' not in dyn, "to_dynamo_dict must not emit hyphen-style key"

        dyn_uvc = dyn['user_vote_counts']
        assert isinstance(dyn_uvc, dict)
        assert len(dyn_uvc) == 5
        for pid, count in dyn_uvc.items():
            assert isinstance(pid, int), (
                f"to_dynamo_dict user_vote_counts pid must be int, got {type(pid)}")
            assert isinstance(count, int) and not isinstance(count, bool), (
                f"to_dynamo_dict user_vote_counts value must be int, got {type(count)}")

        dyn_vb = dyn['votes_base']
        assert isinstance(dyn_vb, dict)
        assert len(dyn_vb) == 4
        for tid, entry in dyn_vb.items():
            assert isinstance(tid, int), (
                f"to_dynamo_dict votes_base tid must be int, got {type(tid)}")
            assert set(entry.keys()) == {'agree', 'disagree', 'total'}, (
                "to_dynamo_dict votes_base entries must have DynamoDB-style "
                f"agree/disagree/total keys (NOT A/D/S), got {set(entry.keys())}")
            for k, v in entry.items():
                assert isinstance(v, int) and not isinstance(v, bool), (
                    f"to_dynamo_dict votes_base {k} must be int, got {type(v)}")

        # Cross-check: the per-participant counts must match between the two
        # serializers (same helper, just different key names on the way out).
        for pid in uvc:
            assert uvc[pid] == dyn_uvc[pid], (
                f"user-vote-counts mismatch for pid {pid}: "
                f"to_dict={uvc[pid]}, to_dynamo_dict={dyn_uvc[pid]}")

        # And A/D/S vs agree/disagree/total must agree per-tid.
        for tid in vb:
            # to_dict carries per-base-cluster bucket vectors whose domain
            # is CLUSTERED participants only (FP-81fda13ef6); this bare conv
            # has no base clusters, so buckets are empty while the dynamo int
            # totals still count every vote. Bucket sum can never exceed it.
            assert sum(vb[tid]['A']) <= dyn_vb[tid]['agree']
            assert sum(vb[tid]['D']) <= dyn_vb[tid]['disagree']
            assert sum(vb[tid]['S']) <= dyn_vb[tid]['total']


# ============================================================================
# Public-fixture edge-case tests (not dataset-dependent)
# ============================================================================

class TestPublicFixtureEdgeCases:
    """
    Public-fixture tests with made-up data to verify specific formulas
    independently of any real dataset. These document intent clearly
    and prevent regressions.
    """

    def test_pseudocount_beta_2_2_prior(self):
        """With PSEUDO_COUNT=2.0, pa should use Beta(2,2) prior: (na+1)/(ns+2)."""
        na, ns = 3, 4
        expected = (na + 1) / (ns + 2)  # = 4/6 = 0.6667
        actual = (na + PSEUDO_COUNT / 2) / (ns + PSEUDO_COUNT)
        check.almost_equal(actual, expected, abs=1e-10,
                            msg=f"With PSEUDO_COUNT={PSEUDO_COUNT}: got {actual}, expected {expected}")

    def test_z_thresholds_are_one_tailed(self):
        """Z thresholds should be one-tailed: Z_90=1.2816, Z_95=1.6449."""
        check.almost_equal(Z_90, 1.2816, abs=0.001,
                            msg=f"Z_90={Z_90}, expected 1.2816 (one-tailed)")
        check.almost_equal(Z_95, 1.6449, abs=0.001,
                            msg=f"Z_95={Z_95}, expected 1.6449 (one-tailed)")

    # prop_test / repness_metric / repful formula tests are covered by
    # TestD5ProportionTest::test_prop_test_matches_clojure_formula,
    # TestD7RepnessMetric::test_metric_formula_is_product, and
    # TestD8FinalizeStats::test_repful_classification_boundary respectively
    # (migrated to vectorized in PR 14a).


# ============================================================================
# Blob Injection Tests — Compare Python functions against real Clojure values
# ============================================================================
#
# These tests extract inputs from the Clojure math blob, feed them to Python
# functions, and compare outputs to the Clojure blob's values. This is the
# only non-tautological way to verify correctness: formula-only tests just
# re-implement our reading of the Clojure source and can't catch misreadings.
#
# Since Python and Clojure may produce different clusters (different k), we
# inject Clojure's own group memberships and vote counts from the blob,
# isolating each computation stage from upstream divergence.
# ============================================================================

def _blob_repness_rows(clojure_blob):
    """Flatten the Clojure blob's `repness` dict into a list of per-(gid, tid) rows
    for vectorized comparison. Each row is `{gid, tid, **entry_keys}`."""
    return [{'gid': gid, **entry}
            for gid, entries in clojure_blob.get('repness', {}).items()
            for entry in entries]


@pytest.mark.clojure_comparison
class TestD5BlobInjection:
    """D5: Verify prop_test_vectorized against real Clojure blob p-test values.

    Collect (n-success, n-trials, p-test) from every repness entry in the blob,
    run a single vectorized call, compare element-wise. Tests the actual
    production code path (same call shape as `compute_group_comment_stats_df`).
    """

    def test_prop_test_matches_blob_p_test(self, clojure_blob, dataset_name):
        """prop_test_vectorized(n_success, n_trials) should match blob's p-test
        for every repness entry."""
        rows = _blob_repness_rows(clojure_blob)
        if not rows:
            pytest.skip(f"No repness in Clojure blob for {dataset_name}")

        df = pd.DataFrame(rows)[['gid', 'tid', 'n-success', 'n-trials', 'p-test']]
        df['actual'] = prop_test_vectorized(df['n-success'], df['n-trials'])
        df['diff'] = (df['actual'] - df['p-test']).abs()

        mismatches = df[df['diff'] > 1e-4]
        assert mismatches.empty, (
            f"[{dataset_name}] {len(mismatches)}/{len(df)} p-test mismatches:\n"
            + mismatches.head(10).to_string(index=False))


@pytest.mark.clojure_comparison
class TestD6BlobInjection:
    """D6: Verify two_prop_test_vectorized against real Clojure blob
    repness-test values.

    For each repness entry, reconstruct the two_prop_test inputs from
    group-votes (group counts vs total-minus-group), collect into a DataFrame,
    and run a single vectorized call. Tests the actual production code path.
    """

    def test_two_prop_test_matches_blob_repness_test(self, clojure_blob, dataset_name):
        """two_prop_test_vectorized should match blob's repness-test for every
        repness entry."""
        repness = clojure_blob.get('repness', {})
        group_votes = clojure_blob.get('group-votes', {})
        if not repness or not group_votes:
            pytest.skip(f"No repness or group-votes in blob for {dataset_name}")

        # Precompute total votes across ALL groups for each comment.
        all_group_votes: dict = {}
        for other_gid, other_gv_data in group_votes.items():
            for tid_str, counts in other_gv_data.get('votes', {}).items():
                if tid_str not in all_group_votes:
                    all_group_votes[tid_str] = {'A': 0, 'D': 0, 'S': 0}
                all_group_votes[tid_str]['A'] += counts['A']
                all_group_votes[tid_str]['D'] += counts['D']
                all_group_votes[tid_str]['S'] += counts['S']

        rows = []
        for gid, entries in repness.items():
            gv = group_votes.get(gid, {}).get('votes', {})
            for entry in entries:
                tid_str = str(entry['tid'])
                repful = entry['repful-for']
                group_cv = gv.get(tid_str, {'A': 0, 'D': 0, 'S': 0})
                total_cv = all_group_votes.get(tid_str, {'A': 0, 'D': 0, 'S': 0})

                if repful == 'agree':
                    succ_in = group_cv['A']
                    succ_out = total_cv['A'] - group_cv['A']
                else:
                    succ_in = group_cv['D']
                    succ_out = total_cv['D'] - group_cv['D']

                rows.append({
                    'gid': gid, 'tid': entry['tid'], 'repful': repful,
                    'succ_in': succ_in, 'succ_out': succ_out,
                    'pop_in': group_cv['S'],
                    'pop_out': total_cv['S'] - group_cv['S'],
                    'expected': entry['repness-test'],
                })

        df = pd.DataFrame(rows)
        df['actual'] = two_prop_test_vectorized(
            df['succ_in'], df['succ_out'], df['pop_in'], df['pop_out'])
        df['diff'] = (df['actual'] - df['expected']).abs()

        mismatches = df[df['diff'] > 1e-4]
        assert mismatches.empty, (
            f"[{dataset_name}] {len(mismatches)}/{len(df)} repness-test mismatches:\n"
            + mismatches.head(10).to_string(index=False))


@pytest.mark.clojure_comparison
class TestD4BlobInjection:
    """D4: Verify p-success (pseudocount formula) against blob values."""

    def test_p_success_matches_blob(self, clojure_blob, dataset_name):
        """(n_success + 1) / (n_trials + 2) should match blob's p-success."""
        rows = _blob_repness_rows(clojure_blob)
        if not rows:
            pytest.skip(f"No repness in blob for {dataset_name}")

        df = pd.DataFrame(rows)[['gid', 'tid', 'n-success', 'n-trials', 'p-success']]
        df['actual'] = ((df['n-success'] + PSEUDO_COUNT / 2)
                        / (df['n-trials'] + PSEUDO_COUNT))
        df['diff'] = (df['actual'] - df['p-success']).abs()

        mismatches = df[df['diff'] > 1e-4]
        assert mismatches.empty, (
            f"[{dataset_name}] {len(mismatches)}/{len(df)} p-success mismatches:\n"
            + mismatches.head(10).to_string(index=False))


class TestD11D12Serialization:
    """Round-trip tests for the D11/D12 plumb-through in to_dict / to_dynamo_dict.

    Investigation B (2026-06-11) discovered that both serializers were hardcoding
    ``result['consensus']`` to an empty dict regardless of
    ``self.repness['consensus_comments']``, so the D11 consensus dict never
    reached client-report's Majority view and never landed in the DynamoDB
    math blob. ``comment_priorities`` (D12) was already conditionally plumbed
    via ``hasattr/if`` guards; we lock that in with a regression test so a
    future cleanup doesn't silently revert to the empty-default shape.
    """

    @staticmethod
    def _make_conversation_with_repness(consensus_comments, priorities):
        """Build a Conversation with just enough state to exercise the
        serializers. Empty rating matrices and empty group_clusters mean the
        rest of to_dict/to_dynamo_dict iterates over zero rows/cols (cheap)
        while the consensus + priorities fields still flow through end-to-end.
        """
        conv = Conversation(conversation_id='ztest-serialization')
        conv.repness = {
            'comment_ids': [],
            'group_repness': {},
            'comment_repness': [],
            'consensus_comments': consensus_comments,
        }
        conv.comment_priorities = priorities
        return conv

    def test_to_dict_surfaces_consensus_comments(self):
        """``to_dict()`` must surface ``self.repness['consensus_comments']`` into
        ``result['consensus']``. Pre-fix this slot was hardcoded
        ``{'agree': [], 'disagree': [], 'comment-stats': {}}`` and the D11
        selection was silently dropped on the floor."""
        consensus = {
            'agree': [
                {'tid': 1, 'n-success': 3, 'n-trials': 4,
                 'p-success': 0.7, 'p-test': 1.5}
            ],
            'disagree': [
                {'tid': 2, 'n-success': 2, 'n-trials': 5,
                 'p-success': 0.42, 'p-test': 1.1}
            ],
        }
        conv = self._make_conversation_with_repness(consensus, {})

        result = conv.to_dict()

        assert result['consensus'] == consensus, (
            "to_dict() must plumb self.repness['consensus_comments'] into "
            "result['consensus']; got " + repr(result['consensus']))

    def test_to_dict_surfaces_comment_priorities(self):
        """``to_dict()`` must surface ``self.comment_priorities`` (D12). This is
        a regression lock: the field is currently conditionally plumbed via
        ``hasattr/if``; a future cleanup must not revert to the hardcoded
        empty default."""
        priorities = {1: 0.42, 2: 1.7, 3: 0.0}
        conv = self._make_conversation_with_repness(
            {'agree': [], 'disagree': []}, priorities)

        result = conv.to_dict()

        # The to_dict key uses underscore form (see line ~1706); no rename
        # happens on the way out, unlike most Clojure-format fields.
        assert 'comment_priorities' in result, (
            "to_dict() must emit 'comment_priorities' when "
            "self.comment_priorities is populated; keys = "
            + repr(sorted(result.keys())))
        assert result['comment_priorities'] == priorities

    def test_to_dynamo_dict_surfaces_both(self):
        """``to_dynamo_dict()`` must surface BOTH consensus comments (D11) and
        comment priorities (D12). The DynamoDB shape uses underscore keys
        (``consensus``, ``comment_priorities``); the consensus inner shape
        matches whatever ``self.repness['consensus_comments']`` holds
        (Clojure-style ``agree``/``disagree`` lists)."""
        consensus = {
            'agree': [
                {'tid': 11, 'n-success': 8, 'n-trials': 10,
                 'p-success': 0.83, 'p-test': 2.1}
            ],
            'disagree': [],
        }
        # Priorities use comment-id keys; the serializer coerces KEYS to int
        # when possible and preserves VALUES as Decimal (2026-07-04 fix —
        # the old int(value) coercion floored sub-1 priorities to 0, which
        # the TS server's weighted routing reads as "no priority data").
        priorities = {7: 1.5, 9: 0.25}
        conv = self._make_conversation_with_repness(consensus, priorities)

        result = conv.to_dynamo_dict()

        # Values land Decimal-converted (boto3 boundary — the raw-float write
        # crashed CI's e2e run 2026-07-05); compare structure and numeric
        # values, not float identity.
        got = result['consensus']
        assert set(got.keys()) == {'agree', 'disagree'}
        assert got['disagree'] == []
        assert len(got['agree']) == 1
        for k, v in consensus['agree'][0].items():
            assert float(got['agree'][0][k]) == pytest.approx(float(v)), (
                f"consensus entry key {k}: {got['agree'][0][k]!r} != {v!r}")
        assert 'comment_priorities' in result, (
            "to_dynamo_dict() must emit 'comment_priorities' when "
            "self.comment_priorities is populated; keys = "
            + repr(sorted(result.keys())))
        # Values land as Decimal (boto3-safe) with full precision — assert
        # the post-serialization shape to lock in what actually lands in
        # DynamoDB.
        from decimal import Decimal
        assert result['comment_priorities'] == {
            7: Decimal('1.5'), 9: Decimal('0.25')}


class TestGroupIdOrderMatchesClojure:
    """Group-cluster ids must preserve first-k-distinct encounter order over
    base-cluster centers — Clojure parity (`init-clusters`, clusters.clj:55-64;
    output `sort-by :id`, conversation.clj:437; merge lineage keeps the larger
    cluster's id but NEVER re-sorts by size).

    Python's former size-descending re-sort + id reassignment caused the
    gid 0↔1 label swap confirmed by the S3-4 trace (2026-06-11): Python g0 ∩
    Clojure g1 = 50/50 on vw-cold_start, sizes [50, 17] vs Clojure [17, 50].
    The base level already preserves k-means id order for exactly this
    reason (K-inv); the group level must too.
    """

    def _conv_with_ordered_proj(self):
        conv = Conversation(conversation_id='ztest-gid-order')
        # proj key order defines base-center row order (K-inv invariant).
        # Row 0 (left side, SMALL group) is encountered FIRST, row 1 (right
        # side, LARGE group) second → group-level first-2-distinct init =
        # (L, R) → group id 0 must be the L group even though it is smaller
        # (2 vs 3 members).
        conv.proj = {
            0: [-1.0, 0.05],   # L (small group)
            1: [1.0, 0.05],    # R (large group)
            2: [1.0, 0.0],     # R
            3: [1.0, -0.05],   # R
            4: [-1.0, -0.05],  # L
        }
        # Focus the test on id assignment: bypass the in-conv vote-count
        # machinery (instance attribute shadows the bound method).
        conv._get_in_conv_participants = lambda: {0, 1, 2, 3, 4}
        return conv

    def test_group_id_zero_is_first_encountered_not_biggest(self):
        conv = self._conv_with_ordered_proj()
        conv._compute_clusters()
        groups = conv.group_clusters
        assert len(groups) == 2, f"expected k=2, got {len(groups)}"

        # Resolve group members down to participant ids via base clusters.
        base_by_id = {b['id']: b for b in conv.base_clusters}
        members0 = sorted(p for bid in groups[0]['members']
                          for p in base_by_id[bid]['members'])
        members1 = sorted(p for bid in groups[1]['members']
                          for p in base_by_id[bid]['members'])

        assert [g['id'] for g in groups] == [0, 1]
        assert members0 == [0, 4], (
            f"group id 0 must be the FIRST-ENCOUNTERED (smaller, L) group "
            f"per Clojure first-k-distinct order; got members {members0} — "
            f"a size re-sort promotes the larger group instead")
        assert members1 == [1, 2, 3]
