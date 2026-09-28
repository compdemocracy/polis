"""End-to-end integration test for the math poller against a real Postgres.

OPT-IN and self-skipping (like tests/test_postgres_real_data.py): it obtains a
Postgres with the polis votes schema via the shared ``require_polis_postgres``
helper — the CI ``postgres`` service (POLIS_TEST_POSTGRES_URL) when present, else
a THROWAWAY postgres:17 on an EPHEMERAL port (NEVER the host's live 5432) with
000000_initial.sql + 000006_update_votes_rule.sql applied — seeds one
conversation, and drives poll -> compute -> write, asserting:

  * a math_main row appears under the poller's math_env (shadow isolation),
  * math_bidtopid + math_ptptstats share the cycle's math_tick,
  * caching_tick / math_tick behave per the Clojure-exact SQL,
  * a fresh service instance resumes and advances the tick (restart-resumes).

If neither a CI service nor docker is available, the whole module is skipped
with a clear reason.
"""

import time

import pytest

from tests.conftest import require_polis_postgres

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def pg_url():
    with require_polis_postgres() as url:
        yield url


def _seed_conversation(engine, zid=1, n_ptpts=8, n_cmts=5):
    """Seed one conversation with FK enforcement disabled for the session."""
    import sqlalchemy as sa

    now = int(time.time() * 1000)
    # Votes are recent (within the poll window); comments were moderated LONG ago
    # (older than the moderation watermark) so the moderation loop dispatches
    # nothing and each poll_once deterministically triggers exactly one
    # (votes -> load_or_init) write cycle.  Full moderation state is still read
    # by load_or_init's poll_moderation(zid, None), so the comments are exercised.
    vote_created = now - 60_000
    old_modified = now - 2 * 24 * 60 * 60 * 1000  # 2 days ago
    with engine.begin() as conn:
        conn.execute(sa.text("SET session_replication_role = replica"))
        # Make the seed RE-RUNNABLE. When POLIS_TEST_POSTGRES_URL points at a
        # long-lived service database (the compose `postgres` service, and now
        # `make test-recovery`), rows from a previous run survive: the INSERT
        # below hit conversations_zid_key, and the caching_tick == 1 assertion
        # below additionally requires this math_env to have no prior math_main
        # row. Clear this zid's own rows first rather than depending on a
        # freshly-initialised database.
        for table in ("votes", "votes_latest_unique", "comments",
                      "participants", "math_main", "math_bidtopid",
                      "math_ptptstats", "math_ticks", "conversations"):
            conn.execute(sa.text(f"DELETE FROM {table} WHERE zid = :zid"),
                         {"zid": zid})
        conn.execute(sa.text("INSERT INTO conversations (zid) VALUES (:zid)"),
                     {"zid": zid})
        for p in range(n_ptpts):
            conn.execute(
                sa.text("INSERT INTO participants (pid, uid, zid, created, mod) "
                        "VALUES (:pid, :uid, :zid, :created, 0)"),
                {"pid": p, "uid": 1000 + p, "zid": zid, "created": old_modified},
            )
        for t in range(n_cmts):
            conn.execute(
                sa.text("INSERT INTO comments (tid, zid, pid, uid, txt, mod, is_meta, "
                        "created, modified) VALUES "
                        "(:tid, :zid, 0, 1000, :txt, 0, false, :created, :modified)"),
                {"tid": t, "zid": zid, "txt": f"comment {t}",
                 "created": old_modified, "modified": old_modified},
            )
        created = vote_created
        # Raw DB vote signs: AGREE=-1, DISAGREE=+1. Two opposing camps.
        for p in range(n_ptpts):
            raw = -1 if p % 2 == 0 else 1
            for t in range(n_cmts):
                created += 1
                conn.execute(
                    sa.text("INSERT INTO votes (zid, pid, tid, vote, created) "
                            "VALUES (:zid, :pid, :tid, :vote, :created)"),
                    {"zid": zid, "pid": p, "tid": t, "vote": raw, "created": created},
                )
        conn.execute(sa.text("SET session_replication_role = DEFAULT"))


def _make_service(url, math_env):
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller.service import MathPollerService, PollerConfig

    pg = PostgresClient(PostgresConfig(url=url, math_env=math_env, ssl_mode="disable"))
    pg.initialize()
    cfg = PollerConfig(
        database_url=url, math_env=math_env, poll_from_days_ago=1,
        worker_pool_size=2,
    )
    return MathPollerService(pg, cfg), pg


def _fetch_one(engine, sql, params):
    import sqlalchemy as sa

    with engine.connect() as conn:
        row = conn.execute(sa.text(sql), params).mappings().first()
    return dict(row) if row else None


class TestPollerIntegration:
    def test_end_to_end_poll_compute_write_and_restart(self, pg_url):
        """Two phases in one test (single container, xdist-safe):
        (1) poll -> compute -> write -> row visible under math_env + shadow
            isolation + shared math_tick; (2) fresh service resumes and advances
            the tick (restart-resumes)."""
        import sqlalchemy as sa

        engine = sa.create_engine(pg_url)
        _seed_conversation(engine, zid=1)
        math_env = "delphi_it"

        # ---- Phase 1: first poll cycle -------------------------------------
        service, _pg = _make_service(pg_url, math_env)
        service.poll_once()
        service.stop()

        main = _fetch_one(
            engine,
            "select zid, math_env, caching_tick, math_tick, data from math_main "
            "where zid = :zid and math_env = :me",
            {"zid": 1, "me": math_env},
        )
        assert main is not None, "poller must write a math_main row"
        assert main["data"] is not None
        # First write: caching_tick = COALESCE(max+1, 1) = 1; math_tick default 0.
        assert main["caching_tick"] == 1
        assert main["math_tick"] == 0

        # Shadow isolation: nothing written under a different math_env.
        other = _fetch_one(
            engine,
            "select zid from math_main where zid = :zid and math_env = :me",
            {"zid": 1, "me": "prod"},
        )
        assert other is None

        # bidtopid + ptptstats share the cycle's math_tick.
        bid = _fetch_one(
            engine,
            "select math_tick, data from math_bidtopid where zid=:zid and math_env=:me",
            {"zid": 1, "me": math_env},
        )
        pts = _fetch_one(
            engine,
            "select math_tick from math_ptptstats where zid=:zid and math_env=:me",
            {"zid": 1, "me": math_env},
        )
        assert bid is not None and pts is not None
        assert bid["math_tick"] == main["math_tick"] == pts["math_tick"]
        assert isinstance(bid["data"]["bidToPid"], list)  # list of pid-lists

        # ---- Phase 2: restart resumes and advances the tick ----------------
        before = main
        service2, _pg2 = _make_service(pg_url, math_env)  # fresh in-memory cache
        service2.poll_once()
        service2.stop()

        after = _fetch_one(
            engine,
            "select caching_tick, math_tick from math_main where zid=:zid and math_env=:me",
            {"zid": 1, "me": math_env},
        )
        # Atomic tick advanced; caching_tick advanced (MAX+1) -> resumed cleanly.
        assert after["math_tick"] == before["math_tick"] + 1
        assert after["caching_tick"] == before["caching_tick"] + 1
