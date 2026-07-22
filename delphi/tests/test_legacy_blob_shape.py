"""Legacy blob-shape alignment — Clojure-exact math_main emission (to_dict).

Pins the clojure-legacy emission surface against Clojure's prep-main blob
(conv_man.clj:45-74), per the step-0 battery diagnosis (journal 2026-07-22
session 3; fingerprints FP-55e290562e, FP-81fda13ef6, FP-2393072de1,
FP-80ca42344a, FP-c3cee15f8b, FP-2f5714ce9c, FP-2975bbfb04 in
docs/divergences.json):

- group-clusters members are BASE-CLUSTER ids (Clojure folded form), not
  unfolded participant ids.
- votes-base is per-base-cluster A/D/S bucket lists over the sort-by-id
  clustered members (agg-bucket-votes-for-tid, conversation.clj:601-608),
  not whole-matrix int totals.
- pca carries comment-projection + comment-extremity
  (with-proj-and-extremtiy, conversation.clj:341-352).
- Mean/projection-derived floats are negated at emission: Delphi's matrix is
  the NEGATION of Clojure's (AGREE=+1 vs AGREE=-1), comps are
  covariance-derived and already equal, so pca.center, base-clusters.x/y,
  group-clusters centers, comment-projection negate (verified empirically:
  max|clj+py| = 1e-16 on center, <=1.4e-7 on x/y, vw single-cut).
- repness is {gid: [selected entries]} with finalize-cmt-stats key names
  (repness.clj:173-188), direction by rat > rdt.
- mod-in / mod-out / lastModTimestamp are None until moderation is applied
  (Clojure conv state holds no :mod-in until the poller delivers moderation).

Improved-mode emission stays byte-for-byte as before (regression-guarded
here; the unfolded-pids contract is separately pinned by
test_serialization_unfolding.py, which runs in the default improved mode).
"""

from __future__ import annotations

import numpy as np
import pytest

from polismath.conversation.conversation import Conversation
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR


# ---------------------------------------------------------------------------
# Fixture: polarized conversation + one under-threshold voter.
# ---------------------------------------------------------------------------
def _make_votes():
    """20 clustered participants (two polarized groups) + p20, who casts only
    3 votes — below the min(7, n_cmts) inclusion threshold — so their votes
    exist in the matrix but they are NOT clustered. Distinguishes the
    clustered-members aggregation domain (Clojure votes-base) from the
    whole-matrix domain (improved totals)."""
    votes = []
    for i in range(20):
        pid = i
        sign = 1 if i < 10 else -1
        for j in range(10):
            votes.append({"pid": pid, "tid": j, "vote": sign if j < 5 else -sign})
    for j in range(3):
        votes.append({"pid": 20, "tid": j, "vote": 1})
    # tid 10: voted ONLY by group A (p0-p9, all agree) — group B has S=0 on
    # it, exercising Clojure's unconditional (A+1)/(S+2) factor for zero-S
    # groups in group-aware-consensus (conversation.clj:633-653).
    for i in range(10):
        votes.append({"pid": i, "tid": 10, "vote": 1})
    return {"votes": votes, "lastVoteTimestamp": 1700000000000}


@pytest.fixture(scope="module")
def conv():
    c = Conversation("legacy_blob_shape")
    c = c.update_votes(_make_votes(), recompute=False)
    c = c.recompute()
    assert len(c.base_clusters) > 0
    assert len(c.group_clusters) >= 2
    assert c.repness and c.repness.get("group_repness")
    return c


@pytest.fixture()
def legacy(monkeypatch):
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, "clojure-legacy")


@pytest.fixture()
def improved(monkeypatch):
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, "improved")


def _sorted_base_clusters(conv):
    return sorted(conv.base_clusters, key=lambda c: c["id"])


# ---------------------------------------------------------------------------
# group-clusters: members are bids in legacy mode.
# ---------------------------------------------------------------------------
def test_legacy_group_clusters_members_are_bids(conv, legacy):
    result = conv.to_dict()
    bc_ids = {c["id"] for c in conv.base_clusters}
    for gc in result["group-clusters"]:
        assert set(gc["members"]) <= bc_ids, (
            f"legacy group-clusters[{gc['id']}].members must be base-cluster "
            f"ids, got {gc['members']}"
        )
    # partition of base clusters: union of members covers every bid exactly once
    all_members = [m for gc in result["group-clusters"] for m in gc["members"]]
    assert sorted(all_members) == sorted(bc_ids)


def test_improved_group_clusters_members_stay_pids(conv, improved):
    result = conv.to_dict()
    pids = set(conv.rating_mat.index)
    for gc in result["group-clusters"]:
        assert set(gc["members"]) <= pids


# ---------------------------------------------------------------------------
# votes-base: per-base-cluster bucket lists in legacy mode.
# ---------------------------------------------------------------------------
def test_legacy_votes_base_is_bucketed_lists(conv, legacy):
    result = conv.to_dict()
    n_buckets = len(conv.base_clusters)
    vb = result["votes-base"]
    assert len(vb) == conv.rating_mat.shape[1]
    for tid, entry in vb.items():
        for k in ("A", "D", "S"):
            assert isinstance(entry[k], list), f"votes-base[{tid}][{k}] must be a list"
            assert len(entry[k]) == n_buckets

    # Buckets align to sort-by-id base clusters: recompute one tid by hand.
    buckets = [c["members"] for c in _sorted_base_clusters(conv)]
    mat = conv.raw_rating_mat
    tid0 = list(mat.columns)[0]
    expect_A = [int(sum(1 for p in b if mat.at[p, tid0] == 1)) for b in buckets]
    expect_D = [int(sum(1 for p in b if mat.at[p, tid0] == -1)) for b in buckets]
    expect_S = [
        int(sum(1 for p in b if not np.isnan(mat.at[p, tid0]))) for b in buckets
    ]
    key = tid0 if tid0 in vb else int(tid0)
    assert vb[key]["A"] == expect_A
    assert vb[key]["D"] == expect_D
    assert vb[key]["S"] == expect_S


def test_legacy_votes_base_excludes_unclustered_votes(conv, legacy):
    """p20 voted agree on tids 0-2 but is not clustered — Clojure's votes-base
    never sees those votes (aggregation runs over bid-to-pid members only)."""
    result = conv.to_dict()
    vb = result["votes-base"]
    clustered = {p for c in conv.base_clusters for p in c["members"]}
    assert 20 not in clustered, "fixture broken: p20 must stay unclustered"
    for tid in (0, 1, 2):
        entry = vb[tid if tid in vb else str(tid)]
        # 10 group-A members agreed on tids 0-2; p20's agree must NOT appear.
        assert sum(entry["A"]) == 10
        assert sum(entry["S"]) == 20


def test_improved_votes_base_stays_int_totals(conv, improved):
    result = conv.to_dict()
    entry = next(iter(result["votes-base"].values()))
    assert isinstance(entry["A"], int)
    assert isinstance(entry["D"], int)
    assert isinstance(entry["S"], int)


# ---------------------------------------------------------------------------
# pca: comment-projection / comment-extremity emitted + sign parity.
# ---------------------------------------------------------------------------
def test_legacy_pca_emits_comment_projection_and_extremity(conv, legacy):
    result = conv.to_dict()
    pca = result["pca"]
    n_cmts = conv.rating_mat.shape[1]
    assert "comment-projection" in pca and "comment-extremity" in pca
    # Clojure transposes cmnt-proj: rows are components, tid-aligned.
    cp = pca["comment-projection"]
    assert len(cp) == len(pca["comps"])
    assert all(len(row) == n_cmts for row in cp)
    assert len(pca["comment-extremity"]) == n_cmts
    # extremity is the column norm of the (sign-invariant) projection
    norms = np.linalg.norm(np.asarray(cp), axis=0)
    np.testing.assert_allclose(pca["comment-extremity"], norms, rtol=1e-9)


def test_legacy_sign_negation_of_center_and_projections(conv, legacy):
    result = conv.to_dict()
    # pca.center emits the NEGATION of the internal (Delphi-convention) center
    np.testing.assert_allclose(
        result["pca"]["center"], -np.asarray(conv.pca["center"]), rtol=0, atol=0
    )
    # comps emit unchanged (covariance-derived)
    np.testing.assert_allclose(result["pca"]["comps"], np.asarray(conv.pca["comps"]))
    # base-clusters x/y emit the negation of the internal cluster centers
    bc = result["base-clusters"]
    by_id = {c["id"]: c for c in conv.base_clusters}
    for i, bid in enumerate(bc["id"]):
        assert bc["x"][i] == pytest.approx(-by_id[bid]["center"][0])
        assert bc["y"][i] == pytest.approx(-by_id[bid]["center"][1])
    # group-clusters centers negate too
    gby_id = {g["id"]: g for g in conv.group_clusters}
    for gc in result["group-clusters"]:
        np.testing.assert_allclose(
            gc["center"], -np.asarray(gby_id[gc["id"]]["center"])
        )
    # comment-projection is the negation of the internal D12 projection
    from polismath.pca_kmeans_rep.pca import pca_project_cmnts

    internal = pca_project_cmnts(
        np.asarray(conv.pca["center"]), np.asarray(conv.pca["comps"])
    )
    np.testing.assert_allclose(
        result["pca"]["comment-projection"], -internal.T, rtol=1e-12
    )


def test_improved_pca_emission_unchanged(conv, improved):
    result = conv.to_dict()
    np.testing.assert_allclose(result["pca"]["center"], np.asarray(conv.pca["center"]))
    assert "comment-projection" not in result["pca"]
    bc = result["base-clusters"]
    by_id = {c["id"]: c for c in conv.base_clusters}
    for i, bid in enumerate(bc["id"]):
        assert bc["x"][i] == pytest.approx(by_id[bid]["center"][0])


# ---------------------------------------------------------------------------
# repness: Clojure finalize-cmt-stats shape in legacy mode.
# ---------------------------------------------------------------------------
def test_legacy_repness_shape_and_direction_mapping(conv, legacy):
    result = conv.to_dict()
    rep = result["repness"]
    internal = conv.repness["group_repness"]
    assert set(rep.keys()) == set(internal.keys())
    for gid, entries in rep.items():
        assert entries, f"group {gid} has no selected repness entries"
        for got, src in zip(entries, internal[gid]):
            repful = "agree" if src["rat"] > src["rdt"] else "disagree"
            assert got["tid"] == src["comment_id"]
            assert got["repful-for"] == repful
            assert got["n-trials"] == src["ns"]
            if repful == "agree":
                assert got["n-success"] == src["na"]
                assert got["p-success"] == pytest.approx(src["pa"])
                assert got["p-test"] == pytest.approx(src["pat"])
                assert got["repness"] == pytest.approx(src["ra"])
                assert got["repness-test"] == pytest.approx(src["rat"], rel=1e-6)
            else:
                assert got["n-success"] == src["nd"]
                assert got["p-success"] == pytest.approx(src["pd"])
                assert got["p-test"] == pytest.approx(src["pdt"])
                assert got["repness"] == pytest.approx(src["rd"])
                assert got["repness-test"] == pytest.approx(src["rdt"], rel=1e-6)
            # best-agree entries carry the two extra Clojure keys
            if src.get("best_agree"):
                assert got["best-agree"] is True
                assert got["n-agree"] == src["n_agree"]
            else:
                assert "best-agree" not in got and "n-agree" not in got
            # no internal spellings leak into the legacy blob
            assert "comment_id" not in got and "na" not in got and "rat" not in got


def test_improved_repness_stays_internal_shape(conv, improved):
    result = conv.to_dict()
    assert set(result["repness"].keys()) == {
        "comment_ids", "group_repness", "comment_repness", "consensus_comments",
    }


# ---------------------------------------------------------------------------
# repness rest-domain: "other" = the OTHER GROUPS only in legacy mode.
# ---------------------------------------------------------------------------
def _rest_domain_fixture():
    import pandas as pd

    votes_long = pd.DataFrame(
        [
            {"participant": 1, "comment": 0, "vote": 1},
            {"participant": 2, "comment": 0, "vote": 1},
            {"participant": 3, "comment": 0, "vote": -1},
            {"participant": 4, "comment": 0, "vote": -1},
            # unclustered voter — in the matrix, in no group
            {"participant": 99, "comment": 0, "vote": 1},
        ]
    )
    groups = [{"id": 0, "members": [1, 2]}, {"id": 1, "members": [3, 4]}]
    return votes_long, groups


def test_legacy_repness_rest_domain_excludes_unclustered(legacy):
    """Clojure's rest-stats sum ONLY over the other groups' (clustered)
    members (utils/mapv-rest over per-group comment-stats, repness.clj:125-131
    + group-members unfolding) — an unclustered participant's votes never
    enter the comparison (FP-69c7a13580 / FP-faac8c6125 root)."""
    from polismath.pca_kmeans_rep.repness import compute_group_comment_stats_df

    votes_long, groups = _rest_domain_fixture()
    df = compute_group_comment_stats_df(votes_long, groups)
    row = df.loc[(0, 0)]
    # group 0: na=2 ns=2 → pa = 3/4. rest = group 1 only: na=0 ns=2 →
    # other_pa = (0+1)/(2+2) = 1/4. ra = 3.
    assert row["pa"] == pytest.approx(0.75)
    assert row["ra"] == pytest.approx(3.0)


def test_improved_repness_rest_domain_includes_all_voters(improved):
    from polismath.pca_kmeans_rep.repness import compute_group_comment_stats_df

    votes_long, groups = _rest_domain_fixture()
    df = compute_group_comment_stats_df(votes_long, groups)
    row = df.loc[(0, 0)]
    # rest = group 1 + p99: na=1 ns=3 → other_pa = (1+1)/(3+2) = 0.4; ra = 1.875
    assert row["ra"] == pytest.approx(0.75 / 0.4)


# ---------------------------------------------------------------------------
# group-aware-consensus: zero-S groups contribute (A+1)/(S+2) = 1/2 in legacy.
# ---------------------------------------------------------------------------
def _gac_group_stats(result, tid):
    stats = {}
    for gid, gdata in result["group-votes"].items():
        vs = gdata["votes"].get(tid, gdata["votes"].get(str(tid), {}))
        stats[gid] = (vs.get("A", 0), vs.get("S", 0))
    return stats


def test_legacy_gac_multiplies_zero_s_groups(conv, legacy):
    """Clojure multiplies (A+1)/(S+2) over EVERY group — a zero-S group
    contributes 1/2 (conversation.clj:639-641, `:or {A 0 S 0}`), it is not
    skipped. tid 10 was voted on only by group A members."""
    result = conv.to_dict()
    stats = _gac_group_stats(result, 10)
    assert any(s == 0 for _, s in stats.values()), (
        f"fixture broken: expected a zero-S group on tid 10, stats={stats}"
    )
    expected = 1.0
    for a, s in stats.values():
        expected *= (a + 1.0) / (s + 2.0)
    assert result["group-aware-consensus"][10] == pytest.approx(expected)


def test_improved_gac_skips_zero_s_groups(conv, improved):
    result = conv.to_dict()
    stats = _gac_group_stats(result, 10)
    expected = 1.0
    for a, s in stats.values():
        if s > 0:
            expected *= (a + 1.0) / (s + 2.0)
    assert result["group-aware-consensus"][10] == pytest.approx(expected)


# ---------------------------------------------------------------------------
# moderation-state semantics: None until moderation applied (legacy).
# ---------------------------------------------------------------------------
def test_legacy_mod_keys_none_until_moderation(conv, legacy):
    result = conv.to_dict()
    assert result["mod-in"] is None
    assert result["mod-out"] is None
    assert result["lastModTimestamp"] is None


def test_legacy_mod_keys_populated_after_moderation(conv, legacy):
    moderated = conv.update_moderation({"mod_out_tids": [3]}, recompute=False)
    result = moderated.to_dict()
    assert result["mod-out"] == [3]
    assert result["mod-in"] == []
    # no moderation timestamp was supplied — stays None (vote-only replays
    # match Clojure's null; real poller feeds will carry one)
    assert result["lastModTimestamp"] is None


def test_improved_mod_keys_stay_lists(conv, improved):
    result = conv.to_dict()
    assert result["mod-in"] == []
    assert result["mod-out"] == []
    assert result["lastModTimestamp"] == conv.last_updated


# ---------------------------------------------------------------------------
# Arrival-order parity: Clojure's named-matrix column order is first-vote
# arrival order (update-nmat appends unseen colnames in encounter order);
# python's internal matrix is natsorted (conversation.py:414). Ties in
# repness/consensus selection resolve by stable sort over COLUMN order, so
# legacy mode tracks arrival order and uses it for tie-breaking + emission.
# ---------------------------------------------------------------------------
def test_tid_arrival_order_tracked_across_updates():
    c = Conversation("arrival_tracking")
    c = c.update_votes(
        {"votes": [
            {"pid": 1, "tid": 5, "vote": 1},
            {"pid": 1, "tid": 2, "vote": 1},
            {"pid": 2, "tid": 9, "vote": -1},
            {"pid": 2, "tid": 2, "vote": 1},
            {"pid": 3, "tid": 5, "vote": 0},
        ]},
        recompute=False,
    )
    assert c.tid_arrival_order == [5, 2, 9]
    c = c.update_votes(
        {"votes": [{"pid": 3, "tid": 1, "vote": 1}, {"pid": 3, "tid": 9, "vote": 1}]},
        recompute=False,
    )
    assert c.tid_arrival_order == [5, 2, 9, 1]


def test_legacy_tids_emitted_in_arrival_order_with_aligned_pca(conv, legacy):
    result = conv.to_dict()
    assert result["tids"] == conv.tid_arrival_order
    # pca arrays must be re-aligned to the emitted tid order: emitted center[i]
    # is the (negated) internal center entry for tids[i].
    internal_center = dict(zip(conv.rating_mat.columns, conv.pca["center"]))
    for i, tid in enumerate(result["tids"]):
        assert result["pca"]["center"][i] == pytest.approx(-internal_center[tid])
    from polismath.pca_kmeans_rep.pca import pca_project_cmnts

    internal_ext = np.linalg.norm(
        pca_project_cmnts(
            np.asarray(conv.pca["center"]), np.asarray(conv.pca["comps"])
        ),
        axis=1,
    )
    ext = dict(zip(conv.rating_mat.columns, internal_ext))
    for i, tid in enumerate(result["tids"]):
        assert result["pca"]["comment-extremity"][i] == pytest.approx(ext[tid])


def test_improved_tids_stay_natsorted(conv, improved):
    result = conv.to_dict()
    assert result["tids"] == list(conv.rating_mat.columns)


def test_legacy_from_dict_restores_arrival_order(conv, legacy):
    restored = Conversation.from_dict(conv.to_dict())
    assert restored.tid_arrival_order == conv.tid_arrival_order


def test_conv_repness_tie_break_follows_tid_order():
    """Two comments with IDENTICAL vote patterns tie on every repness stat;
    Clojure's stable sort keeps them in column (arrival) order. With
    tid_order=[7, 3], 7 must precede 3; without, ascending order wins."""
    import pandas as pd

    from polismath.pca_kmeans_rep.repness import conv_repness

    mat = pd.DataFrame(
        {3: [1, 1, -1, -1], 7: [1, 1, -1, -1]}, index=[1, 2, 3, 4]
    )
    groups = [{"id": 0, "members": [1, 2]}, {"id": 1, "members": [3, 4]}]
    ordered = conv_repness(mat, groups, tid_order=[7, 3])
    tids = [e["comment_id"] for e in ordered["group_repness"][0]]
    assert tids == [7, 3]
    default = conv_repness(mat, groups)
    tids = [e["comment_id"] for e in default["group_repness"][0]]
    assert tids == [3, 7]


def test_conv_repness_consensus_tie_break_follows_tid_order():
    """Universal-agree clones tie on the consensus agree metric; tid_order
    decides their relative rank (Clojure stable sort over column order)."""
    import pandas as pd

    from polismath.pca_kmeans_rep.repness import conv_repness

    mat = pd.DataFrame(
        {
            3: [1, 1, 1, 1],
            7: [1, 1, 1, 1],
            0: [1, -1, 1, -1],
        },
        index=[1, 2, 3, 4],
    )
    groups = [{"id": 0, "members": [1, 2]}, {"id": 1, "members": [3, 4]}]
    ordered = conv_repness(mat, groups, tid_order=[7, 0, 3])
    agree_tids = [e["tid"] for e in ordered["consensus_comments"]["agree"]]
    assert agree_tids[:2] == [7, 3]
    default = conv_repness(mat, groups)
    agree_tids = [e["tid"] for e in default["consensus_comments"]["agree"]]
    assert agree_tids[:2] == [3, 7]


# ---------------------------------------------------------------------------
# from_dict inverse: legacy round-trip restores the internal convention.
# ---------------------------------------------------------------------------
def test_legacy_from_dict_unpermutes_pca_alignment(legacy):
    """Legacy blobs emit tids (and pca arrays) in ARRIVAL order; internal
    state is natsorted-aligned. from_dict must invert the permutation as well
    as the sign, or a warm restore seeds PCA with column-misaligned
    center/comps (review finding on #2649 — the plain round-trip fixture
    below can't catch it because its arrival order is ascending)."""
    arrival = [5, 2, 9, 0, 7, 1, 3, 4, 6, 8]
    votes = []
    for pid in range(20):
        sign = 1 if pid < 10 else -1
        for j, tid in enumerate(arrival):
            votes.append(
                {"pid": pid, "tid": tid, "vote": sign if j < 5 else -sign}
            )
    c = Conversation("roundtrip_perm")
    c = c.update_votes({"votes": votes}, recompute=False)
    c = c.recompute()
    assert c.tid_arrival_order != sorted(c.tid_arrival_order)
    restored = Conversation.from_dict(c.to_dict())
    np.testing.assert_allclose(
        np.asarray(restored.pca["center"]), np.asarray(c.pca["center"])
    )
    np.testing.assert_allclose(
        np.asarray(restored.pca["comps"]), np.asarray(c.pca["comps"])
    )


def test_legacy_from_dict_round_trips_center_sign(conv, legacy):
    restored = Conversation.from_dict(conv.to_dict())
    np.testing.assert_allclose(
        np.asarray(restored.pca["center"]), np.asarray(conv.pca["center"])
    )


def test_improved_from_dict_round_trips_center_sign(conv, improved):
    restored = Conversation.from_dict(conv.to_dict())
    np.testing.assert_allclose(
        np.asarray(restored.pca["center"]), np.asarray(conv.pca["center"])
    )
