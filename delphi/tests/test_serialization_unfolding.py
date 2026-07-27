"""
Tests that serialization methods output participant IDs (not base-cluster IDs)
in group-cluster members.

Two-level clustering produces:
  base_clusters:  [{id: 0, members: [pid, pid, ...], center: [x,y]}, ...]
  group_clusters: [{id: 0, members: [bc_id, bc_id, ...], center: [x,y]}, ...]

Internally, group_clusters.members stores base-cluster IDs.  But every
serialization path (to_dict, get_full_data, to_dynamo_dict) must *unfold*
those to participant IDs so downstream consumers (group_data.py, Clojure
compat, client apps) see the right thing.

We feed real votes through recompute() so the full pipeline runs, then assert
the structural invariant: serialized cluster members are participant IDs.
"""

import pytest

from polismath.conversation.conversation import Conversation


# ---------------------------------------------------------------------------
# Fixture: a recomputed Conversation with real two-level clustering
# ---------------------------------------------------------------------------

def _make_votes():
    """20 participants, 10 comments, two polarised opinion groups.
    Enough votes per participant to pass the inclusion threshold."""
    votes = []
    for i in range(20):
        pid = f"p{i}"
        # Group A (p0-p9):  agree c1-c5, disagree c6-c10
        # Group B (p10-p19): disagree c1-c5, agree c6-c10
        sign = 1 if i < 10 else -1
        for j in range(1, 11):
            votes.append({
                "pid": pid,
                "tid": f"c{j}",
                "vote": sign if j <= 5 else -sign,
            })
    return {"votes": votes}


@pytest.fixture(scope="module")
def conv():
    """Recomputed Conversation — built once, shared across all tests."""
    c = Conversation("test_unfolding")
    c = c.update_votes(_make_votes(), recompute=False)
    c = c.recompute()
    # Sanity: two-level clustering actually ran
    assert len(c.base_clusters) > 0, "no base clusters produced"
    assert len(c.group_clusters) > 0, "no group clusters produced"
    return c


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _participant_ids(conv):
    """The set of participant IDs that went into clustering."""
    return set(conv.rating_mat.index)


def _base_cluster_ids(conv):
    """The set of integer base-cluster IDs."""
    return {bc["id"] for bc in conv.base_clusters}


def _assert_members_are_participant_ids(clusters, participant_ids, base_cluster_ids, label):
    """Assert that every member in every cluster is a participant ID,
    and that no base-cluster ID leaked through."""
    for cluster in clusters:
        members = set(cluster["members"])
        leaked = members & base_cluster_ids
        assert members <= participant_ids, (
            f"{label}[{cluster['id']}].members contains values that are not "
            f"participant IDs: {members - participant_ids}"
        )
        # Guard against the exact bug: integer base-cluster IDs in members
        assert not leaked, (
            f"{label}[{cluster['id']}].members contains base-cluster IDs "
            f"instead of participant IDs: {leaked}"
        )


def _assert_members_cover_all_participants(clusters, participant_ids, label):
    """Assert that the union of all cluster members equals the full
    participant set (no one lost, no one duplicated across groups)."""
    all_members = set()
    for cluster in clusters:
        all_members.update(cluster["members"])
    assert all_members == participant_ids, (
        f"{label}: union of members should be all participants.\n"
        f"  Missing: {participant_ids - all_members}\n"
        f"  Extra:   {all_members - participant_ids}"
    )


# ---------------------------------------------------------------------------
# Sanity: internal state stores base-cluster IDs, _unfolded returns pids
# ---------------------------------------------------------------------------

class TestInternalRepresentation:
    def test_group_clusters_members_are_base_cluster_ids(self, conv):
        """The raw internal group_clusters must store integer base-cluster IDs."""
        bc_ids = _base_cluster_ids(conv)
        for gc in conv.group_clusters:
            assert all(m in bc_ids for m in gc["members"]), (
                f"group_clusters[{gc['id']}].members should be base-cluster "
                f"IDs {bc_ids}, got {gc['members']}"
            )

    def test_unfolded_returns_participant_ids(self, conv):
        """_unfolded_group_clusters() must expand to participant IDs."""
        pids = _participant_ids(conv)
        bc_ids = _base_cluster_ids(conv)
        unfolded = conv._unfolded_group_clusters()
        _assert_members_are_participant_ids(unfolded, pids, bc_ids, "_unfolded")
        _assert_members_cover_all_participants(unfolded, pids, "_unfolded")


# ---------------------------------------------------------------------------
# to_dict(): group-clusters, group_clusters, base-clusters
# ---------------------------------------------------------------------------

class TestToDictUnfolding:
    @pytest.fixture(scope="class")
    def result(self, conv):
        return conv.to_dict()

    def test_group_clusters_hyphen(self, result, conv):
        # Legacy blob shape (the only shape since the mode collapse): the
        # hyphen-key group-clusters carry BASE-CLUSTER ids as members
        # (Clojure convention; test_legacy_blob_shape pins the bid mapping).
        bc_ids = set(_base_cluster_ids(conv))
        all_members = []
        for gc in result["group-clusters"]:
            assert set(gc["members"]) <= bc_ids, (
                f"group-clusters members must be base-cluster ids, "
                f"got {gc['members']}")
            all_members.extend(gc["members"])
        assert sorted(all_members) == sorted(bc_ids), (
            "every base cluster must land in exactly one group")

    def test_group_clusters_underscore(self, result, conv):
        pids = _participant_ids(conv)
        bc_ids = _base_cluster_ids(conv)
        _assert_members_are_participant_ids(
            result["group_clusters"], pids, bc_ids, "to_dict['group_clusters']")
        _assert_members_cover_all_participants(
            result["group_clusters"], pids, "to_dict['group_clusters']")

    def test_base_clusters_columnar_format(self, result, conv):
        """base-clusters must be in columnar format matching what TypeScript expects:
        {id: [...], members: [[pid,...], ...], x: [...], y: [...], count: [...]}"""
        bc = result["base-clusters"]
        # Must be a dict with columnar keys (not a list of dicts)
        assert isinstance(bc, dict), f"base-clusters should be dict, got {type(bc)}"
        for key in ("id", "members", "x", "y", "count"):
            assert key in bc, f"base-clusters missing '{key}' key"
        # All arrays should have the same length
        n = len(bc["id"])
        assert n > 0, "base-clusters should have at least one cluster"
        for key in ("members", "x", "y", "count"):
            assert len(bc[key]) == n, (
                f"base-clusters['{key}'] length {len(bc[key])} != "
                f"base-clusters['id'] length {n}"
            )
        # members should contain participant IDs (not base-cluster IDs)
        pids = _participant_ids(conv)
        all_members = set()
        for member_list in bc["members"]:
            all_members.update(member_list)
        assert all_members <= pids, (
            f"base-clusters.members contains non-participant IDs: "
            f"{all_members - pids}"
        )
        # count[i] should match len(members[i])
        for i in range(n):
            assert bc["count"][i] == len(bc["members"][i]), (
                f"base-clusters.count[{i}]={bc['count'][i]} != "
                f"len(members[{i}])={len(bc['members'][i])}"
            )


# ---------------------------------------------------------------------------
# get_full_data(): group_clusters
# ---------------------------------------------------------------------------

class TestGetFullDataUnfolding:
    def test_group_clusters(self, conv):
        result = conv.get_full_data()
        pids = _participant_ids(conv)
        bc_ids = _base_cluster_ids(conv)
        _assert_members_are_participant_ids(
            result["group_clusters"], pids, bc_ids, "get_full_data['group_clusters']")
        _assert_members_cover_all_participants(
            result["group_clusters"], pids, "get_full_data['group_clusters']")


# ---------------------------------------------------------------------------
# to_dynamo_dict(): base_clusters / group_clusters
# ---------------------------------------------------------------------------

class TestToDynamoDictUnfolding:
    @pytest.fixture(scope="class")
    def result(self, conv):
        return conv.to_dynamo_dict()

    def test_base_clusters(self, result, conv):
        pids = _participant_ids(conv)
        bc_ids = _base_cluster_ids(conv)
        _assert_members_are_participant_ids(
            result["base_clusters"], pids, bc_ids, "to_dynamo_dict['base_clusters']")
        _assert_members_cover_all_participants(
            result["base_clusters"], pids, "to_dynamo_dict['base_clusters']")

    def test_group_clusters(self, result, conv):
        pids = _participant_ids(conv)
        bc_ids = _base_cluster_ids(conv)
        _assert_members_are_participant_ids(
            result["group_clusters"], pids, bc_ids, "to_dynamo_dict['group_clusters']")
        _assert_members_cover_all_participants(
            result["group_clusters"], pids, "to_dynamo_dict['group_clusters']")
