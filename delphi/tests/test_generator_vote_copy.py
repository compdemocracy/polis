"""Integration test for the cold-start generator's full-history vote copy (T2).

`copy_votes_with_fresh_timestamps` copies the FULL vote history (including
revotes — multiple rows for the same (pid, tid)) with a single multi-row
`INSERT ... SELECT`. The `votes` table carries the LIVE rule
`on_vote_insert_update_unique_table` (migration 000006), which DO-ALSO upserts
`votes_latest_unique` with `ON CONFLICT (zid,pid,tid) DO UPDATE`. A single INSERT
statement containing revote duplicates makes that upsert touch the same conflict
key twice IN ONE STATEMENT, which Postgres rejects with:

    ON CONFLICT DO UPDATE command cannot affect row a second time

The fix wraps the copy in `session_replication_role = 'replica'` (mirroring
`copy_comments_with_fresh_timestamps`), suppressing the default-config rule for
the copy. This test seeds a source conversation WITH REVOTES and asserts the
copy round-trips every row, in source order, with the revote pairs preserved.

OPT-IN / self-skipping: provisions a throwaway Postgres (or reuses the CI
service) via `require_polis_postgres` and applies the votes-schema migrations.
Skips cleanly when docker / a service is unavailable.
"""

import importlib.util
import os

import psycopg2
import pytest

from tests.conftest import require_polis_postgres

pytestmark = pytest.mark.integration


def _load_generator():
    """Import the standalone generator script by path (it is not a package)."""
    path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "scripts",
                     "generate_cold_start_clojure.py")
    )
    if not os.path.exists(path):
        pytest.skip(f"generator script not found: {path}")
    spec = importlib.util.spec_from_file_location("generate_cold_start_clojure", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCE_ZID = 990101
FAKE_ZID = 990102

# (pid, tid) -> list of vote values, one row per revote in chronological order.
# Two keys have 3 revotes, two have 2, two have 1: 3+2+1+2+1+3 = 12 source rows,
# 6 distinct (pid,tid) keys.
_REVOTES = {
    (0, 0): [-1, 1, -1],
    (0, 1): [1, -1],
    (1, 0): [-1],
    (1, 1): [1, 1],
    (2, 0): [-1],
    (2, 1): [1, -1, 1],
}


@pytest.fixture(scope="module")
def pg_url():
    with require_polis_postgres() as url:
        yield url


def _seed_source(url):
    """Insert the source vote history one row at a time (so seeding does NOT
    itself trip the single-statement rule), interleaving revotes across keys.

    `created` advances once per round-robin ROUND, not per row: rows within a
    round share the same `created` (same-ms ties), so the copy's
    `ORDER BY created ASC, ctid ASC` tiebreak is actually exercised — a copy
    that dropped the ctid ordering could reorder tied rows and fail the
    order-preservation assertion."""
    conn = psycopg2.connect(url)
    conn.autocommit = True
    created = 1_000_000
    n_rows = 0
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM votes_latest_unique WHERE zid IN (%s, %s)",
                        (SOURCE_ZID, FAKE_ZID))
            cur.execute("DELETE FROM votes WHERE zid IN (%s, %s)",
                        (SOURCE_ZID, FAKE_ZID))
            # Interleave: round-robin over keys by revote index so revotes are
            # spread through the timeline rather than clustered per key.
            max_revotes = max(len(v) for v in _REVOTES.values())
            for k in range(max_revotes):
                created += 1  # ties WITHIN a round, distinct across rounds
                for (pid, tid), votes in _REVOTES.items():
                    if k < len(votes):
                        cur.execute(
                            "INSERT INTO votes (zid, pid, tid, vote, created) "
                            "VALUES (%s, %s, %s, %s, %s)",
                            (SOURCE_ZID, pid, tid, votes[k], created),
                        )
                        n_rows += 1
    finally:
        conn.close()
    return n_rows


def _source_order(url):
    """Source (pid,tid,vote) tuples in copy order: created ASC, ctid ASC."""
    conn = psycopg2.connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pid, tid, vote FROM votes WHERE zid = %s "
                "ORDER BY created ASC, ctid ASC",
                (SOURCE_ZID,),
            )
            return cur.fetchall()
    finally:
        conn.close()


class TestCopyVotesFullHistory:
    def test_copy_round_trips_all_revotes_in_order(self, pg_url):
        gen = _load_generator()
        n_source = _seed_source(pg_url)
        assert n_source == sum(len(v) for v in _REVOTES.values()) == 12
        source_seq = _source_order(pg_url)

        # The call under test. Before the fix this raises CardinalityViolation
        # ("ON CONFLICT DO UPDATE command cannot affect row a second time");
        # after the fix it copies every row with the rule suppressed.
        conn = psycopg2.connect(pg_url)
        try:
            copied = gen.copy_votes_with_fresh_timestamps(conn, SOURCE_ZID, FAKE_ZID)
        finally:
            conn.close()

        assert copied == n_source  # ALL rows copied, incl. revotes

        verify = psycopg2.connect(pg_url)
        try:
            with verify.cursor() as cur:
                # (1) exact row count preserved (revotes not deduped).
                cur.execute("SELECT COUNT(*) FROM votes WHERE zid = %s", (FAKE_ZID,))
                assert cur.fetchone()[0] == n_source

                # (2) created strictly increasing, 10 ms apart, in source order.
                cur.execute(
                    "SELECT pid, tid, vote, created FROM votes WHERE zid = %s "
                    "ORDER BY created ASC",
                    (FAKE_ZID,),
                )
                rows = cur.fetchall()
                createds = [r[3] for r in rows]
                assert len(createds) == n_source
                assert all(b - a == 10 for a, b in zip(createds, createds[1:]))  # strictly incr
                assert len(set(createds)) == n_source
                # order matches source (created ASC, ctid ASC)
                assert [(r[0], r[1], r[2]) for r in rows] == source_seq

                # (3) every revote pair preserved with the right multiplicity.
                cur.execute(
                    "SELECT pid, tid, COUNT(*) FROM votes WHERE zid = %s "
                    "GROUP BY pid, tid",
                    (FAKE_ZID,),
                )
                counts = {(pid, tid): n for pid, tid, n in cur.fetchall()}
                assert counts == {k: len(v) for k, v in _REVOTES.items()}
        finally:
            verify.close()

        # Cleanup (harmless on a throwaway container; keeps a shared CI service tidy).
        cleanup = psycopg2.connect(pg_url)
        cleanup.autocommit = True
        try:
            with cleanup.cursor() as cur:
                cur.execute("DELETE FROM votes_latest_unique WHERE zid IN (%s, %s)",
                            (SOURCE_ZID, FAKE_ZID))
                cur.execute("DELETE FROM votes WHERE zid IN (%s, %s)",
                            (SOURCE_ZID, FAKE_ZID))
        finally:
            cleanup.close()

    def test_failed_copy_propagates_original_error_and_leaves_session_clean(self, pg_url):
        """If the bulk INSERT fails mid-copy, the ORIGINAL error must propagate
        (not a follow-on InFailedSqlTransaction from cleanup running inside the
        aborted transaction), and the session must come back clean: rule/trigger
        suppression reverted, connection usable."""
        gen = _load_generator()
        _seed_source(pg_url)

        conn = psycopg2.connect(pg_url)
        try:
            # Injected failure: NULL fake_zid violates votes.zid NOT NULL.
            with pytest.raises(psycopg2.IntegrityError):
                gen.copy_votes_with_fresh_timestamps(conn, SOURCE_ZID, None)

            # Same connection stays usable, with normal rule/trigger behavior.
            with conn.cursor() as cur:
                cur.execute("SELECT current_setting('session_replication_role')")
                assert cur.fetchone()[0] == "origin"
                cur.execute("SELECT COUNT(*) FROM votes WHERE zid = %s", (FAKE_ZID,))
                assert cur.fetchone()[0] == 0  # failed copy left nothing behind
        finally:
            conn.close()
