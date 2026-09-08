"""R11 — math_env namespace isolation and effective configuration (REAL PG).

P-022 §C required matrix:

    Assert all reads, writes and restore operations stay in the selected math
    env; validate negative/zero cap policy, shard bounds and effective container
    settings.  A shadow job cannot mutate prod math rows.

The write side holds: every writer and ``load_math_main`` is scoped by
``math_env`` and ``UNIQUE(zid, math_env)`` keeps the namespaces apart.  The
READER side does not: the server's prefetch query is not math_env-scoped, so a
shadow row still reaches the server's in-process PCA cache.  That is asserted
below against the server's own SQL.
"""

import json
import os
import re

import pytest
import sqlalchemy as sa

from .conftest import (
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F
from polismath.poller.service import PollerConfig

pytestmark = pytest.mark.recovery

PROD_ENV = "prod"
SHADOW_ENV = "python"
_REPO_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
)


def _seed_prod_rows(engine, zid: int):
    """A pre-existing, complete prod generation the shadow job must not touch."""
    blob = {"zid": zid, "sentinel": "PROD-ROW-DO-NOT-TOUCH", "n": 999}
    with engine.begin() as conn:
        conn.execute(
            sa.text("insert into math_main (zid, math_env, data, "
                    "last_vote_timestamp, caching_tick, math_tick) values "
                    "(:z, :e, cast(:d as jsonb), 42, 5, 5)"),
            {"z": zid, "e": PROD_ENV, "d": json.dumps(blob)},
        )
        conn.execute(
            sa.text("insert into math_bidtopid (zid, math_env, math_tick, data) "
                    "values (:z, :e, 5, cast(:d as jsonb))"),
            {"z": zid, "e": PROD_ENV, "d": json.dumps({"bidToPid": [[0]]})},
        )
        conn.execute(
            sa.text("insert into math_ptptstats (zid, math_env, math_tick, data) "
                    "values (:z, :e, 5, cast(:d as jsonb))"),
            {"z": zid, "e": PROD_ENV, "d": json.dumps({"ptptstats": {}})},
        )
        conn.execute(
            sa.text("insert into math_ticks (zid, math_env, math_tick, "
                    "caching_tick) values (:z, :e, 5, 5)"),
            {"z": zid, "e": PROD_ENV},
        )
    return blob


def _prod_snapshot(engine, zid: int):
    with engine.connect() as conn:
        return {
            name: [dict(r) for r in conn.execute(
                sa.text(f"select * from {name} where zid=:z and math_env=:e "
                        "order by zid"), {"z": zid, "e": PROD_ENV}).mappings()]
            for name in ("math_main", "math_bidtopid", "math_ptptstats",
                         "math_ticks")
        }


# --------------------------------------------------------------------------- #
# Write / restore isolation
# --------------------------------------------------------------------------- #
def test_shadow_job_never_mutates_prod_math_rows(engine, pg_url, make_service):
    """A full shadow cycle must leave every prod row byte-identical."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    _seed_prod_rows(engine, 1)
    before = _prod_snapshot(engine, 1)

    svc = make_service(pg_url, math_env=SHADOW_ENV, worker_pool_size=1)
    svc.poll_once()

    assert _prod_snapshot(engine, 1) == before, (
        "the shadow job mutated prod math rows"
    )
    shadow = read_math_tables(engine, 1, SHADOW_ENV)
    assert tables_are_coherent(shadow) == [], tables_are_coherent(shadow)
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(shadow["main"]["data"], fold) == []


def test_restore_never_reads_another_math_env(engine, pg_url, make_service):
    """``load_math_main`` (``database/postgres.py:763``) filters by math_env, so
    a cold shadow start must NOT restore the prod blob."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    sentinel = _seed_prod_rows(engine, 1)["sentinel"]

    svc = make_service(pg_url, math_env=SHADOW_ENV, worker_pool_size=1)
    assert svc._pg.load_math_main(1) is None, (
        "a shadow client must not see the prod row"
    )
    svc.poll_once()
    published = json.dumps(read_math_tables(engine, 1, SHADOW_ENV)["main"]["data"])
    assert sentinel not in published, (
        "prod state leaked into the shadow namespace's published blob"
    )


def test_math_tick_counters_are_per_math_env(engine, pg_url, make_service):
    """``increment_math_tick`` upserts on (zid, math_env), so the two namespaces
    keep independent counters."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    _seed_prod_rows(engine, 1)

    svc = make_service(pg_url, math_env=SHADOW_ENV, worker_pool_size=1)
    for _ in range(3):
        svc._vote_wm = 0
        svc.poll_once()

    with engine.connect() as conn:
        rows = {r["math_env"]: r["math_tick"] for r in conn.execute(
            sa.text("select math_env, math_tick from math_ticks where zid=1")
        ).mappings()}
    assert rows[PROD_ENV] == 5, "the prod counter must not move"
    assert rows[SHADOW_ENV] >= 2, f"the shadow counter must advance: {rows}"


def test_caching_tick_is_scoped_to_its_math_env(engine, pg_url, make_service):
    """``write_math_main``'s caching_tick subquery is
    ``max(caching_tick)+1 WHERE math_env = ?`` (``database/postgres.py:838``),
    so each namespace has its OWN cursor sequence — which is why the two
    sequences overlap numerically (see R12)."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    _seed_prod_rows(engine, 1)          # prod caching_tick = 5

    svc = make_service(pg_url, math_env=SHADOW_ENV, worker_pool_size=1)
    svc.poll_once()
    shadow_tick = read_math_tables(engine, 1, SHADOW_ENV)["main"]["caching_tick"]
    assert shadow_tick == 1, (
        f"the shadow namespace must start its own cursor at 1, saw {shadow_tick}"
    )


# --------------------------------------------------------------------------- #
# The reader side of namespace isolation
# --------------------------------------------------------------------------- #
@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (R11 reader side): the server's PCA PREFETCH is not scoped to "
        "math_env. server/src/utils/pca.ts:98 runs `select * from math_main "
        "where caching_tick > ($1) order by caching_tick limit 10` with NO "
        "math_env predicate, then calls processMathObject/updatePcaCache on "
        "every row (pca.ts:117-137). Point reads ARE scoped "
        "(server/src/utils/pca.ts:360, participants.ts:10), so the hazard is "
        "specific to the prefetch cache: while a shadow poller writes under "
        "MATH_ENV=python (docker-compose.yml:169) with the server on prod, the "
        "shadow's rows enter the prod server's in-process PCA cache keyed by "
        "zid alone. P-022 §C R11: 'Assert all reads, writes and restore "
        "operations stay in the selected math env.' The writes and restores "
        "do; this read does not. Fix: add `and math_env = ($2)` to the "
        "prefetch, which is a server change and a separate decision."
    ),
)
def test_the_server_prefetch_query_is_math_env_scoped(engine, pg_url,
                                                      make_service):
    """Run the server's OWN prefetch SQL and require it to return only rows of
    the server's configured math_env."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    _seed_prod_rows(engine, 1)

    svc = make_service(pg_url, math_env=SHADOW_ENV, worker_pool_size=1)
    svc.poll_once()

    # Verbatim from server/src/utils/pca.ts:98 (the deployed prefetch).
    with engine.connect() as conn:
        rows = [dict(r) for r in conn.execute(
            sa.text("select * from math_main where caching_tick > :last "
                    "order by caching_tick limit 10"), {"last": -1},
        ).mappings()]
    envs = sorted({r["math_env"] for r in rows})
    assert envs == [PROD_ENV], (
        f"the prefetch returned rows from {envs}; a server on {PROD_ENV!r} "
        "would cache the shadow namespace's PCA blob"
    )


def test_the_server_point_reads_are_math_env_scoped(engine, pg_url,
                                                    make_service):
    """The scoping that DOES hold, asserted so the xfail above is narrow: the
    per-zid reads used by getPca and getBidIndexToPidMapping filter on
    math_env."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    sentinel = _seed_prod_rows(engine, 1)["sentinel"]
    svc = make_service(pg_url, math_env=SHADOW_ENV, worker_pool_size=1)
    svc.poll_once()

    with engine.connect() as conn:
        main = conn.execute(
            sa.text("select * from math_main where zid = :z and math_env = :e"),
            {"z": 1, "e": PROD_ENV},
        ).mappings().first()
        bid = conn.execute(
            sa.text("select * from math_bidtopid where zid = :z and "
                    "math_env = :e"), {"z": 1, "e": PROD_ENV},
        ).mappings().first()
    assert main["data"]["sentinel"] == sentinel
    assert bid["data"] == {"bidToPid": [[0]]}


# --------------------------------------------------------------------------- #
# Configuration policy
# --------------------------------------------------------------------------- #
def test_cache_cap_policy(monkeypatch):
    """0 = unlimited (explicit and documented), positive = a real LRU bound,
    negative rejected at construction."""
    assert PollerConfig().conv_cache_cap == 200, "the default must be FINITE"
    assert PollerConfig(conv_cache_cap=0).conv_cache_cap == 0
    with pytest.raises(ValueError, match="conv_cache_cap must be >= 0"):
        PollerConfig(conv_cache_cap=-1)

    monkeypatch.setenv("MATH_CONV_CACHE_CAP", "-5")
    with pytest.raises(ValueError, match="conv_cache_cap must be >= 0"):
        PollerConfig.from_env()


def test_shard_bounds_policy():
    with pytest.raises(ValueError):
        PollerConfig(shard_index=3, shard_count=3)
    with pytest.raises(ValueError):
        PollerConfig(shard_count=0)
    assert PollerConfig(shard_index=2, shard_count=3).shard_index == 2


def test_effective_container_settings_reach_the_config(monkeypatch):
    """"validate ... effective container settings": every env var the compose
    math-python service sets must actually be consumed by ``from_env``."""
    monkeypatch.setenv("MATH_ENV", "python")
    monkeypatch.setenv("MATH_CONV_CACHE_CAP", "37")
    monkeypatch.setenv("MATH_POLLER_RECONCILE_INTERVAL_MS", "1234")
    monkeypatch.setenv("POLL_SHARD_INDEX", "1")
    monkeypatch.setenv("POLL_SHARD_COUNT", "4")
    monkeypatch.setenv("MATH_WORKER_POOL_SIZE", "3")
    monkeypatch.setenv("MATH_POLLER_RETRY_CAP", "2")
    monkeypatch.setenv("POLL_FROM_DAYS_AGO", "7")

    cfg = PollerConfig.from_env()
    assert cfg.math_env == "python"
    assert cfg.conv_cache_cap == 37
    assert cfg.reconcile_interval_ms == 1234
    assert (cfg.shard_index, cfg.shard_count) == (1, 4)
    assert cfg.worker_pool_size == 3
    assert cfg.retry_cap == 2
    assert cfg.poll_from_days_ago == 7


def test_compose_math_python_service_passes_the_required_settings():
    """The container definition must actually forward the settings above, or
    the validated defaults never reach the deployed process."""
    with open(os.path.join(_REPO_ROOT, "docker-compose.yml")) as fh:
        compose = fh.read()
    service = compose.split("  math-python:", 1)[1].split("\n  postgres:", 1)[0]
    for var in ("MATH_ENV", "MATH_CONV_CACHE_CAP",
                "MATH_POLLER_RECONCILE_INTERVAL_MS", "POLL_SHARD_INDEX",
                "POLL_SHARD_COUNT", "MATH_WORKER_POOL_SIZE",
                "MATH_POLLER_RETRY_CAP", "POLL_FROM_DAYS_AGO"):
        assert re.search(rf"^\s*-\s*{var}=", service, re.M), (
            f"docker-compose.yml's math-python service does not pass {var}"
        )
    assert "MATH_ENV=${MATH_PYTHON_ENV:-python}" in service, (
        "the shadow service must default to a DISTINCT math_env"
    )


# --------------------------------------------------------------------------- #
# Negative control for the namespace failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_an_unscoped_writer_is_caught(self, engine, pg_url, make_service):
        """Intentionally broken variant: a writer that ignores math_env and
        overwrites the prod row.  The isolation assertion must go red."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        _seed_prod_rows(engine, 1)
        before = _prod_snapshot(engine, 1)

        with engine.begin() as conn:      # the broken write
            conn.execute(
                sa.text("update math_main set data = cast(:d as jsonb) "
                        "where zid = :z"),
                {"d": json.dumps({"zid": 1, "sentinel": "SHADOW"}), "z": 1},
            )
        assert _prod_snapshot(engine, 1) != before, (
            "NEGATIVE CONTROL FAILED: an unscoped write to math_main did not "
            "change the prod snapshot, so the isolation assertion is vacuous"
        )

    def test_the_prefetch_control_would_pass_when_scoped(self, engine, pg_url,
                                                         make_service):
        """The 'fixed' prefetch (with a math_env predicate) returns only prod
        rows — proving the xfail above is about the missing predicate."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        _seed_prod_rows(engine, 1)
        svc = make_service(pg_url, math_env=SHADOW_ENV, worker_pool_size=1)
        svc.poll_once()

        with engine.connect() as conn:
            rows = [dict(r) for r in conn.execute(
                sa.text("select * from math_main where caching_tick > :last "
                        "and math_env = :e order by caching_tick limit 10"),
                {"last": -1, "e": PROD_ENV},
            ).mappings()]
        assert sorted({r["math_env"] for r in rows}) == [PROD_ENV]
