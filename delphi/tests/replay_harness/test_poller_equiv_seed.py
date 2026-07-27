"""Unit tests for the poller-equivalence harness — Stages A (schema+seeder)
and B (runners), MATH_POLLER_EQUIV_SPEC.md.

NO live Postgres/containers required by default: every test here is either
pure-Python or drives ``polismath.replay.poller_equiv`` against a fake
connection double that records ``execute(stmt, params)`` calls. A handful of
end-to-end tests are gated on ``POLLER_EQUIV_PG_URL`` and self-skip when it is
unset (mirrors ``tests/poller/test_integration_postgres.py``).
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa
from click.testing import CliRunner

from polismath.replay import poller_equiv as pe
from polismath.replay.types import CommentMeta, ModEvent, ReplayDataset
from polismath.utils.general import delphi_vote_to_postgres, postgres_vote_to_delphi

PG_URL = os.environ.get("POLLER_EQUIV_PG_URL")
_needs_live_pg = pytest.mark.skipif(
    not PG_URL, reason="POLLER_EQUIV_PG_URL not set — skipping live-postgres test"
)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _dataset() -> ReplayDataset:
    """A tiny hand-built dataset: 2 comments, 4 votes across 2 participants."""
    raw = [
        (1000, 1, 10, 1),  # AGREE (Delphi convention, +1)
        (1001, 1, 11, -1),  # DISAGREE
        (1002, 2, 10, 0),  # PASS
        (1003, 2, 11, 1),  # AGREE
    ]
    comments = {
        10: CommentMeta(tid=10, created_ms=900, is_meta=False),
        11: CommentMeta(tid=11, created_ms=901, is_meta=True),
    }
    return ReplayDataset.build(raw, comments=comments)


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def mappings(self):
        return self

    def first(self):
        return self._row


class _FakeConn:
    """Records every execute() call; never touches a real database."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def execute(self, stmt, params=None):
        self.calls.append((str(stmt), dict(params or {})))
        return _FakeResult(None)


# --------------------------------------------------------------------------- #
# Stage A.1 — schema DDL covers the exact columns both pollers' SQL uses.
# --------------------------------------------------------------------------- #
class TestSchemaColumns:
    def test_parse_schema_columns_finds_every_table(self):
        tables = pe.parse_schema_columns()
        expected_tables = {
            "conversations", "votes", "comments", "participants",
            "math_ticks", "math_main", "math_ptptstats", "math_bidtopid",
            "math_profile",
        }
        assert expected_tables <= set(tables)

    def test_votes_columns_cover_both_pollers_select(self):
        # clj: postgres.clj:132-145 poll / :197-212 conv-poll (SELECT *,
        # downstream only touches pid/tid/vote — conv_man.clj:202-203).
        # py: postgres.py:474-532 poll_votes / :534-567 poll_votes_since
        # (SELECT zid, tid, pid, vote, created).
        cols = set(pe.parse_schema_columns()["votes"])
        assert {"zid", "pid", "tid", "vote", "created"} <= cols

    def test_comments_columns_cover_both_pollers_select(self):
        # clj: postgres.clj:148-161 mod-poll / :214-225 conv-mod-poll, consumed
        # by math/conversation.clj:846-884 mod-update (:tid :is_meta :mod
        # :modified). py: postgres.py:569-604 poll_moderation_since (zid, tid,
        # modified, mod, is_meta) / :645-723 poll_moderation (tid, modified,
        # mod, is_meta).
        cols = set(pe.parse_schema_columns()["comments"])
        assert {"zid", "tid", "modified", "mod", "is_meta"} <= cols

    def test_conversations_is_fk_target_only(self):
        cols = set(pe.parse_schema_columns()["conversations"])
        assert cols == {"zid"}

    def test_math_main_columns(self):
        # postgres.clj:323-338 upload-math-main / :419-434 load-conv;
        # postgres.py:757-817 write_math_main / :725-755 load_math_main.
        cols = set(pe.parse_schema_columns()["math_main"])
        assert {
            "zid", "math_env", "data", "last_vote_timestamp",
            "caching_tick", "math_tick",
        } <= cols

    def test_math_bidtopid_and_ptptstats_columns(self):
        for table in ("math_bidtopid", "math_ptptstats"):
            cols = set(pe.parse_schema_columns()[table])
            assert {"zid", "math_env", "math_tick", "data"} <= cols, table

    def test_math_ticks_columns(self):
        # postgres.clj:292-295 inc-math-tick; postgres.py:910-939 increment_math_tick.
        cols = set(pe.parse_schema_columns()["math_ticks"])
        assert {"zid", "math_env", "math_tick", "caching_tick"} <= cols

    def test_participants_shim_columns(self):
        # SHIM: only postgres.py:701-713 poll_moderation's mod_out_ptpts query
        # needs this table to exist at all (see module docstring).
        cols = set(pe.parse_schema_columns()["participants"])
        assert {"pid", "zid", "mod"} <= cols

    def test_math_profile_columns(self):
        # clj-write-only: conv_man.clj:97-113 handle-profile-data ->
        # postgres.clj:340-348 upload-math-profile.
        cols = set(pe.parse_schema_columns()["math_profile"])
        assert {"zid", "math_env", "data"} <= cols

    def test_parser_ignores_constraint_lines(self):
        # UNIQUE(...) / FOREIGN KEY / PRIMARY KEY lines must never be mistaken
        # for column declarations.
        cols = pe.parse_schema_columns()["comments"]
        assert "UNIQUE" not in [c.upper() for c in cols]
        assert "FOREIGN" not in [c.upper() for c in cols]

    def test_parser_handles_nested_parens_in_column_types(self):
        # VARCHAR(999) / VARCHAR(1000) contain a comma-free nested paren pair;
        # a naive "split on any comma" parser would still work here, but a
        # naive "first ');' terminates the table" parser could be fooled by
        # now_as_millis() calls inside DEFAULT clauses — regression-guard that
        # every table in the real schema still parses to a plausible column
        # count (no table silently truncated).
        tables = pe.parse_schema_columns()
        assert len(tables["comments"]) >= 8
        assert len(tables["math_main"]) >= 6


# --------------------------------------------------------------------------- #
# Stage A.2 — vote sign convention.
# --------------------------------------------------------------------------- #
class TestVoteSignConvention:
    @pytest.mark.parametrize(
        "delphi_sign, raw_db_sign",
        [(1, -1), (-1, 1), (0, 0)],  # AGREE, DISAGREE, PASS
    )
    def test_delphi_vote_to_postgres_matches_raw_db_convention(self, delphi_sign, raw_db_sign):
        # migrations.sql:742-747 — RAW DB: -1=agree, +1=disagree, 0=pass.
        assert delphi_vote_to_postgres(delphi_sign) == raw_db_sign

    @pytest.mark.parametrize("delphi_sign", [1, -1, 0])
    def test_full_round_trip_dataset_to_db_to_py_ingress(self, delphi_sign):
        """dataset.sign (Delphi convention, driver.py:56) -> seeder flip ->
        RAW DB value -> py poll_votes ingress flip (postgres_vote_to_delphi,
        general.py:19-40) -> back to the original Delphi-convention sign."""
        raw_db_value = delphi_vote_to_postgres(delphi_sign)
        recovered = postgres_vote_to_delphi(raw_db_value)
        assert recovered == delphi_sign

    def test_insert_votes_flips_sign_to_raw_db_convention(self):
        ds = _dataset()
        conn = _FakeConn()
        n = pe.insert_votes(conn, ds, 0, ds.n)

        assert n == ds.n
        # ATOMIC per batch (see test_insert_votes_is_one_atomic_statement's
        # docstring for the root-cause rationale): exactly ONE execute()
        # call carries every row's VALUES tuple, not one call per row.
        assert len(conn.calls) == 1
        sql, params = conn.calls[0]
        assert "INSERT INTO votes" in sql
        assert sql.count("VALUES") == 1
        # First vote: sign=+1 (AGREE, Delphi) -> raw DB must be -1.
        assert params["vote0"] == -1
        assert params["pid0"] == ds.votes[0].pid
        assert params["tid0"] == ds.votes[0].tid
        assert params["created0"] == ds.votes[0].t_ms
        assert params["zid"] == pe.DEFAULT_ZID

        # Third vote (index 2, sorted order) is the PASS (sign=0) -> raw 0.
        pass_idx = next(i for i, v in enumerate(ds.votes) if v.sign == 0)
        assert params[f"vote{pass_idx}"] == 0

    def test_insert_votes_is_one_atomic_statement(self):
        """ROOT CAUSE #5 (2026-07-24 live-debug task, discovered AFTER root
        cause #4's cut-boundary fix): a per-row execute() loop under
        AUTOCOMMIT (the harness's default isolation level, ``build_clj_env``
        et al.) lets a CONCURRENTLY-RUNNING poller (both engines poll every
        ~1s regardless of harness batch boundaries — production behavior,
        unrelated to :func:`snap_cuts_past_timestamp_ties`) observe a
        PARTIAL batch mid-insert. If that partial snapshot's max ``created``
        value ties with a not-yet-committed row's ``created`` (extremely
        common in the vw dataset — most timestamps are shared by 2-8 votes,
        module docstring), the STRICT ``created > watermark`` comparison
        (both pollers, verbatim SQL) permanently drops that row the instant
        the watermark advances past it — reproduced live: pid=33's LAST vote
        (index 2050, comfortably INSIDE batch 3's [1757, 2349) range, nowhere
        near either cut edge) went missing from clj-ref's own
        ``user-vote-counts``, undercounting by exactly 1, even AFTER the cut
        boundaries themselves were tie-free.

        Building ONE multi-row INSERT statement (as opposed to N single-row
        executes, whether looped directly or via DBAPI executemany — which
        for psycopg2 is ITSELF just a client-side loop of single-row
        executes, not one atomic statement) makes the whole batch atomic
        under Postgres MVCC: any concurrent reader sees either NONE or ALL of
        a batch's rows, never a subset — eliminating the intra-batch race
        entirely (the snap-cuts fix separately handles the CROSS-batch edge
        case, where the tie spans two batches rather than sitting inside
        one)."""
        ds = _dataset()
        conn = _FakeConn()
        pe.insert_votes(conn, ds, 0, ds.n)
        assert len(conn.calls) == 1

    def test_insert_votes_slot_slicing(self):
        ds = _dataset()
        conn = _FakeConn()
        n = pe.insert_votes(conn, ds, 0, 2)
        assert n == 2
        assert len(conn.calls) == 1

        conn2 = _FakeConn()
        n2 = pe.insert_votes(conn2, ds, 2, ds.n)
        assert n2 == ds.n - 2
        assert len(conn2.calls) == 1

    def test_insert_votes_empty_slice_issues_no_statement(self):
        ds = _dataset()
        conn = _FakeConn()
        n = pe.insert_votes(conn, ds, ds.n, ds.n)
        assert n == 0
        assert len(conn.calls) == 0


# --------------------------------------------------------------------------- #
# insert_mod_events — the moderation-stream analogue of insert_votes. Needed
# to actually exercise pc-meta-02's "interleave-by-timestamp" moderation
# schedule (2026-07-24 session 2: previously ONLY the CSV-based driver
# (schedule.py's slice_schedule) applied mod_events; the live poller-equiv
# feeder never wired this in at all — seed_conversation's own docstring
# flagged it as "the feeder's job", but Stage C never built it). Mirrors
# slice_schedule's EXACT time-windowing semantics (schedule.py:206-225) so
# both drivers attach a mod_event to the same batch, and insert_votes'
# atomicity fix (root cause #5) — one multi-row UPDATE, never a per-row loop.
# --------------------------------------------------------------------------- #
def _dataset_with_mods() -> ReplayDataset:
    raw = [
        (1000, 1, 10, 1), (1001, 1, 11, -1), (1002, 2, 10, 0), (1003, 2, 11, 1),
    ]
    comments = {
        10: CommentMeta(tid=10, created_ms=900, is_meta=False),
        11: CommentMeta(tid=11, created_ms=901, is_meta=False),
    }
    mod_events = [
        ModEvent(t_ms=1000, tid=10, mod=-1),  # lands in the FIRST window (<=1001)
        ModEvent(t_ms=1001, tid=11, mod=1),   # ALSO the first window (boundary-inclusive)
        ModEvent(t_ms=1002, tid=10, mod=1),   # second window (>1001, <=1003) — revises tid=10
        ModEvent(t_ms=1500, tid=11, mod=-1),  # AFTER the last cut (1003) — dropped, like tail votes
    ]
    return ReplayDataset.build(raw, comments=comments, mod_events=mod_events)


class TestInsertModEvents:
    def test_time_window_matches_slice_schedule_semantics(self):
        """Mirrors schedule.py's slice_schedule: an event lands in the batch
        whose cut_time_ms is the FIRST to reach it — ``prev_time_ms < t_ms
        <= cut_time_ms``, ``prev_time_ms=None`` meaning no floor."""
        ds = _dataset_with_mods()
        conn = _FakeConn()
        n = pe.insert_mod_events(conn, ds, None, 1001, zid=1)
        assert n == 2  # tid=10@1000 and tid=11@1001
        assert len(conn.calls) == 1
        sql, params = conn.calls[0]
        assert "UPDATE comments" in sql
        assert sql.count("VALUES") == 1
        assert params["zid"] == 1

    def test_second_window_excludes_first_windows_events(self):
        ds = _dataset_with_mods()
        conn = _FakeConn()
        n = pe.insert_mod_events(conn, ds, 1001, 1003, zid=1)
        assert n == 1  # only tid=10@1002

    def test_events_after_the_final_cut_are_dropped(self):
        ds = _dataset_with_mods()
        conn = _FakeConn()
        # Even a huge upper bound only reaches events with t_ms <= cut_time_ms
        # given as the argument — the "after the last real cut" drop is the
        # CALLER's job (never invoking this with a cut past the schedule),
        # exactly like insert_votes' tail-votes convention.
        n = pe.insert_mod_events(conn, ds, 1003, 1400, zid=1)
        assert n == 0
        assert len(conn.calls) == 0

    def test_empty_window_issues_no_statement(self):
        ds = _dataset_with_mods()
        conn = _FakeConn()
        n = pe.insert_mod_events(conn, ds, 1600, 1700, zid=1)
        assert n == 0
        assert len(conn.calls) == 0

    def test_no_mod_events_at_all_issues_no_statement(self):
        """The common case (vw has none) — must be a total no-op, never even
        touching the connection."""
        ds = _dataset()  # no mod_events passed -> defaults to ()
        conn = _FakeConn()
        n = pe.insert_mod_events(conn, ds, None, 10_000, zid=1)
        assert n == 0
        assert len(conn.calls) == 0

    def test_multiple_events_for_the_same_tid_in_one_window_keep_the_latest(self):
        """Two mod_events for the SAME tid landing in the SAME window (e.g. a
        moderator flip-flopping within one batch) must produce exactly ONE
        VALUES row for that tid — Postgres's UPDATE...FROM semantics are
        UNSPECIFIED when the FROM subquery has multiple rows matching the
        same target row, so de-duplication (latest t_ms wins, mirroring
        votes' latest-vote-wins) must happen BEFORE the SQL is built, not be
        left to the database."""
        raw = [(1000, 1, 10, 1)]
        comments = {10: CommentMeta(tid=10, created_ms=900)}
        mod_events = [
            ModEvent(t_ms=1000, tid=10, mod=-1),
            ModEvent(t_ms=1001, tid=10, mod=1),  # supersedes the -1 above
        ]
        ds = ReplayDataset.build(raw, comments=comments, mod_events=mod_events)
        conn = _FakeConn()
        n = pe.insert_mod_events(conn, ds, None, 2000, zid=1)
        assert n == 2  # raw event count returned (mirrors insert_votes' row count)
        sql, params = conn.calls[0]
        assert sql.count("VALUES (") == 1  # exactly ONE tuple in the VALUES list
        # The LATEST (t_ms=1001) mod value must be the one sent.
        mod_values = [v for k, v in params.items() if k.startswith("mod") and not k.startswith("modified")]
        assert mod_values == [1]


# --------------------------------------------------------------------------- #
# Stage A.2/A.3 — seeder structure + idempotency (fake-conn, no real DB).
# --------------------------------------------------------------------------- #
class TestSeedConversation:
    def test_seed_conversation_inserts_conversation_and_all_comments(self):
        ds = _dataset()
        conn = _FakeConn()
        pe.seed_conversation(conn, ds, zid=7)

        conv_calls = [c for c in conn.calls if "INSERT INTO conversations" in c[0]]
        comment_calls = [c for c in conn.calls if "INSERT INTO comments" in c[0]]
        assert len(conv_calls) == 1
        assert conv_calls[0][1]["zid"] == 7
        assert len(comment_calls) == len(ds.comments)

        by_tid = {c[1]["tid"]: c[1] for c in comment_calls}
        assert by_tid[10]["is_meta"] is False
        assert by_tid[11]["is_meta"] is True
        # Placeholder text only — never real content.
        assert by_tid[10]["txt"] == "comment 10"

    def test_seed_conversation_sql_is_idempotent_by_construction(self):
        """Both inserts must be conflict-safe (ON CONFLICT ... DO NOTHING) so
        re-seeding an already-seeded conversation never raises a duplicate-key
        error — required by the spec's "idempotent-safe or fails loudly"."""
        ds = _dataset()
        conn = _FakeConn()
        pe.seed_conversation(conn, ds, zid=1)
        for sql, _params in conn.calls:
            assert "ON CONFLICT" in sql
            assert "DO NOTHING" in sql

    def test_seed_conversation_called_twice_produces_same_call_shape(self):
        """Calling seed_conversation twice (e.g. a retried seed) must not
        change the SET of statements issued — behavioral idempotency is
        verified against a live DB in TestLiveEndToEnd; this checks the
        fake-conn call shape is stable across repeats (no accumulation of
        distinct non-conflict-safe statements)."""
        ds = _dataset()
        conn = _FakeConn()
        pe.seed_conversation(conn, ds, zid=1)
        first_pass = list(conn.calls)
        conn.calls.clear()
        pe.seed_conversation(conn, ds, zid=1)
        second_pass = list(conn.calls)
        assert len(first_pass) == len(second_pass)
        assert [c[0] for c in first_pass] == [c[0] for c in second_pass]


# --------------------------------------------------------------------------- #
# Stage B.1/B.2 — runner env/cmd assembly (NO subprocess launches).
# --------------------------------------------------------------------------- #
class TestRunnerEnvAssembly:
    def test_build_clj_env_sets_required_vars(self):
        env = pe.build_clj_env(
            database_url="postgresql://x/polis_equiv", math_env="clj-ref",
            poll_from_days_ago=10000, base_env={"PATH": "/usr/bin", "KEEP": "1"},
        )
        # DATABASE_URL scheme is translated postgresql:// -> postgres:// — see
        # test_build_clj_env_translates_postgresql_scheme_to_postgres below for
        # the root-cause rationale (Hikari's postgres.clj regex only matches a
        # literal "postgres://" prefix; "postgresql://" silently destructures
        # to all-nil host/port/user/pass -> ConnectException).
        assert env["DATABASE_URL"] == "postgres://x/polis_equiv"
        assert env["MATH_ENV"] == "clj-ref"
        assert env["POLL_FROM_DAYS_AGO"] == "10000"
        # base_env is preserved, not clobbered wholesale.
        assert env["PATH"] == "/usr/bin"
        assert env["KEEP"] == "1"

    def test_build_clj_env_translates_postgresql_scheme_to_postgres(self):
        """ROOT CAUSE #1 (2026-07-24 live debug): create_equiv_db/_url_with_dbname
        always hand back a SQLAlchemy-style ``postgresql://`` URL (preserving
        whatever scheme --admin-url used). Clojure's ``create-hikari-datasource``
        (postgres.clj:18) parses DATABASE_URL with
        ``#"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\\d+))?/(.+)"`` — a regex that
        requires the LITERAL prefix "postgres://", not "postgresql://". Feeding
        it "postgresql://..." makes ``re-matches`` return nil, so the
        destructured user/password/host/port/db are ALL nil, producing
        ``jdbc:postgresql://:5432/`` (empty host, wrong port) and a
        ConnectException — reproduced live: `clojure -M:run full` crashed with
        exactly this stack trace against a real Postgres until the scheme was
        corrected to postgres://."""
        for given in (
            "postgresql://u:p@127.0.0.1:15432/polis_equiv",
            "postgresql+psycopg2://u:p@127.0.0.1:15432/polis_equiv",
        ):
            env = pe.build_clj_env(database_url=given, math_env="clj-ref", base_env={})
            assert env["DATABASE_URL"] == "postgres://u:p@127.0.0.1:15432/polis_equiv"

    def test_build_clj_env_formats_a_click_float_default_as_a_bare_integer(self):
        """ROOT CAUSE #2 (2026-07-24 live debug): the CLI's
        ``--poll-from-days-ago`` option is ``type=float, default=10000`` — Click
        resolves that default THROUGH the type, so the value the CLI actually
        passes to build_clj_env is the FLOAT 10000.0, not the int 10000 (every
        existing test in this class calls build_clj_env with a bare int literal,
        which never exercised this path). ``str(10000.0)`` is "10000.0", and
        Clojure's ``->long`` config parser (config.clj) is
        ``Long/parseLong`` — which THROWS on "10000.0", caught + logged as a
        warning, returning nil. ``deep-merge`` then REPLACES (not falls back to)
        the default 10 with that nil, and ``polismath.poller/poll`` computes
        ``(* nil 1000 60 60 24)`` — reproduced live as
        ``Execution error (NullPointerException) at polismath.poller/poll
        (poller.clj:15)``, silently swallowed inside the async go-loop's
        result channel (never printed) until the DATABASE_URL fix above let the
        Postgres component actually start."""
        env = pe.build_clj_env(
            database_url="postgresql://x/polis_equiv", math_env="clj-ref",
            poll_from_days_ago=10000.0, base_env={},
        )
        assert env["POLL_FROM_DAYS_AGO"] == "10000"

    def test_build_clj_env_rounds_a_fractional_days_ago_to_the_nearest_integer(self):
        env = pe.build_clj_env(
            database_url="postgresql://x/polis_equiv", math_env="clj-ref",
            poll_from_days_ago=3.6, base_env={},
        )
        assert env["POLL_FROM_DAYS_AGO"] == "4"

    def test_build_clj_env_defaults_logging_level_to_info(self):
        """RUNNER EVIDENCE (2026-07-24 live-debug task, REQUIRED FIX #3):
        the clj container's default logging level is :warn (config.clj
        defaults map) — at :warn, EVERY application-level trace (poll
        cycles, conv-manager batch processing, recompute completion) is
        silently suppressed, leaving a captured runner log with nothing but
        HikariCP connection-pool heartbeats. This is not cosmetic: a stalled
        or slow-to-converge container is INDISTINGUISHABLE from a crashed
        one without this. ``LOGGING_LEVEL`` is the env var
        ``polismath.components.logger`` honors (config.clj's
        ``:logging-level`` rule -> ``get-in config [:logging :level]``)."""
        env = pe.build_clj_env(
            database_url="postgresql://x/polis_equiv", math_env="clj-ref", base_env={},
        )
        assert env["LOGGING_LEVEL"] == "info"

    def test_build_clj_env_logging_level_is_overridable(self):
        env = pe.build_clj_env(
            database_url="postgresql://x/polis_equiv", math_env="clj-ref", base_env={},
            logging_level="debug",
        )
        assert env["LOGGING_LEVEL"] == "debug"

    def test_build_py_env_sets_required_vars(self):
        env = pe.build_py_env(
            database_url="postgresql://x/polis_equiv", math_env="py-shadow",
            poll_from_days_ago=10000,
            base_env={},
        )
        assert env["DATABASE_URL"] == "postgresql://x/polis_equiv"
        assert env["MATH_ENV"] == "py-shadow"
        assert env["POLL_FROM_DAYS_AGO"] == "10000"

    def test_build_py_env_forces_postgresql_scheme(self):
        """Symmetric guard to the clj-side scheme fix: SQLAlchemy/psycopg2 no
        longer accept the bare "postgres://" scheme (dropped in SQLAlchemy
        1.4+, raises 'plain "postgres" dialect is no longer supported') — so
        even if a caller's admin-url happened to use "postgres://" (the SAME
        scheme the clj side needs), the py side must always get
        "postgresql://"."""
        env = pe.build_py_env(
            database_url="postgres://u:p@127.0.0.1:15432/polis_equiv",
            math_env="py-shadow", base_env={},
        )
        assert env["DATABASE_URL"] == "postgresql://u:p@127.0.0.1:15432/polis_equiv"

    def test_build_py_env_defaults_database_ssl_mode_to_disable(self):
        """ROOT CAUSE #3 (2026-07-24 live debug): ``scripts/math_poller.py``
        never loads a .env file — ``PollerConfig.from_env``'s DATABASE_URL
        comes straight from the process env this harness constructs.
        ``polismath.database.postgres.PostgresClient`` defaults ``ssl_mode`` to
        ``os.environ.get("DATABASE_SSL_MODE", "require")`` (postgres.py:92)
        when the caller (math_poller.py's ``_build_service``) doesn't pass one
        explicitly — which it doesn't. Reproduced live: the py poller looped
        forever on ``psycopg2.OperationalError: ... server does not support
        SSL, but SSL was required`` against the harness's local (non-SSL)
        Postgres target, until DATABASE_SSL_MODE=disable was set explicitly."""
        env = pe.build_py_env(database_url="postgresql://x/polis_equiv", math_env="e", base_env={})
        assert env["DATABASE_SSL_MODE"] == "disable"

    def test_build_py_env_database_ssl_mode_is_overridable(self):
        env = pe.build_py_env(
            database_url="postgresql://x/polis_equiv", math_env="e", base_env={},
            database_ssl_mode="require",
        )
        assert env["DATABASE_SSL_MODE"] == "require"

    def test_clj_container_runner_cmd_cwd_env(self):
        runner = pe.CljContainerRunner(
            database_url="postgresql://x/polis_equiv", math_env="clj-ref",
            base_env={},
        )
        assert runner.cmd == ["clojure", "-M:run", "full"]
        assert runner.cwd == pe._MATH_ROOT
        assert runner.cwd.name == "math"
        assert runner.env["DATABASE_URL"] == "postgres://x/polis_equiv"
        assert runner.env["MATH_ENV"] == "clj-ref"
        assert runner.env["POLL_FROM_DAYS_AGO"] == "10000"
        assert runner._proc is None  # never started
        assert runner.pid is None
        assert runner.is_alive() is False

    def test_py_poller_runner_cmd_cwd_env(self):
        runner = pe.PyPollerRunner(
            database_url="postgresql://x/polis_equiv", math_env="py-shadow",
            base_env={},
        )
        assert runner.cmd == ["uv", "run", "python", "-m", "polismath.poller"]
        # Equality with _DELPHI_ROOT is the contract; asserting the directory
        # NAME was layout-fragile — CI mounts the delphi tree at /app, where
        # .name == "app" (python-ci run 30071088647, 2026-07-24).
        assert runner.cwd == pe._DELPHI_ROOT
        assert runner.env["MATH_ENV"] == "py-shadow"
        assert runner.env["DATABASE_SSL_MODE"] == "disable"
        assert runner._proc is None

    def test_math_root_and_delphi_root_are_siblings(self):
        assert pe._MATH_ROOT.parent == pe._DELPHI_ROOT.parent


class TestSubprocessRunnerKill:
    """kill() lifecycle via a mocked Popen — no real process is ever spawned."""

    def test_kill_is_noop_when_never_started(self):
        runner = pe._SubprocessRunner(["true"], cwd=Path("."), env={})
        runner.kill(grace=0.01)  # must not raise

    def test_kill_is_noop_when_already_exited(self):
        runner = pe._SubprocessRunner(["true"], cwd=Path("."), env={})
        fake_proc = MagicMock()
        fake_proc.poll.return_value = 0  # already exited
        runner._proc = fake_proc
        runner.kill(grace=0.01)
        fake_proc.terminate.assert_not_called()
        fake_proc.kill.assert_not_called()

    def test_kill_sigterm_succeeds_without_sigkill(self):
        runner = pe._SubprocessRunner(["true"], cwd=Path("."), env={})
        fake_proc = MagicMock()
        fake_proc.poll.return_value = None
        fake_proc.wait.return_value = 0  # terminate() succeeds within grace
        runner._proc = fake_proc
        runner.kill(grace=5.0)
        fake_proc.terminate.assert_called_once()
        fake_proc.kill.assert_not_called()

    def test_kill_escalates_to_sigkill_after_grace_timeout(self):
        runner = pe._SubprocessRunner(["true"], cwd=Path("."), env={})
        fake_proc = MagicMock()
        fake_proc.poll.return_value = None
        fake_proc.wait.side_effect = [
            subprocess.TimeoutExpired(cmd="true", timeout=0.01),
            0,
        ]
        runner._proc = fake_proc
        runner.kill(grace=0.01)
        fake_proc.terminate.assert_called_once()
        fake_proc.kill.assert_called_once()
        assert fake_proc.wait.call_count == 2


# --------------------------------------------------------------------------- #
# RUNNER EVIDENCE — capture stdout+stderr to a log file under --out (real
# short-lived subprocesses; no PIPE is left undrained). REQUIRED FIX #3 from
# the 2026-07-24 live-debug task: without this, a runner crashing at startup
# (e.g. root causes #1-#3 above) leaves NO trace anywhere the harness looks.
# --------------------------------------------------------------------------- #
class TestSubprocessRunnerLogCapture:
    def test_log_path_none_preserves_pipe_behavior(self, tmp_path):
        """Default (no log_path) — same PIPE-based behavior the standalone
        `run-clj`/`run-py` CLI subcommands stream from (unchanged contract)."""
        runner = pe._SubprocessRunner(
            ["sh", "-c", "echo hi"], cwd=tmp_path, env={"PATH": os.environ["PATH"]},
        )
        proc = runner.start()
        assert proc.stdout is not None
        out = proc.stdout.read()
        proc.wait(timeout=5)
        assert "hi" in out

    def test_log_path_captures_stdout_and_stderr_to_file(self, tmp_path):
        log_path = tmp_path / "clj-ref.runner.log"
        runner = pe._SubprocessRunner(
            ["sh", "-c", "echo out-line; echo err-line 1>&2"],
            cwd=tmp_path, env={"PATH": os.environ["PATH"]}, log_path=log_path,
        )
        proc = runner.start()
        assert proc.stdout is None  # not piped — went straight to the file
        proc.wait(timeout=5)
        runner.kill(grace=0.01)  # closes the log file handle
        text = log_path.read_text()
        assert "out-line" in text
        assert "err-line" in text

    def test_log_path_parent_dir_is_created(self, tmp_path):
        log_path = tmp_path / "nested" / "dir" / "py-shadow.runner.log"
        runner = pe._SubprocessRunner(
            ["sh", "-c", "echo hi"], cwd=tmp_path, env={"PATH": os.environ["PATH"]},
            log_path=log_path,
        )
        runner.start().wait(timeout=5)
        runner.kill(grace=0.01)
        assert log_path.exists()

    def test_restart_appends_rather_than_truncating(self, tmp_path):
        """A seam restart must not erase the PRE-seam evidence — the new
        process's runner reuses the SAME log path and must append."""
        log_path = tmp_path / "py-shadow.runner.log"
        first = pe._SubprocessRunner(
            ["sh", "-c", "echo first-run"], cwd=tmp_path, env={"PATH": os.environ["PATH"]},
            log_path=log_path,
        )
        first.start().wait(timeout=5)
        first.kill(grace=0.01)

        second = pe._SubprocessRunner(
            ["sh", "-c", "echo second-run"], cwd=tmp_path, env={"PATH": os.environ["PATH"]},
            log_path=log_path,
        )
        second.start().wait(timeout=5)
        second.kill(grace=0.01)

        text = log_path.read_text()
        assert "first-run" in text
        assert "second-run" in text

    def test_runner_constructors_accept_log_path(self, tmp_path):
        log_path = tmp_path / "clj-ref.runner.log"
        runner = pe.CljContainerRunner(
            database_url="postgresql://x/polis_equiv", math_env="clj-ref",
            base_env={}, log_path=log_path,
        )
        assert runner.log_path == log_path

        py_log = tmp_path / "py-shadow.runner.log"
        py_runner = pe.PyPollerRunner(
            database_url="postgresql://x/polis_equiv", math_env="py-shadow",
            base_env={}, log_path=py_log,
        )
        assert py_runner.log_path == py_log


# --------------------------------------------------------------------------- #
# Stage B.3 — wait_for_tick (mocked connection, no real sleeping).
# --------------------------------------------------------------------------- #
class _FakeClock:
    def __init__(self, start: float = 0.0, step: float = 1.0):
        self.t = start
        self.step = step
        self.sleep_calls = 0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleep_calls += 1
        self.t += self.step


class _SequenceConn:
    """Returns rows from a fixed sequence, one per execute() call (clamped to
    the last row once exhausted)."""

    def __init__(self, rows):
        self._rows = list(rows)
        self.n_calls = 0

    def execute(self, stmt, params=None):
        idx = min(self.n_calls, len(self._rows) - 1)
        self.n_calls += 1
        return _FakeResult(self._rows[idx])


class TestWaitForTick:
    def test_returns_row_once_predicate_matches(self):
        conn = _SequenceConn([None, {"caching_tick": 1}, {"caching_tick": 2}])
        clock = _FakeClock()
        row = pe.wait_for_tick(
            conn, "clj-ref", 1, lambda r: r["caching_tick"] >= 2,
            timeout=100, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
        )
        assert row == {"caching_tick": 2}
        assert conn.n_calls == 3

    def test_returns_none_on_timeout(self):
        conn = _SequenceConn([{"caching_tick": 0}])
        clock = _FakeClock(start=0.0, step=1.0)
        row = pe.wait_for_tick(
            conn, "clj-ref", 1, lambda r: r["caching_tick"] >= 99,
            timeout=3, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
        )
        assert row is None
        assert clock.sleep_calls == 3

    def test_none_row_never_satisfies_predicate(self):
        """A predicate that doesn't guard against None must not raise before
        the row exists (no math_main row yet == a cold zid)."""
        conn = _SequenceConn([None, None, {"caching_tick": 1}])
        clock = _FakeClock()
        row = pe.wait_for_tick(
            conn, "clj-ref", 1, lambda r: r.get("caching_tick") == 1,
            timeout=100, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
        )
        assert row == {"caching_tick": 1}

    def test_uses_zid_and_math_env_in_query_params(self):
        captured = {}

        class _CapturingConn:
            def execute(self, stmt, params=None):
                captured.update(params or {})
                return _FakeResult({"caching_tick": 1})

        clock = _FakeClock()
        pe.wait_for_tick(
            _CapturingConn(), "py-shadow", 42, lambda r: True,
            timeout=1, sleep=clock.sleep, now=clock.now,
        )
        assert captured == {"zid": 42, "math_env": "py-shadow"}


# --------------------------------------------------------------------------- #
# Quirk Q19 harness-level mitigation — wait-for-first-poll-cycle gate.
# ``conv_man.clj``'s ``queue-message-batch!`` has an unsynchronized
# check-then-act race spinning up TWO independent conv-actors for a
# brand-new zid whenever the :votes and :moderation pollers BOTH discover
# data for it on their very first poll tick (near-guaranteed by this
# harness's OWN timing: seed data + batch 0 land in the DB before the JVM
# even finishes booting). ``_poll_cycle_signal_seen``/
# ``wait_for_first_poll_cycle`` delay feeding batch 0 until we've observed
# the clj runner log show AT LEAST ONE completed ``:votes`` poll cycle — by
# construction that cycle found ZERO rows (we haven't inserted any yet), so
# NO queue-message-batch! call happens from the votes side at all, meaning
# only ONE poller (moderation, discovering the already-seeded comments) can
# EVER be first to create the actor — no race, regardless of scheduling.
# ``polismath.poller/poll`` (poller.clj:24) emits ``"Polling <type> >
# <watermark>"`` UNCONDITIONALLY on every cycle (found rows or not), which
# is what makes this a reliable, log-based signal rather than a fixed sleep.
# --------------------------------------------------------------------------- #
class TestPollCycleSignalSeen:
    def test_absent_when_log_is_empty(self):
        assert pe._poll_cycle_signal_seen("") is False

    def test_absent_when_log_has_only_hikari_chatter(self):
        text = "05:19:54.132 [main] INFO com.zaxxer.hikari.HikariDataSource - HikariPool-1 - Start completed.\n"
        assert pe._poll_cycle_signal_seen(text) is False

    def test_present_after_a_real_poll_line(self):
        text = "2026-07-24T03:57:30.497Z device-137.home INFO [polismath.poller:24] - Polling :votes > 1732029094000\n"
        assert pe._poll_cycle_signal_seen(text) is True

    def test_message_type_is_selective(self):
        text = "INFO [polismath.poller:24] - Polling :moderation > 123\n"
        assert pe._poll_cycle_signal_seen(text, message_type="votes") is False
        assert pe._poll_cycle_signal_seen(text, message_type="moderation") is True

    def test_default_message_type_is_votes(self):
        text = "INFO [polismath.poller:24] - Polling :votes > 0\n"
        assert pe._poll_cycle_signal_seen(text) is True


class TestWaitForFirstPollCycle:
    def test_observed_true_once_the_signal_appears(self, tmp_path):
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("boot chatter only\n")
        clock = _FakeClock()

        # Simulate the signal landing mid-wait by mutating the file from
        # inside a custom sleep callback — the poll loop re-reads the file
        # on every iteration, exactly like the real subprocess appending to
        # it over time.
        def sleep_then_append(seconds):
            clock.sleep(seconds)
            log_path.write_text(log_path.read_text() + "Polling :votes > 0\n")

        result = pe.wait_for_first_poll_cycle(
            log_path, timeout=10, poll_interval=1.0, sleep=sleep_then_append, now=clock.now,
        )
        assert result["observed"] is True
        assert result["elapsed_s"] >= 0

    def test_observed_false_on_timeout(self, tmp_path):
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("boot chatter only, never a poll line\n")
        clock = _FakeClock()
        result = pe.wait_for_first_poll_cycle(
            log_path, timeout=3, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
        )
        assert result["observed"] is False
        assert result["reason"] == "timeout"

    def test_none_log_path_is_immediately_not_observed(self):
        clock = _FakeClock()
        result = pe.wait_for_first_poll_cycle(
            None, timeout=10, sleep=clock.sleep, now=clock.now,
        )
        assert result["observed"] is False
        assert clock.sleep_calls == 0  # never even waits — nothing to poll

    def test_missing_log_file_is_treated_as_empty_not_an_error(self, tmp_path):
        log_path = tmp_path / "never-created.log"
        clock = _FakeClock()
        result = pe.wait_for_first_poll_cycle(
            log_path, timeout=2, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
        )
        assert result["observed"] is False
        assert result["reason"] == "timeout"

    def test_already_present_signal_returns_immediately_without_sleeping(self, tmp_path):
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("...\nPolling :votes > 0\n...\n")
        clock = _FakeClock()
        result = pe.wait_for_first_poll_cycle(
            log_path, timeout=10, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
        )
        assert result["observed"] is True
        assert clock.sleep_calls == 0

    def test_start_offset_ignores_stale_pre_offset_content(self, tmp_path):
        """ROOT CAUSE (found live, 2026-07-24 session 2): the runner log is
        opened in APPEND mode (:class:`_SubprocessRunner`, so a seam
        restart's post-restart output lands in the SAME file as the
        pre-restart run). A FRESH container's cold-start gate check must
        NOT be satisfied by a "Polling :votes >" line left over from a
        PREVIOUS attempt sitting earlier in the SAME file — that content
        proves nothing about whether THIS instance has polled yet. Without
        ``start_offset``, the gate is a no-op after the first-ever run in a
        given --out directory (silently defeating the whole Q19
        mitigation) — reproduced live: the mitigation's very first
        real-world run still hit quirk Q19, because the gate was satisfied
        instantly by stale text."""
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("Polling :votes > 999\n")  # stale, from a PRIOR attempt
        offset = log_path.stat().st_size
        clock = _FakeClock()
        result = pe.wait_for_first_poll_cycle(
            log_path, timeout=3, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
            start_offset=offset,
        )
        assert result["observed"] is False
        assert result["reason"] == "timeout"

    def test_start_offset_still_observes_genuinely_new_content(self, tmp_path):
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("stale boot chatter from a prior attempt\n")
        offset = log_path.stat().st_size

        def sleep_then_append(seconds):
            with open(log_path, "a") as fh:
                fh.write("Polling :votes > 0\n")

        clock = _FakeClock()
        result = pe.wait_for_first_poll_cycle(
            log_path, timeout=10, poll_interval=1.0, sleep=sleep_then_append, now=clock.now,
            start_offset=offset,
        )
        assert result["observed"] is True

    def test_start_offset_defaults_to_zero_reading_the_whole_file(self, tmp_path):
        """Backward-compatible default — every EXISTING caller/test above
        (offset unspecified) reads from the start of the file, unchanged."""
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("Polling :votes > 0\n")
        clock = _FakeClock()
        result = pe.wait_for_first_poll_cycle(
            log_path, timeout=10, poll_interval=1.0, sleep=clock.sleep, now=clock.now,
        )
        assert result["observed"] is True


# --------------------------------------------------------------------------- #
# CLI stub smoke test — the click group loads and exposes the stage A/B
# subcommands (no real seeding/subprocess is exercised here).
# --------------------------------------------------------------------------- #
_CLI_PATH = Path(__file__).resolve().parents[2] / "scripts" / "poller_equiv.py"


def _cli_module():
    spec = importlib.util.spec_from_file_location("poller_equiv_cli", _CLI_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestCliStub:
    def test_cli_help_lists_stage_ab_subcommands(self):
        mod = _cli_module()
        result = CliRunner().invoke(mod.cli, ["--help"])
        assert result.exit_code == 0
        assert "seed" in result.output
        assert "run-clj" in result.output
        assert "run-py" in result.output


# --------------------------------------------------------------------------- #
# Live-Postgres end-to-end (gated — self-skips without POLLER_EQUIV_PG_URL).
# --------------------------------------------------------------------------- #
@_needs_live_pg
class TestLiveEndToEnd:
    """Exercises create_equiv_db + seed_conversation + insert_votes against a
    REAL Postgres server. Set POLLER_EQUIV_PG_URL to an admin connection
    (e.g. postgresql://postgres:postgres@localhost:15432/postgres) pointing at
    a database OTHER than the equiv db itself to run these."""

    DBNAME = "polis_equiv_test"

    def test_create_seed_and_reseed_is_idempotent(self):
        target_url = pe.create_equiv_db(PG_URL, dbname=self.DBNAME)
        engine = sa.create_engine(target_url)
        try:
            ds = _dataset()
            with engine.begin() as conn:
                pe.seed_conversation(conn, ds, zid=1)
                pe.seed_conversation(conn, ds, zid=1)  # re-seed: must not raise

            with engine.connect() as conn:
                n_convs = conn.execute(
                    sa.text("SELECT COUNT(*) FROM conversations WHERE zid = 1")
                ).scalar()
                n_comments = conn.execute(
                    sa.text("SELECT COUNT(*) FROM comments WHERE zid = 1")
                ).scalar()
            assert n_convs == 1
            assert n_comments == len(ds.comments)
        finally:
            engine.dispose()

    def test_insert_votes_lands_raw_db_sign_convention(self):
        target_url = pe.create_equiv_db(PG_URL, dbname=self.DBNAME)
        engine = sa.create_engine(target_url)
        try:
            ds = _dataset()
            with engine.begin() as conn:
                pe.seed_conversation(conn, ds, zid=1)
                pe.insert_votes(conn, ds, 0, ds.n, zid=1)

            with engine.connect() as conn:
                rows = conn.execute(
                    sa.text("SELECT pid, tid, vote FROM votes WHERE zid = 1 "
                            "ORDER BY pid, tid")
                ).mappings().all()
            by_pid_tid = {(r["pid"], r["tid"]): r["vote"] for r in rows}
            for v in ds.votes:
                assert by_pid_tid[(v.pid, v.tid)] == delphi_vote_to_postgres(v.sign)
        finally:
            engine.dispose()

    def test_participants_table_exists_and_empty(self):
        """The participants SHIM must exist (py poll_moderation depends on it)
        but is never seeded."""
        target_url = pe.create_equiv_db(PG_URL, dbname=self.DBNAME)
        engine = sa.create_engine(target_url)
        try:
            with engine.connect() as conn:
                count = conn.execute(sa.text("SELECT COUNT(*) FROM participants")).scalar()
            assert count == 0
        finally:
            engine.dispose()
