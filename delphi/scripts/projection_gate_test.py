"""Tests for the votes / votes_latest_unique projection gate.

OPT-IN and self-skipping (mirrors tests/poller/test_integration_postgres.py): it
starts a THROWAWAY ``postgres:17`` on a host port in 55970-55979 (NEVER the host's
live 5432), applies the real server migrations ``000000_initial.sql`` through the
latest in order, seeds a handful of synthetic votes, and asserts the gate's
classification for:

  1. the IDENTICAL case — today's schema matches the frozen column list exactly,
     so every served cell classifies IDENTICAL and the gate PASSES;
  2. the throwaway-column negative control — a scratch column added to ``votes``
     and ``votes_latest_unique`` (DDL lives HERE, not in the gate tool) makes the
     wildcard serve a column the frozen list does not, so the gate reports
     EXTRA_FIELD and FAILS; the column is dropped afterwards.

If docker is unavailable, the whole module is skipped with a clear reason. Run just
this module (nothing else):

    <venv>/bin/python -m pytest delphi/scripts/projection_gate_test.py -q

``selected_vote_event_id`` / ``vote_event_id`` do NOT exist on edge (verified: no
migration 000000..000018 adds them; they arrive with P-047), so there is no legacy
NULL column to seed here — their future appearance is precisely the EXTRA_FIELD the
negative control proves the gate would catch.
"""

from __future__ import annotations

import glob
import os
import shutil
import socket
import subprocess
import sys
import time
import uuid
from typing import Iterator

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import projection_gate as pg  # noqa: E402

pytestmark = pytest.mark.integration

# Obviously-synthetic conversation id — never a real production zid.
SYNTHETIC_ZID = 424242

_MIGRATIONS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "postgres", "migrations")
)
_PORT_RANGE = range(55970, 55980)


def _pick_port() -> int:
    for port in _PORT_RANGE:
        with socket.socket() as s:
            try:
                s.bind(("", port))
                return port
            except OSError:
                continue
    pytest.skip(f"no free host port in {_PORT_RANGE.start}-{_PORT_RANGE.stop - 1}")


def _migration_files() -> list[str]:
    files = sorted(glob.glob(os.path.join(_MIGRATIONS_DIR, "0*.sql")))
    if not files:
        pytest.skip(f"no migrations found under {_MIGRATIONS_DIR}")
    return files


@pytest.fixture(scope="module")
def dsn() -> Iterator[str]:
    docker = shutil.which("docker")
    if not docker:
        pytest.skip("docker not available")
    migrations = _migration_files()
    port = _pick_port()
    name = f"projgate-{uuid.uuid4().hex[:8]}"
    started = subprocess.run(
        [docker, "run", "--rm", "-d", "--name", name,
         "-p", f"{port}:5432", "-e", "POSTGRES_PASSWORD=test", "postgres:17"],
        capture_output=True, text=True,
    )
    if started.returncode != 0:
        pytest.skip(f"could not start postgres container: {started.stderr.strip()}")
    cid = started.stdout.strip()
    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            if subprocess.run(
                [docker, "exec", cid, "pg_isready", "-U", "postgres"],
                capture_output=True, text=True,
            ).returncode == 0:
                break
            time.sleep(1)
        else:
            pytest.skip("postgres container did not become ready in time")

        for path in migrations:
            with open(path, "rb") as fh:
                applied = subprocess.run(
                    [docker, "exec", "-i", cid, "psql", "-v", "ON_ERROR_STOP=1",
                     "-U", "postgres", "-d", "postgres"],
                    stdin=fh, capture_output=True, text=True,
                )
            if applied.returncode != 0:
                pytest.skip(
                    f"migration {os.path.basename(path)} failed to apply: "
                    f"{applied.stderr[-500:]}"
                )
        url = f"postgresql://postgres:test@localhost:{port}/postgres"
        _seed(url)
        yield url
    finally:
        # Tear down only our own container.
        subprocess.run([docker, "stop", cid], capture_output=True, text=True)


def _seed(url: str) -> None:
    """Seed synthetic votes. Direct inserts fire the on-insert RULE, which
    populates votes_latest_unique. Includes an equal-created pair."""
    import psycopg2

    rows = [
        # (pid, tid, vote, weight_x_32767, created)
        (0, 0, -1, 0, 1000),      # equal-created pair (same created=1000, ...
        (0, 1, 1, 0, 1000),       #   ... different tid) -> deterministic ordering
        (1, 0, -1, 0, 2000),      # revote base
        (1, 0, 1, 0, 3000),       # revote -> vlu upserts to modified=3000, vote=1
        (2, 0, 0, 30000, 4000),   # non-zero weight
    ]
    conn = psycopg2.connect(url)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            # A conversation + zinvite so the wire serializer (addConversationIds)
            # attaches a conversation_id, exercising the real finishArray path.
            cur.execute("INSERT INTO conversations (zid) VALUES (%s)", (SYNTHETIC_ZID,))
            cur.execute(
                "INSERT INTO zinvites (zid, zinvite) VALUES (%s, %s)",
                (SYNTHETIC_ZID, "synthetic-conv-id"),
            )
            for pid, tid, vote, w, created in rows:
                cur.execute(
                    "INSERT INTO votes (zid, pid, tid, vote, weight_x_32767, created) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (SYNTHETIC_ZID, pid, tid, vote, w, created),
                )
    finally:
        conn.close()


def _run_ddl(url: str, statements: list[str]) -> None:
    """Negative-control scaffolding ONLY. DDL never lives in the gate tool."""
    import psycopg2

    conn = psycopg2.connect(url)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            for s in statements:
                cur.execute(s)
    finally:
        conn.close()


def test_identical_case_passes(dsn: str) -> None:
    reports = pg.gate_all(dsn, {"zid": SYNTHETIC_ZID})
    assert len(reports) == 2
    by_name = {r.site.name: r for r in reports}

    for name in ("votesGet", "handle_GET_votes_me"):
        r = by_name[name]
        assert r.ok, f"{name} not IDENTICAL: {r.summary_line()} :: {r.findings}"
        assert r.row_count_expected == r.row_count_served > 0
        assert r.identical_cells > 0
        counts = r.counts()
        assert counts["IDENTICAL"] == r.identical_cells
        assert counts["ORDER_ONLY"] == 0
        assert counts["MISSING_FIELD"] == 0
        assert counts["EXTRA_FIELD"] == 0
        assert counts["VALUE_DIFF"] == 0

    # votes projection carries all 5 raw rows; vlu carries 4 (revote coalesced).
    assert by_name["handle_GET_votes_me"].row_count_served == 5
    assert by_name["votesGet"].row_count_served == 4
    # Frozen column lists are exactly what the sites are allowed to serve today.
    assert by_name["handle_GET_votes_me"].served_columns == (
        "zid", "pid", "tid", "vote", "weight_x_32767", "created", "high_priority",
    )
    assert by_name["votesGet"].served_columns == (
        "zid", "pid", "tid", "vote", "weight_x_32767", "modified",
    )


def test_negative_control_reports_extra_field(dsn: str) -> None:
    probe = "gate_probe_throwaway"
    _run_ddl(dsn, [
        f"ALTER TABLE votes ADD COLUMN {probe} integer",
        f"ALTER TABLE votes_latest_unique ADD COLUMN {probe} integer",
    ])
    try:
        reports = pg.gate_all(dsn, {"zid": SYNTHETIC_ZID})
        by_name = {r.site.name: r for r in reports}
        for name in ("votesGet", "handle_GET_votes_me"):
            r = by_name[name]
            assert not r.ok, f"{name} should FAIL with the throwaway column present"
            extras = [f.column for f in r.findings if f.cls is pg.CellClass.EXTRA_FIELD]
            assert probe in extras, f"{name} did not report EXTRA_FIELD: {r.findings}"
            # The wildcard leaked the column; the frozen projection did not.
            assert probe in r.served_columns
            assert probe not in r.expected_columns
            # Everything else is still byte-identical.
            assert r.counts()["VALUE_DIFF"] == 0
            assert r.counts()["MISSING_FIELD"] == 0
    finally:
        _run_ddl(dsn, [
            f"ALTER TABLE votes DROP COLUMN {probe}",
            f"ALTER TABLE votes_latest_unique DROP COLUMN {probe}",
        ])

    # After dropping the probe, the gate passes again.
    reports = pg.gate_all(dsn, {"zid": SYNTHETIC_ZID})
    assert all(r.ok for r in reports)


def test_gate_refuses_non_select() -> None:
    with pytest.raises(pg.GateReadOnlyViolation):
        pg._assert_statement_allowed("UPDATE votes SET vote = 0")
    with pytest.raises(pg.GateReadOnlyViolation):
        pg._assert_statement_allowed("SELECT 1; DROP TABLE votes")
    # A bare SELECT and the read-only control statement are allowed.
    pg._assert_statement_allowed("SELECT * FROM votes")
    pg._assert_statement_allowed("SET TRANSACTION READ ONLY")


# --- P2: read-only guard is sound against the literal/comment write trick -------


def test_readonly_guard_rejects_literal_comment_write() -> None:
    """Round-1 defect (Astra): a ``--`` inside a string literal was stripped as a
    comment, hiding a trailing multi-statement write. The guard must reject it."""
    astra = ("SELECT '--'; COMMIT; BEGIN READ WRITE; "
             "INSERT INTO astra_readonly_probe VALUES (1); COMMIT; --")
    with pytest.raises(pg.GateReadOnlyViolation):
        pg._assert_statement_allowed(astra)
    for bad in (
        "SELECT 1 -- trailing comment",
        "SELECT 1 /* block */",
        "SELECT 1; SELECT 2",
        "VACUUM",
        "update votes set vote = 0",
    ):
        with pytest.raises(pg.GateReadOnlyViolation):
            pg._assert_statement_allowed(bad)
    # A single comment-free SELECT and the closed control statements are allowed.
    pg._assert_statement_allowed("SELECT 1000::int8 AS created")
    pg._assert_statement_allowed("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")


def test_readonly_enforced_at_database_level(dsn: str) -> None:
    """Even bypassing the guard, the session cannot write (P2 defense in depth)."""
    import psycopg2

    with pg.read_only_connection(dsn) as conn:
        with conn.cursor() as cur:
            with pytest.raises(psycopg2.Error) as exc:
                cur.execute("CREATE TABLE gate_should_never_exist (x integer)")
            assert exc.value.pgcode == "25006"  # read_only_sql_transaction
        conn.rollback()


# --- P3: one REPEATABLE READ snapshot for both projections; multiset matching ---


def test_repeatable_read_shared_snapshot(dsn: str) -> None:
    """Round-1 defect (Astra): under READ COMMITTED a commit between the two reads
    produced a phantom VALUE_DIFF. Under one REPEATABLE READ snapshot it cannot."""
    import psycopg2
    from unittest.mock import patch

    site = pg.SITES["handle_GET_votes_me"]
    filters = {"zid": SYNTHETIC_ZID}
    original = pg.served_projection
    writer = psycopg2.connect(dsn)
    writer.autocommit = True

    def change_between(cur, s, f):  # type: ignore[no-untyped-def]
        writer.cursor().execute(
            "UPDATE votes SET high_priority = TRUE WHERE zid=%s AND pid=0 AND tid=0",
            (SYNTHETIC_ZID,),
        )
        return original(cur, s, f)

    try:
        with pg.read_only_connection(dsn) as conn:
            with conn.cursor() as q:
                q.execute("SHOW transaction_isolation")
                assert q.fetchone()[0] == "repeatable read"
            conn.rollback()
            with patch.object(pg, "served_projection", change_between):
                result = pg.gate_site(conn, site, filters)
        assert result.ok, f"phantom diff under shared snapshot: {result.findings}"
        assert not any(f.cls is pg.CellClass.VALUE_DIFF for f in result.findings)
    finally:
        writer.cursor().execute(
            "UPDATE votes SET high_priority = FALSE WHERE zid=%s", (SYNTHETIC_ZID,)
        )
        writer.close()


def test_multiset_matching_is_order_and_duplicate_safe() -> None:
    site = pg.SITES["handle_GET_votes_me"]
    # Permuted tie rows, identical multiset -> all IDENTICAL.
    r = pg.classify(site, {}, ("a", "b"), [(1, 2), (1, 2), (3, 4)],
                    ("a", "b"), [(3, 4), (1, 2), (1, 2)])
    assert r.ok and not r.findings
    # Multiplicity matters: fewer duplicates served -> VALUE_DIFF.
    r2 = pg.classify(site, {}, ("a",), [(1,), (1,)], ("a",), [(1,)])
    assert not r2.ok and any(f.cls is pg.CellClass.VALUE_DIFF for f in r2.findings)
    # A genuinely conflicting value on a shared column -> VALUE_DIFF on that column.
    r3 = pg.classify(site, {}, ("a", "b"), [(1, 2)], ("a", "b"), [(1, 3)])
    assert any(f.cls is pg.CellClass.VALUE_DIFF and f.column == "b" for f in r3.findings)


def test_preflight_catches_swapped_row_associations() -> None:
    """Round-2 defect (Astra): independent per-column bags accepted a swap of
    values BETWEEN two rows. Whole-row multiset comparison rejects it."""
    site = pg.SITES["handle_GET_votes_me"]
    before = [(0, -1), (1, 1)]  # (tid, vote)
    after = [(0, 1), (1, -1)]   # both comments' votes swapped; column bags unchanged
    swapped = pg.classify(site, {}, ("tid", "vote"), before, ("tid", "vote"), after)
    assert not swapped.ok
    assert any(f.cls is pg.CellClass.VALUE_DIFF and f.column == "vote" for f in swapped.findings)
    # A genuine permutation (same rows, reordered) still passes.
    assert pg.classify(site, {}, ("tid", "vote"), before, ("tid", "vote"), before[::-1]).ok


# --- P4: zero-evidence runs are INCONCLUSIVE; coverage manifest binds replica ---


def test_empty_run_is_inconclusive_not_pass(dsn: str) -> None:
    """Round-1 defect (Astra): an absent zid returned full GATE PASS with zero
    cells. Zero rows carry no evidence -> INCONCLUSIVE, not PASS."""
    reports = pg.gate_all(dsn, {"zid": -SYNTHETIC_ZID})  # absent conversation
    assert reports
    for r in reports:
        assert r.row_count_served == 0 and r.identical_cells == 0
        assert not r.ok
        assert r.status == "INCONCLUSIVE" and r.inconclusive_reason
    # A separately declared empty case is a legitimate individual case.
    declared = pg.gate_all(dsn, {"zid": -SYNTHETIC_ZID}, allow_empty=list(pg.SITES))
    assert all(r.status == "PASS" for r in declared)


def test_manifest_requires_replica_when_demanded(dsn: str) -> None:
    # A bare primary DSN is not proof of replica coverage.
    m = pg.run_manifest(dsn, {"zid": SYNTHETIC_ZID}, replica_dsn=None, require_replica=True)
    assert not m.ok and not m.replica_seen
    # The SAME server passed twice is not a bound standby (not in recovery).
    m2 = pg.run_manifest(dsn, {"zid": SYNTHETIC_ZID}, replica_dsn=dsn, require_replica=True,
                         channels=("preflight", "wire"))
    assert not m2.ok and m2.replica_seen and not m2.distinct_replica
    # All-empty primary evidence is rejected.
    m3 = pg.run_manifest(dsn, {"zid": -SYNTHETIC_ZID}, allow_empty=list(pg.SITES))
    assert not m3.ok


def test_manifest_rejects_unrelated_primary_and_preflight_only(dsn: str) -> None:
    """R4 defect 2: an unrelated primary is not a replica, and a preflight-only run
    is not acceptance (no wire evidence)."""
    import unittest.mock as mock

    primary_id = pg._server_identity(dsn)
    unrelated = pg.ServerIdentity("9999999999999999999", False, None, None)  # diff id, not in recovery
    with mock.patch.object(pg, "_server_identity", side_effect=[primary_id, unrelated]):
        m = pg.run_manifest(dsn, {"zid": SYNTHETIC_ZID, "pid": 0}, replica_dsn=dsn,
                            require_replica=True, channels=("preflight", "wire"))
    assert not m.ok and not m.distinct_replica
    # Preflight-only is not acceptance even with populated primary evidence.
    pre = pg.run_manifest(dsn, {"zid": SYNTHETIC_ZID, "pid": 0}, channels=("preflight",))
    assert not pre.ok and not pre.populated_ok


def test_manifest_full_acceptance_requires_bound_standby_and_wire(dsn: str) -> None:
    """R4 defect 2: acceptance needs a bound standby (in recovery, shared system id)
    AND populated wire coverage on primary and replica."""
    _wire_or_skip(dsn, {"zid": SYNTHETIC_ZID, "pid": 0})  # skip if no node
    import unittest.mock as mock

    primary_id = pg._server_identity(dsn)
    standby_id = pg.ServerIdentity(primary_id.system_identifier, True, None, "primary.host")
    with mock.patch.object(pg, "_server_identity", side_effect=[primary_id, standby_id]):
        m = pg.run_manifest(dsn, {"zid": SYNTHETIC_ZID, "pid": 0}, replica_dsn=dsn,
                            require_replica=True, channels=("preflight", "wire"))
    assert m.distinct_replica and m.populated_ok and m.ok


def _fake_wire_report(name: str, rows: int, channel: str = "wire"):
    return pg.SiteReport(
        site=pg.SITES[name], filters={}, expected_columns=("x",), served_columns=("x",),
        row_count_expected=rows, row_count_served=rows, identical_cells=rows, channel=channel,
    )


def test_manifest_populated_wire_coverage_per_target() -> None:
    """R4 defect 2 (unit): empty replica wire, or preflight-only, is not covered."""
    def manifest(runs):
        return pg.Manifest(runs=runs, require_replica=True, replica_seen=True,
                           requested_sites=tuple(pg.SITES),
                           primary_identity=None, replica_identity=None, approve_same_identity=True)

    prim_full = pg.ChannelRun("primary", "wire",
                              [_fake_wire_report(n, 1) for n in pg.SITES])
    repl_full = pg.ChannelRun("replica", "wire",
                              [_fake_wire_report(n, 1) for n in pg.SITES])
    repl_empty = pg.ChannelRun("replica", "wire",
                               [_fake_wire_report(n, 0) for n in pg.SITES])
    prim_pre = pg.ChannelRun("primary", "preflight",
                             [_fake_wire_report(n, 1, "preflight") for n in pg.SITES])

    assert manifest([prim_full, repl_full]).populated_ok
    assert not manifest([prim_full, repl_empty]).populated_ok   # empty replica
    assert not manifest([prim_pre]).populated_ok                # preflight only


def test_manifest_approval_binds_cluster_and_primary_role() -> None:
    """R5 defect 1 (unit): --approve-same-identity never accepts two different
    identifiers, and the primary must be a write endpoint (not in recovery)."""
    def ident(sid, rec):
        return pg.ServerIdentity(sid, rec, None, None)

    prim = pg.ChannelRun("primary", "wire", [_fake_wire_report(n, 1) for n in pg.SITES])
    repl = pg.ChannelRun("replica", "wire", [_fake_wire_report(n, 1) for n in pg.SITES])

    def mani(p_id, r_id, approve=False, expected=None):
        return pg.Manifest(runs=[prim, repl], require_replica=True, replica_seen=True,
                           requested_sites=tuple(pg.SITES), primary_identity=p_id,
                           replica_identity=r_id, approve_same_identity=approve,
                           expected_system_identifier=expected)

    primary = ident("100", False)
    standby = ident("100", True)       # same cluster, in recovery
    other = ident("200", False)        # unrelated primary

    # Approval with DIFFERENT identifiers is rejected (never two clusters).
    assert not mani(primary, other, approve=True).ok
    assert not mani(primary, other, approve=True).distinct_replica
    # Approval with the SAME identifier (same-cluster read pool) passes.
    assert mani(primary, ident("100", False), approve=True).ok
    # A bound standby (in recovery + same id) passes.
    assert mani(primary, standby).ok and mani(primary, standby).distinct_replica
    # The primary must be a write endpoint: a standby offered as primary is rejected.
    assert not mani(ident("100", True), standby).ok
    assert not mani(ident("100", True), standby).primary_valid
    # expected_system_identifier binds both endpoints.
    assert mani(primary, standby, expected="100").ok
    assert not mani(primary, standby, expected="999").ok


# --- P1: bind to the real served path (query builder + pg types + serializer) ---


def test_classify_wire_is_type_and_order_sensitive() -> None:
    site = pg.SITES["handle_GET_votes_me"]
    # int8 wire "1000" (str) vs int4 1000 (number): the WIRE gate catches it ...
    wire = pg.classify_wire(site, [{"created": "1000"}], [{"created": 1000}])
    assert any(f.cls is pg.CellClass.VALUE_DIFF and f.column == "created" for f in wire.findings)
    # ... while the DB preflight (typeless psycopg2 ints) does NOT — hence both.
    pre = pg.classify(site, {}, ("created",), [(1000,)], ("created",), [(1000,)])
    assert pre.ok
    # key order in the JSON object is contract:
    order = pg.classify_wire(site, [{"a": 1, "b": 2}], [{"b": 2, "a": 1}])
    assert any(f.cls is pg.CellClass.ORDER_ONLY for f in order.findings)
    assert not any(f.cls is pg.CellClass.VALUE_DIFF for f in order.findings)
    # extra / missing key:
    extra = pg.classify_wire(site, [{"a": 1}], [{"a": 1, "b": 2}])
    assert any(f.cls is pg.CellClass.EXTRA_FIELD and f.column == "b" for f in extra.findings)
    missing = pg.classify_wire(site, [{"a": 1, "b": 2}], [{"a": 1}])
    assert any(f.cls is pg.CellClass.MISSING_FIELD and f.column == "b" for f in missing.findings)
    # wrong-handler-query proxy: a served set of a different size cannot pass.
    wrong = pg.classify_wire(site, [{"a": 1}], [{"a": 1}, {"a": 1}])
    assert not wrong.ok


def _wire_or_skip(dsn: str, filters: dict, **kw):
    try:
        return pg.gate_wire(dsn, filters, **kw)
    except pg.WireWitnessUnavailable as exc:
        pytest.skip(f"wire witness unavailable: {exc}")


def test_wire_gate_binds_to_real_served_bytes(dsn: str) -> None:
    """The served rows go through the ACTUAL serializer: zid deleted,
    conversation_id added, weight added (votes_me), int8 as JSON strings. Served
    (star) and frozen-explicit must be byte/type/order identical today."""
    reports = _wire_or_skip(dsn, {"zid": SYNTHETIC_ZID, "pid": 0})
    by_name = {r.site.name: r for r in reports}
    for name in ("votesGet", "handle_GET_votes_me"):
        r = by_name[name]
        assert r.channel == "wire"
        assert r.ok, f"{name} wire not identical: {r.summary_line()} :: {r.findings}"
        # zid never reaches the wire; conversation_id does.
        assert "zid" not in r.served_columns
        assert "conversation_id" in r.served_columns
    # int8 columns are JSON STRINGS on the wire (the int8/int4 distinction the
    # preflight loses). Re-run the raw witness to inspect a served row.
    data = pg.run_wire_witness(dsn, {"zid": SYNTHETIC_ZID, "pid": 0})
    vm = data["handle_GET_votes_me"]["served"][0]
    assert isinstance(vm["created"], str)          # int8 -> "1000"
    assert isinstance(vm["pid"], int)              # int4 -> 0
    assert "weight" in vm and vm["weight"] is None  # NaN -> null, added by handler
    assert "zid" not in vm
    assert list(vm.keys())[-1] == "conversation_id"
    vg = data["votesGet"]["served"][0]
    assert isinstance(vg["modified"], str)         # int8 -> "1000"


def test_wire_gate_negative_control_extra_field(dsn: str) -> None:
    probe = "gate_probe_wire"
    _run_ddl(dsn, [
        f"ALTER TABLE votes ADD COLUMN {probe} integer",
        f"ALTER TABLE votes_latest_unique ADD COLUMN {probe} integer",
    ])
    try:
        reports = _wire_or_skip(dsn, {"zid": SYNTHETIC_ZID, "pid": 0})
        by_name = {r.site.name: r for r in reports}
        for name in ("votesGet", "handle_GET_votes_me"):
            r = by_name[name]
            assert not r.ok, f"{name} wire should FAIL with the throwaway column"
            extras = [f.column for f in r.findings if f.cls is pg.CellClass.EXTRA_FIELD]
            assert probe in extras, f"{name} wire missed EXTRA_FIELD: {r.findings}"
    finally:
        _run_ddl(dsn, [
            f"ALTER TABLE votes DROP COLUMN {probe}",
            f"ALTER TABLE votes_latest_unique DROP COLUMN {probe}",
        ])


def _copy_server_src(dst_root: str) -> str:
    """Copy the two real source files the witness reads into <dst_root>/src."""
    import shutil

    server_dir = pg._resolve_server_dir()
    if not server_dir:
        pytest.skip("server/ not found")
    src = os.path.join(dst_root, "src")
    os.makedirs(os.path.join(src, "routes"), exist_ok=True)
    os.makedirs(os.path.join(src, "db"), exist_ok=True)
    shutil.copy(os.path.join(server_dir, "src", "routes", "votes.ts"),
                os.path.join(src, "routes", "votes.ts"))
    shutil.copy(os.path.join(server_dir, "src", "server-helpers.ts"),
                os.path.join(src, "server-helpers.ts"))
    shutil.copy(os.path.join(server_dir, "src", "db", "sql.ts"),
                os.path.join(src, "db", "sql.ts"))
    return src


def test_wire_gate_is_source_bound(dsn: str, tmp_path) -> None:
    """Round-3 defect 1: SERVED is the REAL route/serializer executed from source,
    so an on-disk change to votes.ts or server-helpers.ts is caught."""
    src = _copy_server_src(str(tmp_path))
    kw = dict(server_dir=pg._resolve_server_dir(), src_root=src)

    # Baseline: unmutated real source == frozen expected -> PASS.
    base = _wire_or_skip(dsn, {"zid": SYNTHETIC_ZID, "pid": 0}, **kw)
    assert all(r.ok for r in base), [r.summary_line() for r in base]

    votes_ts = os.path.join(src, "routes", "votes.ts")
    helpers_ts = os.path.join(src, "server-helpers.ts")
    sql_ts = os.path.join(src, "db", "sql.ts")
    with open(votes_ts) as f:
        votes_orig = f.read()
    with open(helpers_ts) as f:
        helpers_orig = f.read()
    with open(sql_ts) as f:
        sql_orig = f.read()

    def _write(path: str, text: str) -> None:
        with open(path, "w") as f:
            f.write(text)

    def _findings(**flt):
        return {r.site.name: r for r in _wire_or_skip(dsn, {"zid": SYNTHETIC_ZID, "pid": 0}, **kw)}

    # Mutation A: flip the served vote sign in the ACTUAL route.
    assert "resolve(results.rows);" in votes_orig
    _write(votes_ts, votes_orig.replace(
        "resolve(results.rows);",
        "resolve(results.rows.map((r) => ({ ...r, vote: -r.vote })));"))
    rA = _findings()
    assert not rA["votesGet"].ok
    assert any(f.cls is pg.CellClass.VALUE_DIFF and f.column == "vote"
               for f in rA["votesGet"].findings)
    _write(votes_ts, votes_orig)  # restore

    # Mutation B: make the ACTUAL finishArray retain zid + add a field.
    assert "delete items[i].zid;" in helpers_orig
    _write(helpers_ts, helpers_orig.replace(
        "delete items[i].zid;", "items[i].internal_probe = true;"))
    rB = _findings()
    for name in ("votesGet", "handle_GET_votes_me"):
        assert not rB[name].ok
        extras = [f.column for f in rB[name].findings if f.cls is pg.CellClass.EXTRA_FIELD]
        assert "zid" in extras and "internal_probe" in extras, rB[name].findings
    _write(helpers_ts, helpers_orig)  # restore

    # Mutation C: change the ACTUAL SQL builder definition's table -> caught.
    assert 'name: "votes_latest_unique"' in sql_orig
    _write(sql_ts, sql_orig.replace('name: "votes_latest_unique"', 'name: "votes"'))
    rC = _findings()
    assert not rC["votesGet"].ok, rC["votesGet"].findings
    _write(sql_ts, sql_orig)  # restore

    # Refactor D: update the ACTUAL builder to the six frozen columns AND replace
    # .star() with those explicit columns. This preserves the served bytes, so the
    # gate this exists to guard must PASS (not falsely reject the correct refactor).
    columns = ["zid", "pid", "tid", "vote", "weight_x_32767", "modified"]
    columns_old = 'columns: ["zid", "tid", "pid", "modified", "vote", "weight", "high_priority"]'
    assert columns_old in sql_orig
    star_call = ".select(sql_votes_latest_unique.star())"
    assert star_call in votes_orig
    explicit = ".select(" + ", ".join(f"sql_votes_latest_unique.{c}" for c in columns) + ")"
    _write(sql_ts, sql_orig.replace(columns_old, "columns: " + str(columns).replace("'", '"')))
    _write(votes_ts, votes_orig.replace(star_call, explicit))
    rD = _findings()
    assert rD["votesGet"].ok, f"explicit refactor must PASS: {rD['votesGet'].findings}"
    _write(sql_ts, sql_orig)
    _write(votes_ts, votes_orig)

    # Mutation E: change the ACTUAL finishArray response status 200 -> 201 -> caught.
    assert "res.status(200).json(items);" in helpers_orig
    _write(helpers_ts, helpers_orig.replace(
        "res.status(200).json(items);", "res.status(201).json(items);"))
    rE = _findings()
    for name in ("votesGet", "handle_GET_votes_me"):
        assert not rE[name].ok
        assert any(f.column == "<http-status>" for f in rE[name].findings), rE[name].findings
    _write(helpers_ts, helpers_orig)


def test_wire_gate_absent_pid_reflects_real_handler(dsn: str) -> None:
    """Round-3 defect 1: without pid the REAL votesGet returns [] (via
    getVotesForSingleParticipant), so the gate must NOT report a populated PASS."""
    reports = _wire_or_skip(dsn, {"zid": SYNTHETIC_ZID})  # no pid bound
    by_name = {r.site.name: r for r in reports}
    vg = by_name["votesGet"]
    assert vg.row_count_served == 0     # real handler returned []
    assert not vg.ok                    # not a populated PASS


def test_manifest_wire_channel_binds_replica(dsn: str) -> None:
    # Skip if the witness can't run in this environment.
    _wire_or_skip(dsn, {"zid": SYNTHETIC_ZID, "pid": 0})
    m = pg.run_manifest(
        dsn, {"zid": SYNTHETIC_ZID, "pid": 0}, replica_dsn=dsn,
        require_replica=True, channels=("preflight", "wire"),
        approve_same_identity=True,  # same-cluster read pool, explicitly approved
    )
    assert m.ok
    channels = {(r.dsn_label, r.channel) for r in m.runs}
    assert ("primary", "wire") in channels and ("replica", "wire") in channels
