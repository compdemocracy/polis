"""Tests for the prodclone extractor (delphi/scripts/prodclone_extract.py +
delphi/polismath/replay/prodclone.py).

Unit tests exercise the PURE building blocks (SQL builders, feature
classifiers, CSV row formatters, slug minting, path-safety guard, map
merging) with synthetic in-memory data — no database required.

ONE integration test spins up a temp Postgres (via the existing
``require_polis_postgres`` fixture from tests/conftest.py — self-skips if
docker/a service is unavailable), seeds ~30 synthetic rows covering every
feature class, and round-trips survey → extract → ``load_export_votes``.

Privacy: no real zids/report-ids/vote content appear anywhere here — every
seeded zid/pid/tid/vote below is synthetic, invented for this test only.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import re
from pathlib import Path

import pytest
from click.testing import CliRunner

from polismath.replay import prodclone as pc

_CLI_PATH = Path(__file__).resolve().parents[1] / "scripts" / "prodclone_extract.py"


def _load_cli_module():
    spec = importlib.util.spec_from_file_location("prodclone_extract_cli", _CLI_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# classify_conversation — pure feature classifiers
# ---------------------------------------------------------------------------


def _stats(**overrides) -> dict:
    base = dict(
        zid=1,
        n_votes=1000,
        n_ptpts=50,
        n_comments=40,
        n_mod_out=0,
        n_revotes=0,
        has_banned_voter=False,
        has_meta=False,
    )
    base.update(overrides)
    return base


def test_classify_modheavy_qualifies_at_threshold():
    stats = _stats(n_comments=100, n_mod_out=20)  # exactly 20%
    result = pc.classify_conversation(stats)
    assert result["modheavy"] == pytest.approx(0.20)


def test_classify_modheavy_below_threshold_excluded():
    stats = _stats(n_comments=100, n_mod_out=19)  # 19% < 20%
    result = pc.classify_conversation(stats)
    assert result["modheavy"] is None


def test_classify_modheavy_zero_comments_excluded():
    stats = _stats(n_comments=0, n_mod_out=0)
    result = pc.classify_conversation(stats)
    assert result["modheavy"] is None


def test_classify_revote_qualifies_at_threshold():
    stats = _stats(n_votes=1000, n_revotes=100)  # exactly 10%
    result = pc.classify_conversation(stats)
    assert result["revote"] == pytest.approx(0.10)


def test_classify_revote_below_threshold_excluded():
    stats = _stats(n_votes=1000, n_revotes=99)
    result = pc.classify_conversation(stats)
    assert result["revote"] is None


def test_classify_banned_qualifies():
    stats = _stats(has_banned_voter=True)
    result = pc.classify_conversation(stats)
    assert result["banned"] == pytest.approx(float(stats["n_votes"]))


def test_classify_banned_absent_excluded():
    stats = _stats(has_banned_voter=False)
    result = pc.classify_conversation(stats)
    assert result["banned"] is None


def test_classify_meta_qualifies():
    stats = _stats(has_meta=True)
    result = pc.classify_conversation(stats)
    assert result["meta"] == pytest.approx(float(stats["n_comments"]))


def test_classify_meta_absent_excluded():
    stats = _stats(has_meta=False)
    result = pc.classify_conversation(stats)
    assert result["meta"] is None


def test_classify_zerovote_qualifies():
    stats = _stats(n_votes=0, n_ptpts=3)
    result = pc.classify_conversation(stats)
    assert result["zerovote"] == pytest.approx(3.0)


def test_classify_zerovote_excluded_when_votes_present():
    stats = _stats(n_votes=1)
    result = pc.classify_conversation(stats)
    assert result["zerovote"] is None


def test_classify_smallmix_qualifies_when_unremarkable_and_small():
    stats = _stats(n_votes=3000, n_comments=40, n_mod_out=0, n_revotes=0,
                    has_banned_voter=False, has_meta=False)
    result = pc.classify_conversation(stats)
    assert result["smallmix"] == pytest.approx(3000.0)
    assert result["midmix"] is None


def test_classify_midmix_qualifies_when_unremarkable_and_medium():
    stats = _stats(n_votes=30_000, n_comments=40)
    result = pc.classify_conversation(stats)
    assert result["midmix"] == pytest.approx(30_000.0)
    assert result["smallmix"] is None


def test_classify_smallmix_excluded_at_zero_votes():
    """zerovote and smallmix are mutually exclusive (smallmix requires > 0)."""
    stats = _stats(n_votes=0)
    result = pc.classify_conversation(stats)
    assert result["smallmix"] is None
    assert result["midmix"] is None


def test_classify_smallmix_excluded_above_size_bound():
    stats = _stats(n_votes=200_000)
    result = pc.classify_conversation(stats)
    assert result["smallmix"] is None
    assert result["midmix"] is None


def test_classify_unremarkable_excludes_modheavy_from_smallmix():
    """A small conversation that is ALSO modheavy must not double-count as
    smallmix — 'unremarkable' means none of the other features apply."""
    stats = _stats(n_votes=3000, n_comments=100, n_mod_out=25)  # 25% mod-out
    result = pc.classify_conversation(stats)
    assert result["modheavy"] is not None
    assert result["smallmix"] is None


def test_classify_unremarkable_excludes_banned_from_midmix():
    stats = _stats(n_votes=30_000, has_banned_voter=True)
    result = pc.classify_conversation(stats)
    assert result["banned"] is not None
    assert result["midmix"] is None


# ---------------------------------------------------------------------------
# survey_candidates — sorting + per-class limit
# ---------------------------------------------------------------------------


def test_survey_candidates_sorts_descending_by_metric_and_limits():
    rows = [
        _stats(zid=1, n_comments=100, n_mod_out=20),  # 0.20
        _stats(zid=2, n_comments=100, n_mod_out=80),  # 0.80
        _stats(zid=3, n_comments=100, n_mod_out=50),  # 0.50
        _stats(zid=4, n_comments=100, n_mod_out=19),  # excluded
    ]
    result = pc.survey_candidates(rows, limit=2)
    modheavy = result["modheavy"]
    assert [c["zid"] for c in modheavy] == [2, 3]
    assert modheavy[0]["metric"] == pytest.approx(0.80)
    # Row columns required by the spec (no topic/text).
    for c in modheavy:
        assert set(c) >= {"zid", "n_votes", "n_ptpts", "n_comments", "metric"}


def test_survey_candidates_zerovote_sorts_ascending_by_ptpts():
    """zerovote favors the simplest (fewest-participant) exemplar first."""
    rows = [
        _stats(zid=1, n_votes=0, n_ptpts=9),
        _stats(zid=2, n_votes=0, n_ptpts=1),
        _stats(zid=3, n_votes=0, n_ptpts=5),
    ]
    result = pc.survey_candidates(rows, limit=10)
    assert [c["zid"] for c in result["zerovote"]] == [2, 3, 1]


def test_survey_candidates_covers_all_feature_classes():
    rows = [_stats(zid=1)]
    result = pc.survey_candidates(rows, limit=5)
    assert set(result) == set(pc.FEATURES)


def test_size_class_counts():
    rows = [
        _stats(zid=1, n_votes=100),      # small
        _stats(zid=2, n_votes=5000),     # small (boundary, inclusive)
        _stats(zid=3, n_votes=5001),     # medium
        _stats(zid=4, n_votes=50_000),   # medium (boundary, inclusive)
        _stats(zid=5, n_votes=50_001),   # large
    ]
    counts = pc.size_class_counts(rows)
    assert counts["small"] == 2
    assert counts["medium"] == 2
    assert counts["large"] == 1


# ---------------------------------------------------------------------------
# next_free_slug — pure slug minting
# ---------------------------------------------------------------------------


def test_next_free_slug_first_ever():
    assert pc.next_free_slug("modheavy", []) == "pc-modheavy-01"


def test_next_free_slug_fills_gap():
    existing = ["pc-modheavy-01", "pc-modheavy-03"]
    assert pc.next_free_slug("modheavy", existing) == "pc-modheavy-02"


def test_next_free_slug_ignores_other_features():
    existing = ["pc-revote-01", "pc-revote-02"]
    assert pc.next_free_slug("modheavy", existing) == "pc-modheavy-01"


def test_next_free_slug_is_neutral():
    """Minted slugs must never leak feature-unrelated identifying info."""
    slug = pc.next_free_slug("banned", [])
    assert re.fullmatch(r"pc-banned-\d\d", slug)


# ---------------------------------------------------------------------------
# fake_report_prefix — salted hash, no zid leak
# ---------------------------------------------------------------------------


def test_fake_report_prefix_deterministic():
    assert pc.fake_report_prefix(424242) == pc.fake_report_prefix(424242)


def test_fake_report_prefix_differs_across_zids():
    assert pc.fake_report_prefix(1) != pc.fake_report_prefix(2)


def test_fake_report_prefix_format_and_no_literal_zid():
    zid = 13579
    prefix = pc.fake_report_prefix(zid)
    assert prefix.startswith("pcx")
    assert re.fullmatch(r"pcx[0-9a-f]+", prefix)
    assert str(zid) not in prefix


# ---------------------------------------------------------------------------
# assert_under_local — path-safety guard
# ---------------------------------------------------------------------------


def test_assert_under_local_accepts_path_inside(tmp_path):
    target = tmp_path / ".local" / "pcxabc-pc-modheavy-01"
    result = pc.assert_under_local(target, tmp_path)
    assert result == target.resolve()


def test_assert_under_local_rejects_path_outside_dot_local(tmp_path):
    """The core path-safety requirement: writing anywhere that is NOT under
    <root>/.local/ must raise, even if it's still under the real_data root."""
    bad = tmp_path / "not_local" / "pcxabc-pc-modheavy-01"
    with pytest.raises(ValueError):
        pc.assert_under_local(bad, tmp_path)


def test_assert_under_local_rejects_traversal_escape(tmp_path):
    bad = tmp_path / ".local" / ".." / ".." / "evil"
    with pytest.raises(ValueError):
        pc.assert_under_local(bad, tmp_path)


def test_compute_extract_dir_confines_to_local(tmp_path):
    target = pc.compute_extract_dir(tmp_path, "pcxabc123", "pc-modheavy-01")
    assert target == (tmp_path / ".local" / "pcxabc123-pc-modheavy-01").resolve()


# ---------------------------------------------------------------------------
# CSV row formatters — mirror the export format (server/src/report.ts)
# ---------------------------------------------------------------------------


def test_format_votes_rows_flips_sign_and_maps_columns():
    raw = [{"tid": 7, "pid": 3, "vote": -1, "created": 1_700_000_000_123}]
    rows = pc.format_votes_rows(raw)
    assert len(rows) == 1
    row = rows[0]
    assert set(row) == {"timestamp", "datetime", "comment-id", "voter-id", "vote"}
    assert row["timestamp"] == "1700000000"
    assert row["comment-id"] == "7"
    assert row["voter-id"] == "3"
    assert row["vote"] == "1"  # raw -1 (agree) flips to export +1


def test_format_votes_rows_preserves_all_rows_no_dedup():
    """Full revote history: two rows for the same (pid, tid) must both survive."""
    raw = [
        {"tid": 1, "pid": 1, "vote": -1, "created": 100_000},
        {"tid": 1, "pid": 1, "vote": 1, "created": 200_000},
    ]
    rows = pc.format_votes_rows(raw)
    assert len(rows) == 2
    assert rows[0]["vote"] == "1"
    assert rows[1]["vote"] == "-1"


def test_format_votes_rows_preserves_input_order():
    raw = [
        {"tid": 2, "pid": 1, "vote": 0, "created": 300},
        {"tid": 1, "pid": 1, "vote": 0, "created": 100},
    ]
    rows = pc.format_votes_rows(raw)
    assert [r["comment-id"] for r in rows] == ["2", "1"]


def test_format_comments_rows_redacts_text():
    raw = [{"tid": 5, "pid": 2, "created": 1_700_000_000_000, "mod": 1}]
    rows = pc.format_comments_rows(raw, vote_counts={})
    row = rows[0]
    assert row["comment-body"] == ""
    assert set(row) == {
        "timestamp", "datetime", "comment-id", "author-id",
        "agrees", "disagrees", "moderated", "comment-body",
        "is-meta", "modified",
    }


def test_format_comments_rows_counts_agrees_disagrees():
    raw = [{"tid": 5, "pid": 2, "created": 0, "mod": 0}]
    rows = pc.format_comments_rows(raw, vote_counts={5: (7, 3)})
    row = rows[0]
    assert row["agrees"] == "7"
    assert row["disagrees"] == "3"


def test_format_comments_rows_default_zero_votes():
    raw = [{"tid": 9, "pid": 2, "created": 0, "mod": -1}]
    rows = pc.format_comments_rows(raw, vote_counts={})
    row = rows[0]
    assert row["agrees"] == "0"
    assert row["disagrees"] == "0"
    assert row["moderated"] == "-1"


# ---------------------------------------------------------------------------
# is-meta / modified columns (MOD_RESTART_PORT_SPEC.md "Data" bullet):
# additive, after the existing columns; comment-body stays EMPTY regardless.
# ---------------------------------------------------------------------------
def test_format_comments_rows_includes_is_meta_and_modified():
    raw = [{"tid": 5, "pid": 2, "created": 0, "mod": -1, "is_meta": True, "modified": 12345}]
    rows = pc.format_comments_rows(raw, vote_counts={})
    row = rows[0]
    assert row["is-meta"] == "True"
    assert row["modified"] == "12345"


def test_format_comments_rows_defaults_is_meta_false_and_modified_empty_when_absent():
    # Tolerates raw rows that don't carry the new keys at all (defensive;
    # every SQL-fetched row will, post this port, but the formatter itself
    # stays permissive).
    raw = [{"tid": 5, "pid": 2, "created": 0, "mod": -1}]
    rows = pc.format_comments_rows(raw, vote_counts={})
    row = rows[0]
    assert row["is-meta"] == "False"
    assert row["modified"] == ""


def test_format_comments_rows_modified_none_becomes_empty_string():
    # comments.modified is nullable in the DB (schema permits NULL even
    # though it defaults to now_as_millis()) -> empty string, not "None".
    raw = [{"tid": 5, "pid": 2, "created": 0, "mod": -1, "is_meta": False, "modified": None}]
    rows = pc.format_comments_rows(raw, vote_counts={})
    assert rows[0]["modified"] == ""


# ---------------------------------------------------------------------------
# CSV writers — round-trip through csv.DictReader
# ---------------------------------------------------------------------------


def test_write_votes_csv_round_trips(tmp_path):
    raw = [
        {"tid": 1, "pid": 1, "vote": -1, "created": 1_700_000_000_000},
        {"tid": 2, "pid": 1, "vote": 1, "created": 1_700_000_001_000},
    ]
    path = tmp_path / "votes.csv"
    pc.write_votes_csv(path, pc.format_votes_rows(raw))
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        assert reader.fieldnames == [
            "timestamp", "datetime", "comment-id", "voter-id", "vote",
        ]
        got = list(reader)
    assert len(got) == 2
    assert got[0]["vote"] == "1"


def test_write_comments_csv_round_trips(tmp_path):
    raw = [{"tid": 1, "pid": 1, "created": 1_700_000_000_000, "mod": 1,
            "is_meta": False, "modified": 1_700_000_000_500}]
    path = tmp_path / "comments.csv"
    pc.write_comments_csv(path, pc.format_comments_rows(raw, vote_counts={1: (2, 1)}))
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        assert reader.fieldnames == [
            "timestamp", "datetime", "comment-id", "author-id",
            "agrees", "disagrees", "moderated", "comment-body",
            "is-meta", "modified",
        ]
        got = list(reader)
    assert got[0]["comment-body"] == ""
    assert got[0]["agrees"] == "2"
    assert got[0]["is-meta"] == "False"
    assert got[0]["modified"] == "1700000000500"


# ---------------------------------------------------------------------------
# CLI wiring — click commands, DB access faked out (no real Postgres needed).
# ---------------------------------------------------------------------------


class _FakeConn:
    def close(self):
        pass


def test_survey_cli_prints_compactly_and_writes_json(tmp_path, monkeypatch):
    mod = _load_cli_module()
    monkeypatch.setattr(mod.psycopg2, "connect", lambda url: _FakeConn())

    stats_rows = [
        _stats(zid=1, n_comments=100, n_mod_out=30),  # modheavy
        _stats(zid=2, n_votes=0, n_ptpts=2),           # zerovote
    ]
    monkeypatch.setattr(mod.pc, "fetch_conversation_stats", lambda conn: stats_rows)

    # survey --out is containment-guarded like extract (raw zids in the JSON),
    # so the test destination must live under <REAL_DATA_ROOT>/.local/.
    monkeypatch.setattr(mod, "REAL_DATA_ROOT", tmp_path)
    out_path = tmp_path / ".local" / "survey.json"
    runner = CliRunner()
    res = runner.invoke(
        mod.cli,
        ["survey", "--database-url", "postgresql://fake", "--limit", "2",
         "--out", str(out_path)],
    )
    assert res.exit_code == 0, res.output
    assert "[modheavy]" in res.output
    assert "[zerovote]" in res.output
    lines = [l for l in res.output.splitlines() if l.strip()]
    assert len(lines) <= 40

    data = json.loads(out_path.read_text())
    assert data["n_conversations"] == 2
    assert any(c["zid"] == 1 for c in data["candidates"]["modheavy"])
    assert any(c["zid"] == 2 for c in data["candidates"]["zerovote"])
    # No topic/description/text anywhere in the survey output.
    dumped = json.dumps(data)
    for forbidden in ("topic", "description", "txt", "comment-body"):
        assert forbidden not in dumped


def test_extract_cli_writes_files_and_updates_map(tmp_path, monkeypatch):
    mod = _load_cli_module()
    monkeypatch.setattr(mod.psycopg2, "connect", lambda url: _FakeConn())

    votes_raw = [
        {"tid": 1, "pid": 1, "vote": -1, "created": 1_700_000_000_000},
        {"tid": 1, "pid": 1, "vote": 1, "created": 1_700_000_001_000},
    ]
    comments_raw = [{"tid": 1, "pid": 1, "created": 1_700_000_000_000, "mod": 0}]
    monkeypatch.setattr(mod.pc, "fetch_votes", lambda conn, zid: votes_raw)
    monkeypatch.setattr(mod.pc, "fetch_comments", lambda conn, zid: comments_raw)
    monkeypatch.setattr(mod.pc, "fetch_comment_vote_counts", lambda conn, zid: {1: (1, 1)})

    out_root = tmp_path / "real_data_root"
    runner = CliRunner()
    res = runner.invoke(
        mod.cli,
        ["extract", "--database-url", "postgresql://fake", "--zid", "555",
         "--feature", "meta", "--out-root", str(out_root)],
    )
    assert res.exit_code == 0, res.output
    assert "slug=pc-meta-01" in res.output

    map_path = out_root / ".local" / "prodclone_map.json"
    saved_map = json.loads(map_path.read_text())
    assert saved_map["pc-meta-01"]["zid"] == 555
    assert saved_map["pc-meta-01"]["feature"] == "meta"

    extracted_dirs = list((out_root / ".local").glob("pcx*-pc-meta-01"))
    assert len(extracted_dirs) == 1
    votes_csvs = list(extracted_dirs[0].glob("*-votes.csv"))
    assert len(votes_csvs) == 1
    with open(votes_csvs[0], newline="") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 2  # full revote history, no dedup


def test_extract_cli_rejects_unknown_feature(tmp_path, monkeypatch):
    mod = _load_cli_module()
    monkeypatch.setattr(mod.psycopg2, "connect", lambda url: _FakeConn())
    runner = CliRunner()
    res = runner.invoke(
        mod.cli,
        ["extract", "--database-url", "postgresql://fake", "--zid", "1",
         "--feature", "not-a-real-feature", "--out-root", str(tmp_path)],
    )
    assert res.exit_code != 0


# ---------------------------------------------------------------------------
# merge_prodclone_map — merge-update, never clobber
# ---------------------------------------------------------------------------


def test_merge_prodclone_map_adds_new_slug():
    existing = {"pc-modheavy-01": {"zid": 1}}
    merged = pc.merge_prodclone_map(existing, "pc-revote-01", {"zid": 2})
    assert merged["pc-modheavy-01"] == {"zid": 1}
    assert merged["pc-revote-01"] == {"zid": 2}


def test_merge_prodclone_map_does_not_mutate_input():
    existing = {"pc-modheavy-01": {"zid": 1}}
    pc.merge_prodclone_map(existing, "pc-revote-01", {"zid": 2})
    assert "pc-revote-01" not in existing


def test_merge_prodclone_map_overwrites_same_slug():
    existing = {"pc-modheavy-01": {"zid": 1, "n_votes": 10}}
    merged = pc.merge_prodclone_map(existing, "pc-modheavy-01", {"zid": 1, "n_votes": 99})
    assert merged["pc-modheavy-01"]["n_votes"] == 99


# ---------------------------------------------------------------------------
# SQL builders — pure string construction (no DB), sanity-checked shape
# ---------------------------------------------------------------------------


def test_sql_conversation_stats_mentions_expected_tables():
    sql = pc.sql_conversation_stats()
    lowered = sql.lower()
    for table in ("conversations", "votes", "participants", "comments"):
        assert table in lowered


def test_sql_votes_export_orders_by_created_then_tiebreak():
    sql = pc.sql_votes_export()
    lowered = sql.lower()
    assert "order by" in lowered
    assert "created" in lowered
    assert "%s" in sql  # zid placeholder


def test_sql_comments_export_has_zid_placeholder():
    sql = pc.sql_comments_export()
    assert "%s" in sql


def test_sql_comments_export_selects_is_meta_and_modified():
    sql = pc.sql_comments_export()
    lowered = sql.lower()
    assert "is_meta" in lowered
    assert "modified" in lowered


def test_sql_comment_vote_counts_has_zid_placeholder():
    sql = pc.sql_comment_vote_counts()
    assert "%s" in sql


# ---------------------------------------------------------------------------
# Integration test — real Postgres schema, survey + extract round trip
# ---------------------------------------------------------------------------


def _seed(cur, zid, uid_start, *, votes, comments, participants, banned_pids=()):
    """Seed one synthetic conversation.

    Assumes the CALLER has already run ``SET session_replication_role =
    replica`` on this session — that suppresses FK-enforcement triggers (so we
    don't need real ``users`` rows) and the ``tid_auto`` trigger (so our
    explicit tid values are kept verbatim instead of being reassigned).
    Mirrors the pattern in tests/poller/test_integration_postgres.py.

    votes: list of (pid, tid, vote_sign, created_ms)  [raw DB sign]
    comments: list of (tid, pid, created_ms, mod, is_meta)
    participants: list of pid
    """
    cur.execute(
        "INSERT INTO conversations (zid, topic, description) VALUES (%s, %s, %s)",
        (zid, "t", "d"),
    )
    uid = uid_start
    for pid in participants:
        mod = -1 if pid in banned_pids else 0
        cur.execute(
            "INSERT INTO participants (zid, pid, uid, mod) VALUES (%s, %s, %s, %s)",
            (zid, pid, uid + pid, mod),
        )
    for tid, pid, created, mod, is_meta in comments:
        cur.execute(
            "INSERT INTO comments (zid, tid, pid, uid, created, txt, mod, is_meta) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (zid, tid, pid, uid + pid, created, f"synthetic comment {zid}-{tid}",
             mod, is_meta),
        )
    for pid, tid, vote, created in votes:
        cur.execute(
            "INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, %s, %s, %s, %s)",
            (zid, pid, tid, vote, created),
        )


@pytest.mark.integration
def test_survey_and_extract_round_trip(tmp_path, monkeypatch):
    from tests.conftest import require_polis_postgres

    with require_polis_postgres() as url:
        import psycopg2

        conn = psycopg2.connect(url)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute("SET session_replication_role = replica")
                # zid 1: modheavy — 3/10 comments moderated-out (30% >= 20%).
                _seed(
                    cur, zid=101_001, uid_start=1,
                    participants=[0, 1, 2, 3],
                    comments=[(t, 0, 1000 + t, (-1 if t < 3 else 0), False)
                              for t in range(10)],
                    votes=[(p, t, -1, 2000 + p * 10 + t)
                           for p in range(1, 4) for t in range(10)],
                )
                # zid 2: revote-heavy — 2 of 10 distinct pairs revoted (>=10%).
                base_votes = [(p, t, -1, 3000 + p * 10 + t)
                              for p in range(2) for t in range(5)]
                revotes = [(0, 0, 1, 3999), (0, 1, 1, 3998)]
                _seed(
                    cur, zid=101_002, uid_start=100,
                    participants=[0, 1],
                    comments=[(t, 0, 3000 + t, 0, False) for t in range(5)],
                    votes=base_votes + revotes,
                )
                # zid 3: banned voter cast a vote.
                _seed(
                    cur, zid=101_003, uid_start=200,
                    participants=[0, 1],
                    banned_pids=[1],
                    comments=[(0, 0, 4000, 0, False)],
                    votes=[(0, 0, -1, 4001), (1, 0, 1, 4002)],
                )
                # zid 4: has a meta comment.
                _seed(
                    cur, zid=101_004, uid_start=300,
                    participants=[0],
                    comments=[(0, 0, 5000, 0, True)],
                    votes=[(0, 0, -1, 5001)],
                )
                # zid 5: zerovote.
                _seed(
                    cur, zid=101_005, uid_start=400,
                    participants=[0, 1],
                    comments=[(0, 0, 6000, 0, False)],
                    votes=[],
                )
                # zid 6: unremarkable small (smallmix).
                _seed(
                    cur, zid=101_006, uid_start=500,
                    participants=[0, 1],
                    comments=[(0, 0, 7000, 0, False)],
                    votes=[(0, 0, -1, 7001), (1, 0, 1, 7002)],
                )

            stats = pc.fetch_conversation_stats(conn)
            our_zids = {101_001, 101_002, 101_003, 101_004, 101_005, 101_006}
            our_stats = [s for s in stats if s["zid"] in our_zids]
            assert len(our_stats) == 6

            survey = pc.survey_candidates(our_stats, limit=10)
            assert 101_001 in {c["zid"] for c in survey["modheavy"]}
            assert 101_002 in {c["zid"] for c in survey["revote"]}
            assert 101_003 in {c["zid"] for c in survey["banned"]}
            assert 101_004 in {c["zid"] for c in survey["meta"]}
            assert 101_005 in {c["zid"] for c in survey["zerovote"]}
            assert 101_006 in {c["zid"] for c in survey["smallmix"]}

            # --- extract zid 101_006 (smallmix) and verify with load_export_votes ---
            out_root = tmp_path / "real_data_root"
            map_path = out_root / ".local" / "prodclone_map.json"
            result = pc.run_extract(
                conn, zid=101_006, feature="smallmix",
                out_root=out_root, map_path=map_path,
            )
            slug = result["slug"]
            extracted_dir = Path(result["dir"])
            assert extracted_dir.exists()
            assert extracted_dir.is_relative_to((out_root / ".local").resolve())

            votes_csv = next(extracted_dir.glob("*-votes.csv"))
            comments_csv = next(extracted_dir.glob("*-comments.csv"))
            with open(votes_csv, newline="") as fh:
                vote_rows = list(csv.DictReader(fh))
            assert len(vote_rows) == 2
            with open(comments_csv, newline="") as fh:
                comment_rows = list(csv.DictReader(fh))
            assert comment_rows[0]["comment-body"] == ""

            # prodclone_map.json — merge-update, never clobber.
            assert map_path.exists()
            saved_map = json.loads(map_path.read_text())
            assert slug in saved_map
            assert saved_map[slug]["zid"] == 101_006
            assert saved_map[slug]["feature"] == "smallmix"

            # A second extraction (different feature) must not clobber the map.
            result2 = pc.run_extract(
                conn, zid=101_005, feature="zerovote",
                out_root=out_root, map_path=map_path,
            )
            saved_map2 = json.loads(map_path.read_text())
            assert slug in saved_map2  # still there
            assert result2["slug"] in saved_map2

            # --- verify parseability via the real loader (monkeypatch its
            # search root at the .local dir, per the spec's suggested escape
            # hatch — load_export_votes globs REAL_DATA_ROOT non-recursively).
            from polismath.replay import real_data as real_data_mod

            monkeypatch.setattr(
                real_data_mod, "REAL_DATA_ROOT", (out_root / ".local").resolve()
            )
            ds = real_data_mod.load_export_votes(slug)
            assert ds.n == 2
        finally:
            conn.close()


def test_extract_path_safety_guard_direct(tmp_path):
    """Spec-mandated path-safety test: a target outside .local must raise."""
    with pytest.raises(ValueError):
        pc.assert_under_local(tmp_path / "real_data" / "oops", tmp_path)


def test_survey_cli_refuses_out_path_outside_local(tmp_path, monkeypatch):
    """survey --out is guarded like extract: the survey JSON carries raw
    zids, so a destination outside <REAL_DATA_ROOT>/.local/ must be refused
    BEFORE anything runs (review finding, 2026-07-22)."""
    mod = _load_cli_module()
    monkeypatch.setattr(mod, "REAL_DATA_ROOT", tmp_path)
    runner = CliRunner()
    res = runner.invoke(
        mod.cli,
        ["survey", "--database-url", "postgresql://fake",
         "--out", str(tmp_path / "leak.json")],
    )
    assert res.exit_code != 0
    assert not (tmp_path / "leak.json").exists()
