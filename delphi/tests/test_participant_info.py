"""
Unit tests for _compute_participant_info_optimized.

Written BEFORE vectorization to establish a baseline against the current
per-participant loop implementation, then re-run after vectorization to
verify equivalence.
"""

import os
import numpy as np
import pandas as pd
import pytest

from polismath.conversation.conversation import Conversation


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_vote_matrix(data: dict) -> pd.DataFrame:
    """Build a vote matrix DataFrame from {pid: {tid: vote}}.

    Missing entries become NaN (matching real data).
    """
    return pd.DataFrame.from_dict(data, orient="index", dtype=float)


def _make_groups(groups: list[dict]) -> list[dict]:
    """Build group_clusters from [{id, members}].

    Adds a dummy 'center' key (required by the format but unused by
    _compute_participant_info_optimized).
    """
    return [
        {"id": g["id"], "members": g["members"], "center": [0.0]}
        for g in groups
    ]


def _run(vm: pd.DataFrame, groups: list[dict]) -> dict:
    """Call _compute_participant_info_optimized on a fresh Conversation."""
    conv = Conversation("test")
    return conv._compute_participant_info_optimized(vm, _make_groups(groups))


def _stats(result: dict) -> dict:
    """Shortcut to the 'stats' sub-dict."""
    return result.get("stats", {})


# ---------------------------------------------------------------------------
# Basic functionality
# ---------------------------------------------------------------------------

class TestBasicVoteCounts:
    def test_basic_vote_counts(self):
        """Verify agree/disagree/pass/total for a simple participant."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 0, 3: 1, 4: -1},
            1: {0: 1, 1: 1, 2: 1, 3: 1, 4: 1},
            2: {0: -1, 1: -1, 2: -1, 3: -1, 4: -1},
        })
        groups = [{"id": 0, "members": [0, 1, 2]}]
        stats = _stats(_run(vm, groups))

        s = stats[0]
        assert s["n_agree"] == 2
        assert s["n_disagree"] == 2
        assert s["n_pass"] == 1
        assert s["n_votes"] == 4  # agree + disagree

    def test_group_correlation_known_values(self):
        """Group all +1, participant all -1 → group std=0 → corr=0.0."""
        vm = _make_vote_matrix({
            0: {0: -1, 1: -1, 2: -1, 3: -1},
            1: {0: 1, 1: 1, 2: 1, 3: 1},
            2: {0: 1, 1: 1, 2: 1, 3: 1},
            3: {0: 1, 1: 1, 2: 1, 3: 1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        # Group avg is [1,1,1,1], std=0 → corr=0.0
        assert stats[0]["group_correlations"][0] == 0.0

    def test_group_correlation_with_variance(self):
        """Participant matches group pattern → corr close to 1.0."""
        pattern = {0: 1, 1: -1, 2: 1, 3: -1}
        vm = _make_vote_matrix({
            0: pattern,
            1: pattern,
            2: pattern,
            3: pattern,
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert stats[0]["group_correlations"][0] == pytest.approx(1.0, abs=1e-10)

    def test_negative_correlation(self):
        """Participant opposite to group → corr close to -1.0."""
        vm = _make_vote_matrix({
            0: {0: -1, 1: 1, 2: -1, 3: 1},
            1: {0: 1, 1: -1, 2: 1, 3: -1},
            2: {0: 1, 1: -1, 2: 1, 3: -1},
            3: {0: 1, 1: -1, 2: 1, 3: -1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert stats[0]["group_correlations"][0] == pytest.approx(-1.0, abs=1e-10)

    def test_multiple_groups(self):
        """Independent correlations per group."""
        # Group 0: all +1 (uniform → std=0 → corr=0.0)
        # Group 1: matches participant 0's pattern → corr=1.0
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
            1: {0: 1, 1: 1, 2: 1, 3: 1},
            2: {0: 1, 1: 1, 2: 1, 3: 1},
            3: {0: 1, 1: 1, 2: 1, 3: 1},
            4: {0: 1, 1: -1, 2: 1, 3: -1},
            5: {0: 1, 1: -1, 2: 1, 3: -1},
            6: {0: 1, 1: -1, 2: 1, 3: -1},
        })
        groups = [
            {"id": 0, "members": [1, 2, 3]},
            {"id": 1, "members": [4, 5, 6]},
        ]
        stats = _stats(_run(vm, groups))

        assert stats[0]["group_correlations"][0] == 0.0  # uniform group
        assert stats[0]["group_correlations"][1] == pytest.approx(1.0, abs=1e-10)

    def test_group_membership_assignment(self):
        """Verify 'group' field matches group_clusters."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1},
            1: {0: 1, 1: 1, 2: 1},
            2: {0: -1, 1: -1, 2: -1},
            3: {0: 1, 1: -1, 2: -1},
        })
        groups = [
            {"id": 0, "members": [0, 1]},
            {"id": 1, "members": [2, 3]},
        ]
        stats = _stats(_run(vm, groups))

        assert stats[0]["group"] == 0
        assert stats[1]["group"] == 0
        assert stats[2]["group"] == 1
        assert stats[3]["group"] == 1


# ---------------------------------------------------------------------------
# Empty / degenerate inputs
# ---------------------------------------------------------------------------

class TestEmptyDegenerate:
    def test_empty_group_clusters(self):
        """Empty group list → returns {}."""
        vm = _make_vote_matrix({0: {0: 1}})
        result = _run(vm, [])
        # The function returns {} for empty group_clusters (before wrapping)
        # Actually it returns {} directly
        assert result == {}

    def test_empty_vote_matrix(self):
        """0-row DataFrame → empty stats."""
        vm = pd.DataFrame(dtype=float)
        groups = [{"id": 0, "members": [0, 1, 2]}]
        stats = _stats(_run(vm, groups))
        assert stats == {}

    def test_single_column_vote_matrix(self):
        """1 comment → < 3 valid → all corr=0.0."""
        vm = _make_vote_matrix({
            0: {0: 1},
            1: {0: -1},
            2: {0: 1},
            3: {0: -1},
        })
        groups = [{"id": 0, "members": [0, 1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        for pid in stats:
            assert stats[pid]["group_correlations"][0] == 0.0


# ---------------------------------------------------------------------------
# Small groups (< 3 members)
# ---------------------------------------------------------------------------

class TestSmallGroups:
    def test_group_with_two_members(self):
        """2-member group → corr=0.0 for all participants."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
            1: {0: 1, 1: -1, 2: 1, 3: -1},
            2: {0: 1, 1: 1, 2: 1, 3: 1},
        })
        groups = [{"id": 0, "members": [0, 1]}]  # only 2
        stats = _stats(_run(vm, groups))

        for pid in stats:
            assert stats[pid]["group_correlations"][0] == 0.0

    def test_group_with_one_member(self):
        """1-member group → corr=0.0."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
            1: {0: 1, 1: 1, 2: 1, 3: 1},
        })
        groups = [{"id": 0, "members": [0]}]
        stats = _stats(_run(vm, groups))

        for pid in stats:
            assert stats[pid]["group_correlations"][0] == 0.0

    def test_mixed_small_and_large_groups(self):
        """One group computed, one defaults to 0.0."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
            1: {0: 1, 1: -1, 2: 1, 3: -1},
            2: {0: 1, 1: -1, 2: 1, 3: -1},
            3: {0: 1, 1: -1, 2: 1, 3: -1},
            4: {0: -1, 1: 1, 2: -1, 3: 1},
        })
        groups = [
            {"id": 0, "members": [1, 2, 3]},  # 3 members, computed
            {"id": 1, "members": [4]},          # 1 member, defaults to 0.0
        ]
        stats = _stats(_run(vm, groups))

        # Group 0 should have real correlation (participant 0 matches the group)
        assert stats[0]["group_correlations"][0] == pytest.approx(1.0, abs=1e-10)
        # Group 1 should be 0.0 (too small)
        assert stats[0]["group_correlations"][1] == 0.0


# ---------------------------------------------------------------------------
# Zero-vote participants
# ---------------------------------------------------------------------------

class TestZeroVoteParticipants:
    def test_all_pass_votes_skipped(self):
        """All 0 (pass) → excluded from stats."""
        vm = _make_vote_matrix({
            0: {0: 0, 1: 0, 2: 0},
            1: {0: 1, 1: -1, 2: 1},
            2: {0: 1, 1: 1, 2: -1},
            3: {0: -1, 1: 1, 2: 1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert 0 not in stats

    def test_all_nan_votes_skipped(self):
        """All NaN → same as all-pass (nan_to_num → 0), excluded."""
        vm = _make_vote_matrix({
            0: {0: float("nan"), 1: float("nan")},
            1: {0: 1, 1: -1},
            2: {0: 1, 1: 1},
            3: {0: -1, 1: -1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert 0 not in stats

    def test_mix_of_pass_and_real_votes(self):
        """Some passes, some real → included."""
        vm = _make_vote_matrix({
            0: {0: 0, 1: 1, 2: 0, 3: -1},
            1: {0: 1, 1: 1, 2: 1, 3: 1},
            2: {0: -1, 1: -1, 2: -1, 3: -1},
            3: {0: 1, 1: -1, 2: 1, 3: -1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert 0 in stats
        assert stats[0]["n_agree"] == 1
        assert stats[0]["n_disagree"] == 1
        assert stats[0]["n_pass"] == 2
        assert stats[0]["n_votes"] == 2


# ---------------------------------------------------------------------------
# Missing group members
# ---------------------------------------------------------------------------

class TestMissingGroupMembers:
    def test_group_member_not_in_vote_matrix(self):
        """Member ID 99 not in matrix → silently excluded, group may drop below 3."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
            1: {0: 1, 1: -1, 2: 1, 3: -1},
            2: {0: 1, 1: -1, 2: 1, 3: -1},
        })
        # Member 99 is not in the vote matrix; only 2 real members → < 3 → corr=0.0
        groups = [{"id": 0, "members": [1, 2, 99]}]
        stats = _stats(_run(vm, groups))

        for pid in stats:
            assert stats[pid]["group_correlations"][0] == 0.0

    def test_all_group_members_missing(self):
        """All members absent → corr=0.0."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
        })
        groups = [{"id": 0, "members": [10, 20, 30]}]
        stats = _stats(_run(vm, groups))

        for pid in stats:
            assert stats[pid]["group_correlations"][0] == 0.0


# ---------------------------------------------------------------------------
# NaN handling
# ---------------------------------------------------------------------------

class TestNanHandling:
    def test_nan_treated_as_zero(self):
        """NaN converted to 0.0, counted as pass."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: float("nan"), 2: -1},
            1: {0: 1, 1: 1, 2: 1},
            2: {0: -1, 1: -1, 2: -1},
            3: {0: 1, 1: -1, 2: 1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        s = stats[0]
        assert s["n_agree"] == 1
        assert s["n_disagree"] == 1
        assert s["n_pass"] == 1  # NaN → 0 → counted as pass


# ---------------------------------------------------------------------------
# Insufficient valid comments
# ---------------------------------------------------------------------------

class TestInsufficientValidComments:
    def test_fewer_than_three_valid_comments(self):
        """Only 2 comments have >= 3 group votes → corr=0.0."""
        # 3 comments, but the 3rd column has only 1 non-zero group vote
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1},
            1: {0: 1, 1: -1, 2: 0},
            2: {0: -1, 1: 1, 2: 0},
            3: {0: 1, 1: -1, 2: 1},  # only member 3 votes non-zero on col 2
        })
        # Group members: 1, 2, 3
        # Col 0: members 1(1), 2(-1), 3(1) → 3 non-zero → valid
        # Col 1: members 1(-1), 2(1), 3(-1) → 3 non-zero → valid
        # Col 2: members 1(0), 2(0), 3(1) → 1 non-zero → invalid
        # Only 2 valid comments → < 3 → corr=0.0
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert stats[0]["group_correlations"][0] == 0.0

    def test_exactly_three_valid_comments(self):
        """Exactly 3 valid comments → correlation IS computed."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1},
            1: {0: 1, 1: -1, 2: 1},
            2: {0: 1, 1: -1, 2: 1},
            3: {0: 1, 1: -1, 2: 1},
        })
        # All 3 columns have 3 non-zero group votes → all valid
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        # All participants have same pattern → corr should be 1.0
        # (group avg matches participant perfectly)
        assert stats[0]["group_correlations"][0] == pytest.approx(1.0, abs=1e-10)


# ---------------------------------------------------------------------------
# Zero standard deviation
# ---------------------------------------------------------------------------

class TestZeroStd:
    def test_participant_uniform_votes_zero_std(self):
        """Participant all +1 → participant std=0 → corr=0.0."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: 1, 2: 1, 3: 1},
            1: {0: 1, 1: -1, 2: 1, 3: -1},
            2: {0: -1, 1: 1, 2: -1, 3: 1},
            3: {0: 1, 1: 1, 2: -1, 3: -1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        # Participant 0 has all +1 → std=0 → corr=0.0
        assert stats[0]["group_correlations"][0] == 0.0

    def test_group_uniform_avg_zero_std(self):
        """Group members all +1 → group avg std=0 → corr=0.0."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
            1: {0: 1, 1: 1, 2: 1, 3: 1},
            2: {0: 1, 1: 1, 2: 1, 3: 1},
            3: {0: 1, 1: 1, 2: 1, 3: 1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert stats[0]["group_correlations"][0] == 0.0


# ---------------------------------------------------------------------------
# Unassigned participants
# ---------------------------------------------------------------------------

class TestUnassignedParticipants:
    def test_participant_not_in_any_group(self):
        """group=None, correlations still computed for all groups."""
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},  # not in any group
            1: {0: 1, 1: -1, 2: 1, 3: -1},
            2: {0: 1, 1: -1, 2: 1, 3: -1},
            3: {0: 1, 1: -1, 2: 1, 3: -1},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        assert stats[0]["group"] is None
        assert 0 in stats[0]["group_correlations"]


# ---------------------------------------------------------------------------
# Correlation correctness
# ---------------------------------------------------------------------------

class TestCorrelationCorrectness:
    def test_matches_numpy_corrcoef(self):
        """Non-trivial case: compare to np.corrcoef directly."""
        np.random.seed(42)
        n_comments = 10
        n_members = 5
        # Build a group with random votes
        group_votes = {}
        for pid in range(1, n_members + 1):
            group_votes[pid] = {
                tid: int(np.random.choice([-1, 0, 1]))
                for tid in range(n_comments)
            }
        # Participant 0 with random votes
        p0_votes = {tid: int(np.random.choice([-1, 0, 1])) for tid in range(n_comments)}
        all_votes = {0: p0_votes, **group_votes}
        vm = _make_vote_matrix(all_votes)
        groups = [{"id": 0, "members": list(range(1, n_members + 1))}]

        stats = _stats(_run(vm, groups))
        computed_corr = stats[0]["group_correlations"][0]

        # Manually compute expected correlation
        matrix_values = np.nan_to_num(vm.to_numpy(dtype=float), nan=0.0)
        member_indices = list(range(1, n_members + 1))  # pids 1..5
        # Map pids to row indices
        idx_map = {pid: i for i, pid in enumerate(vm.index)}
        member_rows = [idx_map[m] for m in member_indices]
        group_matrix = matrix_values[member_rows, :]
        group_avg = np.mean(group_matrix, axis=0)
        valid_mask = np.sum(group_matrix != 0, axis=0) >= 3

        if np.sum(valid_mask) >= 3:
            p_votes = matrix_values[idx_map[0], valid_mask]
            g_votes = group_avg[valid_mask]
            expected_corr = np.corrcoef(p_votes, g_votes)[0, 1]
            if np.isnan(expected_corr):
                expected_corr = 0.0
        else:
            expected_corr = 0.0

        assert computed_corr == pytest.approx(expected_corr, abs=1e-10)

    def test_partial_overlap_correlation(self):
        """Only valid-mask comments used for correlation."""
        # 5 comments; group votes non-zero on only 3 of them
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: 1, 4: -1},
            1: {0: 1, 1: -1, 2: 1, 3: 0, 4: 0},  # votes on 0,1,2 only
            2: {0: -1, 1: 1, 2: -1, 3: 0, 4: 0},
            3: {0: 1, 1: -1, 2: 1, 3: 0, 4: 0},
        })
        groups = [{"id": 0, "members": [1, 2, 3]}]
        stats = _stats(_run(vm, groups))

        # Manually compute: only cols 0, 1, 2 are valid
        matrix_values = np.nan_to_num(vm.to_numpy(dtype=float), nan=0.0)
        idx_map = {pid: i for i, pid in enumerate(vm.index)}
        group_matrix = matrix_values[[idx_map[1], idx_map[2], idx_map[3]], :]
        group_avg = np.mean(group_matrix, axis=0)
        valid_mask = np.sum(group_matrix != 0, axis=0) >= 3

        p_votes = matrix_values[idx_map[0], valid_mask]
        g_votes = group_avg[valid_mask]

        p_std = np.std(p_votes)
        g_std = np.std(g_votes)
        if p_std > 0 and g_std > 0:
            expected = np.corrcoef(p_votes, g_votes)[0, 1]
        else:
            expected = 0.0

        assert stats[0]["group_correlations"][0] == pytest.approx(expected, abs=1e-10)


# ---------------------------------------------------------------------------
# Result structure
# ---------------------------------------------------------------------------

class TestResultStructure:
    def _make_basic_result(self):
        vm = _make_vote_matrix({
            0: {0: 1, 1: -1, 2: 1, 3: -1},
            1: {0: 1, 1: -1, 2: 1, 3: -1},
            2: {0: 1, 1: -1, 2: 1, 3: -1},
            3: {0: 1, 1: -1, 2: 1, 3: -1},
        })
        groups = [
            {"id": 0, "members": [1, 2, 3]},
            {"id": 1, "members": [0, 1, 2]},
        ]
        return _run(vm, groups), vm, groups

    def test_result_keys(self):
        """Top-level keys present."""
        result, _, _ = self._make_basic_result()
        assert "participant_ids" in result
        assert "stats" in result

    def test_stats_value_types(self):
        """Vote counts are Python int; correlations are float-compatible."""
        result, _, _ = self._make_basic_result()
        for pid, s in result["stats"].items():
            assert type(s["n_agree"]) is int, f"n_agree for {pid} is {type(s['n_agree'])}"
            assert type(s["n_disagree"]) is int
            assert type(s["n_pass"]) is int
            assert type(s["n_votes"]) is int
            for gid, corr in s["group_correlations"].items():
                assert type(corr) is float, (
                    f"corr for pid={pid}, gid={gid} is {type(corr)}"
                )

    def test_all_participants_with_votes_present(self):
        """Every participant with n_votes > 0 is in stats."""
        result, vm, _ = self._make_basic_result()
        stats = result["stats"]
        # All participants have votes in this setup
        for pid in vm.index:
            assert pid in stats

    def test_all_groups_in_correlations(self):
        """Every participant has entries for all group IDs."""
        result, _, groups = self._make_basic_result()
        group_ids = {g["id"] for g in groups}
        for pid, s in result["stats"].items():
            assert set(s["group_correlations"].keys()) == group_ids


# ---------------------------------------------------------------------------
# Vectorization equivalence: compare optimized code to np.corrcoef reference
# ---------------------------------------------------------------------------

@pytest.mark.use_discovered_datasets
def test_vectorized_matches_per_participant_corrcoef(dataset_name):
    """Verify the vectorized correlation matches a per-participant np.corrcoef loop.

    This is the real-data equivalent of test_matches_numpy_corrcoef.  It runs
    both the vectorized implementation and a naive per-participant reference
    (the old scalar loop) on an actual dataset, checking every (participant,
    group) correlation.  No golden snapshot files needed.
    """
    from polismath.regression.utils import prepare_votes_data

    votes_dict, _ = prepare_votes_data(dataset_name)
    conv = Conversation(dataset_name)
    conv = conv.update_votes(votes_dict, recompute=True)
    groups = conv._unfolded_group_clusters()
    if not groups:
        pytest.skip(f"No groups for {dataset_name}")

    # Run the optimized implementation
    result = conv._compute_participant_info_optimized(conv.rating_mat, groups)
    stats = result.get("stats", {})
    if not stats:
        pytest.skip(f"No participant stats for {dataset_name}")

    # Rebuild the same inputs the optimized code uses
    matrix_values = np.nan_to_num(conv.rating_mat.to_numpy(copy=True, dtype=float), nan=0.0)
    ptpt_idx_map = {pid: idx for idx, pid in enumerate(conv.rating_mat.index)}

    group_data = {}  # {group_id: (member_indices, avg_votes, valid_mask)}
    for group in groups:
        gid = group.get("id", 0)
        member_indices = [ptpt_idx_map[m] for m in group.get("members", []) if m in ptpt_idx_map]
        if len(member_indices) >= 3:
            gvm = matrix_values[member_indices, :]
            avg = np.mean(gvm, axis=0)
            mask = np.sum(gvm != 0, axis=0) >= 3
            group_data[gid] = (member_indices, avg, mask)

    # Reference: per-participant np.corrcoef (the old scalar loop)
    mismatches = []
    for pid, s in stats.items():
        p_idx = ptpt_idx_map.get(pid)
        if p_idx is None:
            continue
        p_votes_all = matrix_values[p_idx, :]

        for gid, optimized_corr in s["group_correlations"].items():
            if gid not in group_data:
                ref_corr = 0.0
            else:
                _, avg, mask = group_data[gid]
                n_valid = int(np.sum(mask))
                if n_valid < 3:
                    ref_corr = 0.0
                else:
                    p_v = p_votes_all[mask]
                    g_v = avg[mask]
                    p_std = np.std(p_v)
                    g_std = np.std(g_v)
                    if p_std > 0 and g_std > 0:
                        ref_corr = float(np.corrcoef(p_v, g_v)[0, 1])
                        if np.isnan(ref_corr):
                            ref_corr = 0.0
                    else:
                        ref_corr = 0.0

            if abs(optimized_corr - ref_corr) > 1e-10:
                mismatches.append(
                    f"pid={pid} group={gid}: optimized={optimized_corr:.15g} "
                    f"ref={ref_corr:.15g} diff={abs(optimized_corr - ref_corr):.2e}"
                )

    assert not mismatches, (
        f"{len(mismatches)} correlation mismatches on {dataset_name}:\n"
        + "\n".join(mismatches[:10])
    )


# ---------------------------------------------------------------------------
# Golden snapshot regression (parametrized over discovered datasets)
# ---------------------------------------------------------------------------

_skip_golden = pytest.mark.skipif(
    os.environ.get("SKIP_GOLDEN") == "1",
    reason="Golden snapshot tests disabled (SKIP_GOLDEN=1)",
)


@_skip_golden
@pytest.mark.use_discovered_datasets
def test_participant_info_matches_golden(dataset_name):
    """Run full pipeline, compare participant_info to golden snapshot."""
    from polismath.regression.utils import load_golden_snapshot, prepare_votes_data

    golden, golden_path = load_golden_snapshot(dataset_name)
    if golden is None:
        # Goldens were intentionally removed during stack work (see
        # delphi/scratch/COPILOT_MATH_QUESTIONS.md). They'll be re-recorded
        # once the stack lands and k-means non-determinism is dealt with.
        pytest.skip(f"No golden snapshot at {golden_path} for {dataset_name}")

    golden_pi = golden["stages"]["after_full_recompute"].get("participant_info")
    if golden_pi is None:
        pytest.skip(f"No participant_info in golden snapshot for {dataset_name}")

    # Load votes via the dataset library
    votes_dict, metadata = prepare_votes_data(dataset_name)

    # Run full pipeline
    conv = Conversation(dataset_name)
    conv = conv.update_votes(votes_dict, recompute=True)

    computed_pi = conv.participant_info

    # Compare participant IDs
    golden_pids = set(golden_pi.keys())
    computed_pids = set(str(pid) for pid in computed_pi.keys())
    assert golden_pids == computed_pids, (
        f"Participant ID mismatch: golden has {golden_pids - computed_pids} extra, "
        f"computed has {computed_pids - golden_pids} extra"
    )

    # Compare values
    for pid_str in golden_pids:
        g = golden_pi[pid_str]
        # Find matching pid in computed (could be int or str)
        c = computed_pi.get(int(pid_str), computed_pi.get(pid_str))
        assert c is not None, f"Missing participant {pid_str} in computed"

        assert c["n_agree"] == g["n_agree"], f"pid {pid_str}: n_agree {c['n_agree']} != {g['n_agree']}"
        assert c["n_disagree"] == g["n_disagree"], f"pid {pid_str}: n_disagree"
        assert c["n_pass"] == g["n_pass"], f"pid {pid_str}: n_pass"
        assert c["n_votes"] == g["n_votes"], f"pid {pid_str}: n_votes"

        for gid_str, g_corr in g["group_correlations"].items():
            c_corr = c["group_correlations"].get(int(gid_str), c["group_correlations"].get(gid_str))
            assert c_corr == pytest.approx(g_corr, abs=1e-10), (
                f"pid {pid_str}, group {gid_str}: corr {c_corr} != {g_corr}"
            )
