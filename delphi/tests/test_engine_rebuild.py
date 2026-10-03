"""polismath.tools.engine_rebuild: the un-flip rehearsal's one-shot cold rebuild.

The refusal and usage tests need no database. The rebuild tests use the
shared ``require_polis_postgres`` helper (POLIS_TEST_POSTGRES_URL, else a
throwaway postgres:17) and a generated fixture conversation, and need the
vote convention source (P-078 PR-C); without it the command refuses (exit 3),
which ``test_engine_without_convention_source_is_refused`` covers.
"""

import io
import json
import os
import random
import subprocess
import sys
from contextlib import contextmanager

import pytest

from polismath.tools import engine_rebuild as er
from polismath.utils import vote_convention
from tests.conftest import require_polis_postgres

DELPHI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WRAPPER = os.path.join(DELPHI, "scripts", "engine-rebuild")
NOWHERE = "postgresql://postgres@127.0.0.1:1/none"
LABEL = "probe"
ZIDS = (9101, 9102)


def run(argv, environ=None):
    out = io.StringIO()
    code = er.main(argv, environ=environ or {}, out=out)
    body = out.getvalue()
    return code, (json.loads(body) if body else None)


# --- refusals and usage (no database) ------------------------------------------


@pytest.mark.parametrize("label", ["prod", "python", " prod", "PROD", "Python", "",
                                   "a b", "x" * 33, "probe;drop", "1probe"])
def test_served_or_malformed_label_is_refused(label):
    assert run(["--label", label, "--zids", "1", "--dsn", NOWHERE])[0] == er.EXIT_REFUSED


def test_math_env_naming_another_label_is_refused():
    code, _ = run(["--label", LABEL, "--zids", "1", "--dsn", NOWHERE],
                  environ={"MATH_ENV": "python"})
    assert code == er.EXIT_REFUSED


@pytest.mark.parametrize("argv", [
    ["--label", LABEL, "--dsn", NOWHERE],                       # no zids
    ["--label", LABEL, "--zids", "abc", "--dsn", NOWHERE],
    ["--label", LABEL, "--zids", "0", "--dsn", NOWHERE],
    ["--label", LABEL, "--zids", "-3", "--dsn", NOWHERE],
    ["--zids", "1", "--dsn", NOWHERE],                          # no label
    ["--label", LABEL, "--zids", "1"],                          # no dsn, no PGSERVICE
    ["--label", LABEL, "--zids", "1", "--dsn", "mysql://x/y"],
    ["--label", LABEL, "--zids-file", "/nonexistent/zids.json", "--dsn", NOWHERE],
])
def test_usage_errors_exit_2(argv):
    assert run(argv)[0] == er.EXIT_USAGE


def test_zid_lists_and_files(tmp_path):
    j = tmp_path / "z.json"
    j.write_text("[12, 3, 12]")
    w = tmp_path / "z.txt"
    w.write_text("7\n3, 40\n")
    assert er.parse_zids(["5,1", "2 9"], [str(j), str(w)]) == [1, 2, 3, 5, 7, 9, 12, 40]
    bad = tmp_path / "bad.json"
    bad.write_text('[1, true]')
    with pytest.raises(er.UsageError):
        er.parse_zids([], [str(bad)])


def test_pgservice_is_the_default_database():
    assert er.database_uri(None, {"PGSERVICE": "probe"}) == "postgresql:///?service=probe"
    assert er.database_uri("postgres://u@h/d", {"PGSERVICE": "probe"}) == "postgresql://u@h/d"


def test_engine_without_convention_source_is_refused(monkeypatch):
    monkeypatch.delattr(vote_convention, "load_semantic_votes", raising=False)
    assert run(["--label", LABEL, "--zids", "1", "--dsn", NOWHERE])[0] == er.EXIT_REFUSED


def _wrapper_env(extra=None):
    env = dict(os.environ)
    env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + env.get("PATH", "")
    env["PYTHONPATH"] = DELPHI + os.pathsep + env.get("PYTHONPATH", "")
    env.pop("MATH_ENV", None)
    env.update(extra or {})
    return env


def test_wrapper_refuses_a_served_label_with_exit_3():
    done = subprocess.run(["sh", WRAPPER, "--label", "prod", "--zids", "1", "--dsn", NOWHERE],
                          env=_wrapper_env(), capture_output=True, text=True, timeout=120)
    assert done.returncode == er.EXIT_REFUSED, done.stderr
    assert done.stdout == ""


# --- rebuilds against a database ---------------------------------------------------

needs_convention = pytest.mark.skipif(
    not hasattr(vote_convention, "load_semantic_votes"),
    reason="needs the vote convention source (P-078 PR-C)")


@pytest.fixture(scope="module")
def pg_url():
    with require_polis_postgres() as url:
        yield url


@contextmanager
def _conn(url):
    import psycopg2

    conn = psycopg2.connect(url)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            yield cur
    finally:
        conn.close()


def _generated_fixture(cur, zid):
    """Two opinion camps over ten comments, with passes, gaps, one revote and
    one moderated-out comment. Stored at agree = -1 (raw = -semantic)."""
    rng = random.Random(zid)
    base = 1_700_000_000_000 + zid * 10_000_000
    cur.execute("SET session_replication_role = replica")
    for table in ("votes", "votes_latest_unique", "comments", "participants",
                  "math_main", "math_bidtopid", "math_ptptstats", "math_ticks",
                  "conversations"):
        cur.execute(f"DELETE FROM {table} WHERE zid = %s", (zid,))
    cur.execute("INSERT INTO conversations (zid) VALUES (%s)", (zid,))
    for p in range(24):
        cur.execute("INSERT INTO participants (pid, uid, zid, created, mod) "
                    "VALUES (%s, %s, %s, %s, 0)", (p, 5000 + p, zid, base))
    for t in range(10):
        cur.execute("INSERT INTO comments (tid, zid, pid, uid, txt, mod, is_meta, created, modified) "
                    "VALUES (%s, %s, 0, 5000, %s, %s, false, %s, %s)",
                    (t, zid, f"generated fixture comment {t}", -1 if t == 9 else 0, base, base))
    created = base + 1000
    for p in range(24):
        for t in range(10):
            if rng.random() < 0.1:
                continue
            camp = 1 if p < 12 else -1
            semantic = camp if t < 5 else -camp
            r = rng.random()
            if r < 0.15:
                semantic = 0
            elif r < 0.25:
                semantic = -semantic
            created += 1000
            cur.execute("INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, %s, %s, %s, %s)",
                        (zid, p, t, -semantic, created))
    created += 1000
    cur.execute("INSERT INTO votes (zid, pid, tid, vote, created) VALUES (%s, 3, 2, 1, %s)",
                (zid, created))
    cur.execute("SET session_replication_role = DEFAULT")


STANDIN_SQL = """
CREATE TABLE public.vote_convention (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version >= 0),
  agree_value smallint NOT NULL CHECK (agree_value IN (-1, 1)));
CREATE FUNCTION public.vote_convention_current()
RETURNS TABLE (version integer, agree_value smallint)
LANGUAGE sql STABLE AS $$ SELECT version, agree_value FROM public.vote_convention WHERE singleton $$;
INSERT INTO public.vote_convention (version, agree_value) VALUES (0, -1);
"""
DROP_STANDIN_SQL = ("DROP FUNCTION IF EXISTS public.vote_convention_current(); "
                    "DROP TABLE IF EXISTS public.vote_convention;")


@pytest.fixture
def fixture_db(pg_url):
    with _conn(pg_url) as cur:
        cur.execute("SELECT to_regclass('public.vote_convention') IS NOT NULL "
                    "OR to_regprocedure('public.vote_convention_current()') IS NOT NULL")
        if cur.fetchone()[0]:
            pytest.skip("the database already has a vote_convention; these tests install a stand-in")
        for zid in ZIDS:
            _generated_fixture(cur, zid)
        cur.execute("DELETE FROM math_main WHERE math_env LIKE 'probe%%'")
        cur.execute("DELETE FROM math_ticks WHERE math_env LIKE 'probe%%'")
    try:
        yield pg_url
    finally:
        with _conn(pg_url) as cur:
            cur.execute(DROP_STANDIN_SQL)


def _rows(url, label):
    with _conn(url) as cur:
        out = {}
        for table in ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks"):
            cur.execute(f"SELECT zid, math_tick FROM {table} WHERE math_env = %s ORDER BY zid",
                        (label,))
            out[table] = cur.fetchall()
        return out


def _digests(summary):
    assert summary["ok"] is True
    return {r["zid"]: r["digest"] for r in summary["results"]}


def _rebuild(url, *extra):
    code, summary = run(["--label", LABEL, "--zids", ",".join(map(str, ZIDS)),
                         "--dsn", url, *extra])
    assert code == er.EXIT_OK
    return summary


@needs_convention
@pytest.mark.integration
def test_dry_writes_nothing_and_digests_match_the_published_rows(fixture_db):
    dry = _rebuild(fixture_db, "--dry")
    assert all(r["math_tick"] is None for r in dry["results"])
    assert all(not rows for rows in _rows(fixture_db, LABEL).values())
    wet = _rebuild(fixture_db)
    assert _digests(dry) == _digests(wet)
    rows = _rows(fixture_db, LABEL)
    ticks = {r["zid"]: r["math_tick"] for r in wet["results"]}
    for table in ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks"):
        assert dict(rows[table]) == ticks, table
    with _conn(fixture_db) as cur:   # the rehearsal's engine_rows definition
        cur.execute("SELECT m.zid, encode(sha256(convert_to(m.data::text, 'UTF8')), 'hex') "
                    "FROM public.math_main m WHERE m.math_env = %s AND m.zid = ANY(%s) "
                    "ORDER BY m.zid", (LABEL, list(ZIDS)))
        assert dict(cur.fetchall()) == _digests(wet)
        cur.execute("SELECT count(*) FROM math_main WHERE zid = ANY(%s) AND math_env <> %s",
                    (list(ZIDS), LABEL))
        assert cur.fetchone()[0] == 0


@needs_convention
@pytest.mark.integration
def test_rebuild_is_deterministic(fixture_db):
    first = _rebuild(fixture_db)
    second = _rebuild(fixture_db)
    assert _digests(first) == _digests(second)
    assert [r["math_tick"] for r in second["results"]] == [
        r["math_tick"] + 1 for r in first["results"]]


@needs_convention
@pytest.mark.integration
def test_same_digest_at_both_conventions(fixture_db):
    absent = _rebuild(fixture_db, "--dry")
    assert {r["convention"]["origin"] for r in absent["results"]} == {"database-absent"}
    with _conn(fixture_db) as cur:
        cur.execute(STANDIN_SQL)
    v0 = _rebuild(fixture_db)
    assert {(r["convention"]["version"], r["convention"]["agree_value"],
             r["convention"]["origin"]) for r in v0["results"]} == {(0, -1, "database")}
    with _conn(fixture_db) as cur:   # the flip: storage negated, convention +1
        cur.execute("BEGIN; UPDATE votes SET vote = -vote WHERE zid = ANY(%s); "
                    "UPDATE vote_convention SET version = 1, agree_value = 1; COMMIT;",
                    (list(ZIDS),))
    v1 = _rebuild(fixture_db)
    assert {(r["convention"]["version"], r["convention"]["agree_value"])
            for r in v1["results"]} == {(1, 1)}
    assert _digests(absent) == _digests(v0) == _digests(v1)
    # Control: flipped storage read without the convention row is a different blob,
    # so the equality above is not vacuous.
    with _conn(fixture_db) as cur:
        cur.execute(DROP_STANDIN_SQL)
    control = _rebuild(fixture_db, "--dry")
    assert all(_digests(control)[z] != _digests(v1)[z] for z in ZIDS)


@needs_convention
@pytest.mark.integration
def test_unknown_zid_is_refused_before_any_write(fixture_db):
    code, summary = run(["--label", LABEL, "--zids", f"{ZIDS[0]},987654321", "--dsn", fixture_db])
    assert code == er.EXIT_REFUSED and summary is None
    assert all(not rows for rows in _rows(fixture_db, LABEL).values())


@needs_convention
@pytest.mark.integration
def test_a_held_label_lock_refuses_writes_not_dry_runs(fixture_db):
    import psycopg2

    holder = psycopg2.connect(fixture_db)
    try:
        with holder.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(hashtext(%s))", (er.LOCK_KEY_PREFIX + LABEL,))
        code, _ = run(["--label", LABEL, "--zids", str(ZIDS[0]), "--dsn", fixture_db])
        assert code == er.EXIT_REFUSED
        assert run(["--label", LABEL, "--zids", str(ZIDS[0]), "--dsn", fixture_db, "--dry"])[0] == 0
    finally:
        holder.close()
    assert all(not rows for rows in _rows(fixture_db, LABEL).values())


@needs_convention
def test_unreachable_database_exits_4():
    assert run(["--label", LABEL, "--zids", "1", "--dsn", NOWHERE])[0] == er.EXIT_FAILED


@needs_convention
@pytest.mark.integration
def test_the_producers_invocation(fixture_db, tmp_path):
    """As PR #2942's producer calls it: PGSERVICE, MATH_ENV and a JSON zids file."""
    from urllib.parse import urlparse

    u = urlparse(fixture_db)
    service_file = tmp_path / "pg_service.conf"
    service_file.write_text(
        f"[probe]\nhost={u.hostname}\nport={u.port or 5432}\ndbname={u.path.lstrip('/')}\n"
        f"user={u.username}\npassword={u.password or ''}\n")
    zids_file = tmp_path / "zids.json"
    zids_file.write_text(json.dumps(sorted(ZIDS)))
    env = _wrapper_env({"PGSERVICE": "probe", "PGSERVICEFILE": str(service_file),
                        "MATH_ENV": LABEL})
    done = subprocess.run(["sh", WRAPPER, "--label", LABEL, "--zids-file", str(zids_file)],
                          env=env, capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr[-2000:]
    summary = json.loads(done.stdout)
    assert sorted(_digests(summary)) == sorted(ZIDS)
    assert [z for z, _ in _rows(fixture_db, LABEL)["math_main"]] == sorted(ZIDS)
