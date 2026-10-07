"""000025 (vote convention) controls on a real PostgreSQL 17; only the wrapper's own container.

No DATABASE_URL is accepted. Every case runs in a disposable database cloned
from the full pre-000025 migration chain (000000..000024; there is no 000020). All rows written are
generated fixtures (zid 990001 and up); no application data exists in the
container.

What is pinned here (P-078, ruling R-A):
  * the migration writes THE ONE ROW only on an empty database (version 0,
    agree -1); a database holding votes is left undeclared with the
    DECLARE_NEEDED notice, and nothing reads a sign from its data;
  * the declare operation (server/postgres/operations/vote_convention_declare.sql,
    through server/bin/vote-convention-declare.sh) writes the row once, at -1
    or +1, refuses a second declaration, a bad sign, an empty reason and a
    database without the migration, and records its own checksum;
  * the row's guards: permanent, monotonic, append-only history, the two
    admissible first states;
  * the functions and views at both signs; the write path's lock behaviour;
  * the ledger (every earlier file recorded as verified or unverified from
    the catalog, never assumed) and the checksum checker (migrations and
    operations);
  * the prerequisite refusal (no vote tables) and the apply wrapper's
    preflight, budgets, lock behaviour and post-check;
  * the down file: exact catalog replay from a seeded, an undeclared and a
    declared database; refusals once the sign has moved.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

CONTAINER, WORK = sys.argv[1], Path(sys.argv[2])
if not re.fullmatch(r"[0-9a-f]{64}|p078a(-[a-z0-9-]+)?-postgres-1", CONTAINER):
    raise SystemExit("wrapper-owned container required")
ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent.parent.parent
UP = ROOT / "000025_vote_convention.sql"
DOWN = ROOT / "down/000025_drop_vote_convention.sql"
DECLARE = REPO / "server/postgres/operations/vote_convention_declare.sql"
DECLARE_SH = REPO / "server/bin/vote-convention-declare.sh"
CHECKER = REPO / "server/postgres/check_ledger_checksums.py"
WRAPPER = REPO / "server/postgres/bin/apply-migration.sh"
SEAL = ROOT / "down/000025-files.sha256"
DOCS = REPO / "docs/vote-convention.md"
NAME = "000025_vote_convention"
MARKER = b"-- ledger-self-checksum"
LOGINS = ("vc_exec_only", "vc_writer")
RESULTS: list = []
SKIPPED: list = []


class Skip(Exception):
    pass

FAILURES: list = []

# Pinned function catalog: name, identity args, result, volatility, SECURITY DEFINER, STRICT, proconfig, language.
EXPECTED_FUNCTIONS = [
    ["vote_convention_current", "", "TABLE(version integer, agree_value smallint, contract_version integer)", "s", True, False,
     ["search_path=pg_catalog, pg_temp"], "sql"],
    ["vote_convention_history_immutable", "", "trigger", "v", False, False, ["search_path=pg_catalog, pg_temp"], "plpgsql"],
    ["vote_convention_monotonic", "", "trigger", "v", False, False, ["search_path=pg_catalog, pg_temp"], "plpgsql"],
    ["vote_convention_permanent", "", "trigger", "v", False, False, ["search_path=pg_catalog, pg_temp"], "plpgsql"],
    ["vote_convention_record_history", "", "trigger", "v", False, False, ["search_path=pg_catalog, pg_temp"], "plpgsql"],
    ["vote_insert",
     "p_zid integer, p_pid integer, p_tid integer, p_semantic smallint, p_weight_x_32767 smallint DEFAULT 0, "
     "p_high_priority boolean DEFAULT false, p_expected_version integer DEFAULT NULL::integer",
     "TABLE(zid integer, pid integer, tid integer, vote smallint, created bigint, convention_version integer)",
     "v", True, False, ["search_path=pg_catalog, pg_temp", "lock_timeout=2s"], "plpgsql"],
    ["vote_semantic", "raw smallint, agree_value smallint", "smallint", "i", False, True,
     ["search_path=pg_catalog, pg_temp"], "sql"],
    ["vote_storage", "semantic smallint, agree_value smallint", "smallint", "i", False, True,
     ["search_path=pg_catalog, pg_temp"], "sql"],
]
# Grants to roles other than the owner (postgres here) on the new relations.
EXPECTED_TABLE_GRANTS = [
    ["polis_coordinator_control", "vote_convention", "SELECT"],
    ["polis_coordinator_observer", "vote_convention", "SELECT"],
    ["polis_coordinator_observer", "vote_convention_history", "SELECT"],
    ["polis_coordinator_publisher", "vote_convention", "SELECT"],
]
# Non-owner EXECUTE entries on the new functions (PUBLIC is grantee 0).
EXPECTED_FUNCTION_ACL = [
    ["PUBLIC", "vote_convention_current"],
    ["PUBLIC", "vote_convention_history_immutable"],
    ["PUBLIC", "vote_convention_monotonic"],
    ["PUBLIC", "vote_convention_permanent"],
    ["PUBLIC", "vote_convention_record_history"],
    ["PUBLIC", "vote_semantic"],
    ["PUBLIC", "vote_storage"],
    ["polis_coordinator_control", "vote_convention_current"],
    ["polis_coordinator_observer", "vote_convention_current"],
    ["polis_coordinator_publisher", "vote_convention_current"],
]
EXPECTED_GRANT_NOTE = (
    "vote storage convention; grants: "
    "polis_coordinator_control:SELECT:public.vote_convention "
    "polis_coordinator_control:EXECUTE:public.vote_convention_current() "
    "polis_coordinator_observer:SELECT:public.vote_convention "
    "polis_coordinator_observer:EXECUTE:public.vote_convention_current() "
    "polis_coordinator_observer:SELECT:public.vote_convention_history "
    "polis_coordinator_publisher:SELECT:public.vote_convention "
    "polis_coordinator_publisher:EXECUTE:public.vote_convention_current()")
SEED_REASON = "seeded on an empty database: agree = -1, disagree = +1, pass = 0 (the storage convention since 2012)"
DECLARE_NEEDED = 'vote convention: DECLARE_NEEDED. This database holds votes and records no sign.'
DECLARE_COMMAND = 'make vote-convention-declare AGREE=-1'


def run(args, content=None, ok=True, env=None):
    p = subprocess.run(["docker", "exec", "-i", CONTAINER, *args], input=content, text=True, capture_output=True, env=env)
    if ok and p.returncode:
        raise AssertionError(p.stdout + p.stderr)
    return p


def sql(db, content, ok=True, user="postgres", stop=True, variables=()):
    args = ["psql", "-X", "-q", "-At", "-U", user, "-d", db]
    if stop:
        args[2:2] = ["-v", "ON_ERROR_STOP=1"]
    for name, value in variables:
        args[2:2] = ["-v", f"{name}={value}"]
    return run(args, content, ok)


def val(db, content, user="postgres"):
    return sql(db, content, user=user).stdout.strip()


def eq(actual, expected, what=""):
    assert actual == expected, f"{what}: expected {expected!r}, got {actual!r}"


def fails(db, content, sqlstate, user="postgres", variables=()):
    """Run content; require an error with exactly this SQLSTATE."""
    p = sql(db, "\\set VERBOSITY verbose\n" + content, ok=False, user=user, variables=variables)
    assert p.returncode != 0, f"expected {sqlstate}, statement succeeded: {content}"
    assert re.search(rf"ERROR:\s+{sqlstate}:", p.stderr), f"expected {sqlstate}, got: {p.stderr}"
    return p


def apply(db, ok=True):
    return sql(db, UP.read_text(), ok)


def down(db, ok=True):
    return sql(db, DOWN.read_text(), ok)


def declare(db, agree, reason="generated fixture declaration"):
    return sql(db, DECLARE.read_text(), variables=(("agree", agree), ("reason", reason)))


def declare_fails(db, sqlstate, agree, reason="generated fixture declaration"):
    return fails(db, DECLARE.read_text(), sqlstate, variables=(("agree", agree), ("reason", reason)))


def declare_sh(db, *args, ok=True):
    """The operator's entry point, through the container's psql."""
    env = dict(os.environ, PSQL=f"docker exec -i {CONTAINER} psql -U postgres -d {db}")
    env.pop("DATABASE_URL", None)
    p = subprocess.run(["bash", str(DECLARE_SH), *args], text=True, capture_output=True, env=env)
    if ok and p.returncode:
        raise AssertionError(p.stdout + p.stderr)
    return p


def hold_votes(db, zid=990000):
    """Make the database one that holds votes (a raw row, as every writer before 000025 wrote)."""
    sql(db, f"INSERT INTO votes (zid, pid, tid, vote) VALUES ({zid}, 1, 1, -1);")


def dump(db):
    text = run(["pg_dump", "-U", "postgres", "--schema-only", "-d", db]).stdout
    return "\n".join(line for line in text.splitlines() if line.strip()
                     and not line.startswith(("--", "\\restrict ", "\\unrestrict "))) + "\n"


def ledger_checksum(raw: bytes) -> str:
    lines = raw.split(b"\n")
    assert sum(MARKER in line for line in lines) == 1, "exactly one ledger marker line"
    return hashlib.sha256(b"\n".join(line for line in lines if MARKER not in line)).hexdigest()


def functions(db):
    return json.loads(val(db, """
SELECT coalesce(json_agg(json_build_array(p.proname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile, p.prosecdef, p.proisstrict, p.proconfig, l.lanname) ORDER BY p.proname), '[]')
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('vote_convention_current','vote_convention_history_immutable','vote_convention_monotonic',
                     'vote_convention_record_history','vote_insert','vote_semantic','vote_storage','vote_convention_permanent');"""))


def table_grants(db):
    return json.loads(val(db, """
SELECT coalesce(json_agg(json_build_array(grantee, table_name, privilege_type) ORDER BY grantee, table_name, privilege_type), '[]')
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee <> 'postgres'
   AND table_name IN ('vote_convention','vote_convention_history','schema_migrations','votes_semantic','votes_latest_unique_semantic');"""))


def function_acl(db):
    return json.loads(val(db, """
SELECT coalesce(json_agg(json_build_array(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, p.proname)
         ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, p.proname), '[]')
  FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 WHERE p.pronamespace = 'public'::regnamespace AND a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'
   AND p.proname LIKE 'vote\\_%';"""))


def case(name, body):
    db = f"c{len(RESULTS):02d}"
    sql("postgres", f"CREATE DATABASE {db} TEMPLATE vc_base;")
    try:
        body(db)
        RESULTS.append({"case": name, "status": "PASS"})
        print(f"PASS {len(RESULTS):02d}: {name}", flush=True)
    except Skip as why:
        SKIPPED.append({"case": name, "reason": str(why)})
        RESULTS.append({"case": name, "status": "SKIP"})
        print(f"SKIP {len(RESULTS):02d}: {name}: {why}", flush=True)
    except Exception as exc:  # noqa: BLE001 - recorded and reported
        FAILURES.append({"case": name, "error": str(exc)})
        RESULTS.append({"case": name, "status": "FAIL"})
        print(f"FAIL {len(RESULTS):02d}: {name}: {exc}", flush=True)
    finally:
        sql("postgres", f"DROP DATABASE {db} WITH (FORCE);")


def flip(db):
    """What the un-flip does to the row (data is left alone here)."""
    sql(db, "UPDATE public.vote_convention SET version = 1, agree_value = 1, reason = 'test flip' WHERE singleton;")


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    for login in LOGINS:
        sql("postgres", f"DROP ROLE IF EXISTS {login}; CREATE ROLE {login} LOGIN;")
    sql("postgres", "CREATE DATABASE vc_base;")
    migrations = [p for p in sorted(ROOT.glob("0*.sql")) if p.name < UP.name]
    numbers = [int(p.name[:6]) for p in migrations]
    assert numbers == [n for n in range(25) if n != 20], numbers   # 000000..000024, no 000020
    for path in migrations:
        sql("vc_base", path.read_text())
    baseline = dump("vc_base")
    (WORK / "baseline.sql").write_text(baseline)
    (WORK / "profile.txt").write_text(sql("postgres", "SELECT version(); SHOW server_encoding;").stdout)
    assert val("vc_base", "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'polis_coordinator_%';") == "5"
    rule = re.search(r"<!-- restore-rule -->\n```sql\n(.*?)```\n<!-- /restore-rule -->", DOCS.read_text(), re.S)
    assert rule, "restore rule block missing from docs/vote-convention.md"
    restore_sql = rule.group(1)
    declare_checksum = ledger_checksum(DECLARE.read_bytes())

    # 1. up -> down -> up, exact catalog replay; re-apply refuses and changes nothing.
    def roundtrip(db):
        p = apply(db)
        assert "GUARDED v0 agree -1 (seeded" in p.stderr, p.stderr
        first = dump(db)
        assert functions(db) == EXPECTED_FUNCTIONS, functions(db)
        assert table_grants(db) == EXPECTED_TABLE_GRANTS, table_grants(db)
        assert function_acl(db) == EXPECTED_FUNCTION_ACL, function_acl(db)
        assert val(db, "SELECT pg_get_viewdef('public.votes_semantic'::regclass) LIKE '%CROSS JOIN vote_convention c%';") == "t"
        fails(db, UP.read_text(), "P0780")
        assert dump(db) == first, "a refused re-apply changed the catalog"
        down(db)
        assert dump(db) == baseline, "down did not restore the pre-000025 catalog"
        (WORK / "post-down.sql").write_text(dump(db))
        down(db)
        assert dump(db) == baseline, "a second down changed the catalog"
        apply(db)
        assert dump(db) == first, "re-apply after down differs from the first apply"
        assert functions(db) == EXPECTED_FUNCTIONS and table_grants(db) == EXPECTED_TABLE_GRANTS
        (WORK / "post-up.sql").write_text(first)
    case("up/down/up: exact catalog replay; pinned signatures and grants; re-apply refuses P0780", roundtrip)

    # 2. The seed: only on an empty database.
    def seed(db):
        apply(db)
        eq(val(db, "SELECT singleton, version, agree_value, contract_version, operation, operation_checksum IS NULL, reason, changed_by "
                   "FROM public.vote_convention;"),
           f"t|0|-1|1|seed-empty|t|{SEED_REASON}|postgres", "seed row")
        eq(val(db, "SELECT count(*), min(version), min(agree_value), min(operation) FROM public.vote_convention_history;"),
           "1|0|-1|seed-empty", "history")
        eq(val(db, "SELECT version || '|' || agree_value || '|' || contract_version FROM public.vote_convention_current();"), "0|-1|1", "current()")
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (0, -1, 'second', 'x');", "P0782")
        # A second row that would pass the guard still meets the constant primary key.
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (1, 1, 'second', 'x');", "23505")
        fails(db, "INSERT INTO public.vote_convention (singleton, version, agree_value, reason, operation) VALUES (false, 1, 1, 'x', 'x');", "23514")
        fails(db, "UPDATE public.vote_convention SET contract_version = 2, version = 1, agree_value = 1;", "23514")
        eq(val(db, "SELECT count(*) FROM public.vote_convention;"), "1", "one row")
    case("seed on an empty database: one row (0, -1, contract 1, seed-empty), one history row; a second row refuses", seed)

    def undeclared(db):
        hold_votes(db)
        p = apply(db)
        assert DECLARE_NEEDED in p.stderr and DECLARE_COMMAND in p.stderr, p.stderr
        assert "GUARDED" not in p.stderr
        eq(val(db, "SELECT count(*) FROM public.vote_convention;"), "0", "no row")
        eq(val(db, "SELECT count(*) FROM public.vote_convention_history;"), "0", "no history")
        eq(val(db, "SELECT count(*) FROM public.vote_convention_current();"), "0", "current() is empty")
        eq(val(db, "SELECT vote FROM votes WHERE zid = 990000;"), "-1", "the stored vote is untouched")
        # Nothing reads a sign from the data: the write path and the views refuse/empty.
        fails(db, "SELECT * FROM public.vote_insert(990001, 1, 1, 1::smallint);", "P0791")
        eq(val(db, "SELECT count(*) FROM votes WHERE zid = 990001;"), "0", "nothing written")
        eq(val(db, "SELECT count(*) FROM votes_semantic;"), "0", "views empty without the row")
        # The ledger still records the migration: it is applied, the declaration is separate.
        eq(val(db, f"SELECT count(*) FROM public.schema_migrations WHERE name = '{NAME}';"), "1", "ledger row")
        fails(db, UP.read_text(), "P0780")
        # Only the two first states are admissible while nothing has been declared.
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (1, -1, 'x', 'x');", "P0782")
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (0, 1, 'x', 'x');", "P0782")
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (2, 1, 'x', 'x');", "P0782")
        # An admissible first state still meets the column checks.
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (0, -1, 'x', '');", "23514")
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation, operation_checksum) VALUES (0, -1, 'x', 'x', 'abc');", "23514")
        eq(val(db, "SELECT count(*) FROM public.vote_convention_history;"), "0", "refused inserts leave no history")
    case("a database holding votes is left undeclared: no row, DECLARE_NEEDED notice naming the command; "
         "vote_insert refuses P0791; only (0,-1) or (1,+1) may be the first state", undeclared)

    # 2b. The declare operation.
    def declare_minus(db):
        hold_votes(db)
        apply(db)
        declare_fails(db, "P0797", "2")
        declare_fails(db, "P0797", "agree")
        declare_fails(db, "P0797", "-1", reason="   ")
        eq(val(db, "SELECT count(*) FROM public.vote_convention;"), "0", "refusals wrote nothing")
        p = declare(db, "-1", reason="the original Polis convention")
        assert "GUARDED v0 agree -1 (declared by postgres)" in p.stderr, p.stderr
        eq(val(db, "SELECT version, agree_value, contract_version, operation, operation_checksum, reason, changed_by FROM public.vote_convention;"),
           f"0|-1|1|vote_convention_declare|{declare_checksum}|the original Polis convention|postgres", "declared row")
        eq(val(db, "SELECT count(*), min(operation) FROM public.vote_convention_history;"), "1|vote_convention_declare", "history")
        eq(val(db, "SELECT version || '|' || agree_value FROM public.vote_convention_current();"), "0|-1", "current()")
        declare_fails(db, "P0798", "-1")
        declare_fails(db, "P0798", "1")
        eq(val(db, "SELECT count(*) FROM public.vote_convention_history;"), "1", "a second declaration changes nothing")
        # The declared row behaves exactly like the seed: writes, reads and the flip.
        eq(val(db, "SELECT vote, convention_version FROM public.vote_insert(990001, 1, 1, 1::smallint);"), "-1|0", "writes at -1")
        eq(val(db, "SELECT semantic_vote FROM votes_semantic WHERE zid = 990000;"), "1", "the pre-existing vote reads as agree")
        flip(db)
        eq(val(db, "SELECT version || '|' || agree_value FROM public.vote_convention_current();"), "1|1", "flip after declare")
    case("declare AGREE=-1 on an undeclared database: one row (0, -1) with the operation's checksum and reason; "
         "bad sign / empty reason refuse P0797; a second declaration refuses P0798; the row then behaves like the seed", declare_minus)

    def declare_plus(db):
        hold_votes(db)
        apply(db)
        p = declare(db, "1", reason="this deployment reversed its own signs")
        assert "GUARDED v1 agree 1 (declared by postgres)" in p.stderr, p.stderr
        eq(val(db, "SELECT version, agree_value, operation FROM public.vote_convention;"), "1|1|vote_convention_declare", "declared +1")
        eq(val(db, "SELECT string_agg(version::text, ',' ORDER BY version) FROM public.vote_convention_history;"), "1",
           "one history row: no -1 era that never existed")
        eq(val(db, "SELECT vote, convention_version FROM public.vote_insert(990001, 1, 1, 1::smallint);"), "1|1", "writes agree as +1")
        eq(val(db, "SELECT semantic_vote FROM votes_semantic WHERE zid = 990001;"), "1", "reads back as agree")
        # The next state continues from version 1: (2, -1) is the reverse flip.
        fails(db, "UPDATE public.vote_convention SET version = 1, agree_value = -1, reason = 'x';", "P0782")
        sql(db, "UPDATE public.vote_convention SET version = 2, agree_value = -1, reason = 'reverse' WHERE singleton;")
        eq(val(db, "SELECT count(*) FROM public.vote_convention_history;"), "2", "history continues")
        fails(db, DOWN.read_text(), "P0789")
    case("declare AGREE=+1 (a deployment that reversed its own signs): first state (1, +1), one history row; "
         "vote_insert writes +1; the next state is version 2; the down file refuses", declare_plus)

    def declare_without_migration(db):
        declare_fails(db, "P0796", "-1")
        assert val(db, "SELECT to_regclass('public.vote_convention') IS NULL;") == "t"
        assert dump(db) == baseline, "a refused declaration changed the catalog"
    case("declare before the migration refuses P0796 and changes nothing", declare_without_migration)

    def declare_script(db):
        p = declare_sh(db, "--status", ok=False)
        assert p.returncode == 1 and p.stdout.startswith("GUARD_NEEDED"), p.stdout + p.stderr
        hold_votes(db)
        apply(db)
        p = declare_sh(db, "--status", ok=False)
        assert p.returncode == 1 and p.stdout.startswith("DECLARE_NEEDED") and DECLARE_COMMAND in p.stdout, p.stdout + p.stderr
        p = declare_sh(db, "0", ok=False)
        assert p.returncode == 2 and "AGREE must be -1 or +1" in p.stderr, p.stdout + p.stderr
        eq(val(db, "SELECT count(*) FROM public.vote_convention;"), "0", "the script refused before psql")
        p = declare_sh(db, "-1")
        assert p.stdout.strip().endswith("GUARDED v0 agree -1 (contract 1; written by vote_convention_declare as postgres: "
                                         "declared by the operator: the original Polis convention (agree stored as -1))"), p.stdout
        p = declare_sh(db, "--status")
        assert p.stdout.startswith("GUARDED v0 agree -1"), p.stdout
        p = declare_sh(db, "+1", "again", ok=False)
        assert p.returncode != 0 and "already declares its convention" in p.stderr, p.stderr
        eq(val(db, "SELECT version || '|' || agree_value FROM public.vote_convention_current();"), "0|-1", "unchanged")
        (WORK / "declare-script.txt").write_text(p.stderr)
    case("vote-convention-declare.sh: --status says GUARD_NEEDED / DECLARE_NEEDED / GUARDED; AGREE=-1 declares; "
         "a bad sign and a second declaration are refused", declare_script)

    # 3. Triggers.
    def triggers(db):
        apply(db)
        fails(db, "UPDATE public.vote_convention SET version = 5, agree_value = 1, reason = 'skip';", "P0782")
        fails(db, "UPDATE public.vote_convention SET version = 1, reason = 'same sign';", "P0782")
        fails(db, "UPDATE public.vote_convention SET version = 0, agree_value = 1, reason = 'no advance';", "P0782")
        assert val(db, "SELECT count(*) FROM public.vote_convention_history;") == "1"
        flip(db)
        assert val(db, "SELECT version || '|' || agree_value || '|' || reason FROM public.vote_convention_history ORDER BY version;") == \
            f"0|-1|{SEED_REASON}\n1|1|test flip"
        fails(db, "UPDATE public.vote_convention SET version = 1, agree_value = -1, reason = 'back';", "P0782")
        sql(db, "UPDATE public.vote_convention SET version = 2, agree_value = -1, reason = 'and back' WHERE singleton;")
        assert val(db, "SELECT count(*) FROM public.vote_convention_history;") == "3"
        fails(db, "UPDATE public.vote_convention_history SET reason = 'rewritten';", "P0781")
        fails(db, "DELETE FROM public.vote_convention_history;", "P0781")
        assert val(db, "SELECT count(*) FROM public.vote_convention_history;") == "3"
        fails(db, "TRUNCATE public.vote_convention_history;", "P0781")
        assert val(db, "SELECT count(*) FROM public.vote_convention_history;") == "3"
    case("triggers: +1 with a sign change appends history; skip/same sign P0782; history UPDATE/DELETE P0781", triggers)

    # 3b. The row is permanent; vote_insert refuses without it; a row put back must continue the history.
    def permanence(db):
        apply(db)
        eq(val(db, "SELECT changed_at = (SELECT changed_at FROM public.vote_convention_history WHERE version = 0) FROM public.vote_convention;"), "t", "seed stamp")
        sql(db, "SELECT pg_sleep(0.02);")
        flip(db)
        eq(val(db, "SELECT h1.changed_at > h0.changed_at, h1.changed_by FROM public.vote_convention_history h0, public.vote_convention_history h1 "
                   "WHERE h0.version = 0 AND h1.version = 1;"), "t|postgres", "flip stamps changed_at/changed_by")
        fails(db, "DELETE FROM public.vote_convention;", "P0790")
        fails(db, "TRUNCATE public.vote_convention;", "P0790")
        eq(val(db, "SELECT count(*) FROM public.vote_convention;"), "1", "row kept")
        # Remove it the only way left (triggers off, owner/superuser): vote_insert must refuse, not write NULL.
        sql(db, "ALTER TABLE public.vote_convention DISABLE TRIGGER vote_convention_no_delete; DELETE FROM public.vote_convention; "
                "ALTER TABLE public.vote_convention ENABLE TRIGGER vote_convention_no_delete;")
        fails(db, "SELECT * FROM public.vote_insert(990001, 1, 1, 1::smallint);", "P0791")
        fails(db, "SELECT * FROM public.vote_insert(990001, 1, 1, 1::smallint, 0::smallint, false, 1);", "P0791")
        eq(val(db, "SELECT count(*) FROM votes WHERE zid = 990001;"), "0", "nothing written")
        eq(val(db, "SELECT count(*) FROM votes_semantic;"), "0", "views empty without the row")
        # Putting a row back must continue the history: version 2 with the opposite sign of version 1.
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (0, -1, 'restart', 'x');", "P0782")
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (2, 1, 'same sign', 'x');", "P0782")
        fails(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (5, -1, 'skip', 'x');", "P0782")
        # The declare operation does not put it back either: history exists, so the first-state rule does not apply.
        declare_fails(db, "P0782", "-1")
        sql(db, "INSERT INTO public.vote_convention (version, agree_value, reason, operation) VALUES (2, -1, 'put back', 'repair');")
        eq(val(db, "SELECT max(version), count(*) FROM public.vote_convention_history;"), "2|3", "history continues")
        eq(val(db, "SELECT vote, convention_version FROM public.vote_insert(990001, 1, 1, 1::smallint);"), "-1|2", "writes again")
    case("permanence: DELETE/TRUNCATE refuse P0790; history TRUNCATE P0781; a missing row makes vote_insert refuse P0791 "
         "(no NULL vote); a row put back must be version+1 with a sign change (P0782); UPDATE stamps changed_at/by", permanence)

    # 4. Functions at both versions.
    def functions_both(db):
        apply(db)
        q = ("SELECT vote_semantic(-1::smallint,-1::smallint), vote_semantic(1::smallint,-1::smallint), "
             "vote_semantic(0::smallint,-1::smallint), vote_semantic(0::smallint,1::smallint), "
             "vote_semantic(1::smallint,1::smallint), vote_semantic(-1::smallint,1::smallint), "
             "vote_semantic(NULL,-1::smallint) IS NULL, vote_semantic(1::smallint,NULL) IS NULL;")
        assert val(db, q) == "1|-1|0|0|1|-1|t|t"
        for agree in (-1, 1):
            for s in (-1, 0, 1):
                assert val(db, f"SELECT vote_semantic(vote_storage({s}::smallint,{agree}::smallint),{agree}::smallint);") == str(s)
        assert val(db, "SELECT vote_storage(1::smallint,-1::smallint), vote_storage(-1::smallint,-1::smallint), "
                       "vote_storage(1::smallint,1::smallint), vote_storage(NULL,1::smallint) IS NULL;") == "-1|1|1|t"
        assert val(db, "SELECT version || '|' || agree_value || '|' || contract_version FROM vote_convention_current();") == "0|-1|1"
        assert val(db, "SELECT to_regprocedure('public.vote_convention_current()') IS NOT NULL;") == "t"
        assert val(db, "SELECT count(*) FROM votes v LEFT JOIN public.vote_convention_current() AS vc ON true;") == "0"
        # The engines' row read selects by name and is unchanged by the third column.
        assert val(db, "SELECT version, agree_value FROM public.vote_convention_current();") == "0|-1"
        flip(db)
        assert val(db, "SELECT version || '|' || agree_value || '|' || contract_version FROM vote_convention_current();") == "1|1|1"
    case("functions: vote_semantic/vote_storage inverse at both signs, NULL -> NULL; current() carries the contract at v0 then (1, 1)", functions_both)

    # 5. vote_insert round trip at both versions.
    def insert_round_trip(db):
        apply(db)
        r = val(db, "SELECT zid, pid, tid, vote, convention_version, created > 0 FROM public.vote_insert(990001, 1, 1, 1::smallint);")
        assert r == "990001|1|1|-1|0|t", r
        eq(val(db, "SELECT vote FROM votes WHERE zid = 990001 AND pid = 1 AND tid = 1;"), "-1", "case 5")
        eq(val(db, "SELECT vote FROM votes_latest_unique WHERE zid = 990001 AND pid = 1 AND tid = 1;"), "-1", "case 5")
        eq(val(db, "SELECT semantic_vote, reaction, convention_version FROM votes_semantic WHERE zid = 990001;"), "1|agree|0", "case 5")
        eq(val(db, "SELECT semantic_vote, reaction FROM votes_latest_unique_semantic WHERE zid = 990001;"), "1|agree", "case 5")
        # A changed vote: votes keeps both, votes_latest_unique the latest vote (the 000006 rule).
        # The rule's ON CONFLICT updates vote and modified only, so the first weight stays there.
        sql(db, "SELECT pg_sleep(0.01); SELECT * FROM public.vote_insert(990001, 1, 1, -1::smallint, 16383::smallint, true, 0);")
        eq(val(db, "SELECT count(*), sum(vote) FROM votes WHERE zid = 990001;"), "2|0", "case 5")
        eq(val(db, "SELECT vote, weight_x_32767 FROM votes_latest_unique WHERE zid = 990001;"), "1|0", "case 5")
        eq(val(db, "SELECT high_priority FROM votes WHERE zid = 990001 AND vote = 1;"), "t", "case 5")
        eq(val(db, "SELECT vote FROM public.vote_insert(990001, 2, 1, 0::smallint);"), "0", "case 5")
        fails(db, "SELECT * FROM public.vote_insert(990001, 3, 1, 2::smallint);", "P0783")
        fails(db, "SELECT * FROM public.vote_insert(990001, 3, 1, NULL::smallint);", "P0783")
        fails(db, "SELECT * FROM public.vote_insert(990001, 3, 1, 1::smallint, 0::smallint, false, 1);", "P0784")
        # The caller's lock_timeout is not changed by the function.
        assert val(db, "BEGIN; SET LOCAL lock_timeout = '7s'; SELECT 1 FROM public.vote_insert(990001, 4, 1, 1::smallint); SHOW lock_timeout; ROLLBACK;").splitlines()[-1] == "7s"
        eq(val(db, "SHOW lock_timeout;"), "0", "case 5")
        flip(db)
        r = val(db, "SELECT vote, convention_version FROM public.vote_insert(990002, 1, 1, 1::smallint, 0::smallint, false, 1);")
        assert r == "1|1", r
        eq(val(db, "SELECT vote FROM votes_latest_unique WHERE zid = 990002;"), "1", "case 5")
        eq(val(db, "SELECT semantic_vote, reaction, convention_version FROM votes_semantic WHERE zid = 990002;"), "1|agree|1", "case 5")
        eq(val(db, "SELECT semantic_vote FROM votes_latest_unique_semantic WHERE zid = 990002;"), "1", "case 5")
        fails(db, "SELECT * FROM public.vote_insert(990002, 2, 1, 1::smallint, 0::smallint, false, 0);", "P0784")
        # A session holding the row FOR UPDATE (the un-flip's window): vote_insert gives up after ~2 s with 55P03.
        holder = subprocess.Popen(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-At", "-U", "postgres", "-d", db],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        holder.stdin.write("BEGIN; SELECT 1 FROM public.vote_convention WHERE singleton FOR UPDATE; SELECT pg_sleep(8); COMMIT;\n")
        holder.stdin.close()
        try:
            for _ in range(100):
                if val(db, "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%pg_sleep(8)%' AND pid <> pg_backend_pid();") == "1":
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("lock holder did not start")
            t0 = time.monotonic()
            fails(db, "SELECT * FROM public.vote_insert(990003, 1, 1, 1::smallint);", "55P03")
            elapsed = time.monotonic() - t0
            assert 1.8 <= elapsed < 6.0, f"55P03 after {elapsed:.2f}s"
            # A plain read is not blocked by the holder.
            t0 = time.monotonic()
            eq(val(db, "SELECT version FROM public.vote_convention_current();"), "1", "case 5")
            assert time.monotonic() - t0 < 1.5
        finally:
            holder.wait(timeout=30)
        eq(val(db, "SELECT count(*) FROM votes WHERE zid = 990003;"), "0", "case 5")
        (WORK / "lock-timeout.txt").write_text(f"55P03 after {elapsed:.2f}s\n")
    case("vote_insert: agree round trip at v0 (-1) and v1 (+1), rule copies to votes_latest_unique, views read +1; "
         "P0783, P0784; FOR UPDATE holder -> 55P03 in ~2 s; caller lock_timeout untouched", insert_round_trip)

    # 5b. A writer blocked by the flip re-reads the row and writes with the new sign.
    def writer_across_flip(db):
        apply(db)
        eq(val(db, "SELECT vote FROM public.vote_insert(990005, 1, 1, 1::smallint);"), "-1", "v0 agree")
        flipper = subprocess.Popen(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1",
                                    "-U", "postgres", "-d", db],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        flipper.stdin.write("BEGIN;\n"
                            "UPDATE public.vote_convention SET version = 1, agree_value = 1, reason = 'test flip' WHERE singleton;\n"
                            "UPDATE public.votes SET vote = -vote WHERE vote IN (-1, 1);\n"
                            "UPDATE public.votes_latest_unique SET vote = -vote WHERE vote IN (-1, 1);\n"
                            "SELECT pg_sleep(1.2);\nCOMMIT;\n")
        flipper.stdin.close()
        try:
            for _ in range(100):
                if val(db, "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                           "AND query LIKE '%pg_sleep(1.2)%' AND pid <> pg_backend_pid();") == "1":
                    break
                time.sleep(0.05)
            else:
                raise AssertionError("flip session did not start")
            t0 = time.monotonic()
            r = val(db, "SELECT vote, convention_version FROM public.vote_insert(990005, 2, 1, 1::smallint);")
            waited = time.monotonic() - t0
        finally:
            flipper.wait(timeout=30)
        assert flipper.returncode == 0, flipper.stderr.read()
        eq(r, "1|1", "the blocked writer stores agree as +1 under version 1")
        assert 0.2 < waited < 2.0, f"waited {waited:.2f}s"
        eq(val(db, "SELECT string_agg(pid || ':' || vote, ',' ORDER BY pid) FROM votes WHERE zid = 990005;"), "1:1,2:1", "stored")
        eq(val(db, "SELECT string_agg(semantic_vote::text, ',' ORDER BY pid) FROM votes_semantic WHERE zid = 990005;"), "1,1", "both agree")
        eq(val(db, "SELECT string_agg(semantic_vote::text, ',' ORDER BY pid) FROM votes_latest_unique_semantic WHERE zid = 990005;"), "1,1", "latest")
        (WORK / "writer-across-flip.txt").write_text(f"blocked writer returned after {waited:.2f}s with {r}\n")
    case("flip under a waiting writer: vote_insert blocks on FOR SHARE, then writes +1 under version 1; no vote double-flipped", writer_across_flip)

    # 5c. Restore detection with the real held un-flip migration, when it is in the tree (or HELD_UNFLIP_SQL names it).
    held_files = sorted(ROOT.glob("held/*_vote_sign_unflip.sql"))
    held = Path(os.environ.get("HELD_UNFLIP_SQL") or (held_files[0] if held_files else ROOT / "held/vote_sign_unflip.sql (absent)"))

    def real_unflip(db):
        if not held.is_file():
            raise Skip(f"{held} not present")
        apply(db)
        sql(db, "SELECT * FROM public.vote_insert(990006, 1, 1, 1::smallint); SELECT * FROM public.vote_insert(990006, 2, 1, -1::smallint); "
                "SELECT * FROM public.vote_insert(990006, 3, 1, 0::smallint);")
        eq(val(db, restore_sql), "pre-flip", "before")
        sql(db, held.read_text())
        eq(val(db, restore_sql), "post-flip", "after the real un-flip")
        eq(val(db, "SELECT string_agg(vote::text, ',' ORDER BY pid) FROM votes WHERE zid = 990006;"), "1,-1,0", "stored signs mirrored")
        eq(val(db, "SELECT string_agg(semantic_vote::text, ',' ORDER BY pid) FROM votes_semantic WHERE zid = 990006;"), "1,-1,0", "meaning unchanged")
        eq(val(db, "SELECT vote FROM public.vote_insert(990006, 4, 1, 1::smallint);"), "1", "agree now stored +1")
        fails(db, held.read_text(), "P0785")
        fails(db, DOWN.read_text(), "P0789")
    case("restore detection against the real held un-flip: pre-flip -> post-flip; re-run refuses P0785; down refuses P0789", real_unflip)

    # 5d. The ledger checksum checker the CI workflow runs: migrations and operations.
    def checker(_db):
        spec = importlib.util.spec_from_file_location("check_ledger_checksums", CHECKER)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        eq(mod.check(UP), [], "committed migration")
        eq(mod.check(DECLARE), [], "committed operation")
        assert DECLARE in mod.files() and UP in mod.files()
        tampered = WORK / UP.name
        tampered.write_bytes(UP.read_bytes().replace(b"'seed-empty'", b"'Seed-empty'", 1))
        assert mod.check(tampered) and "hashes to" in mod.check(tampered)[0], mod.check(tampered)
        ops = WORK / "operations"
        ops.mkdir(exist_ok=True)
        tampered_op = ops / DECLARE.name
        tampered_op.write_bytes(DECLARE.read_bytes().replace(b"CASE WHEN v_agree = -1 THEN 0 ELSE 1 END", b"CASE WHEN v_agree = -1 THEN 0 ELSE 2 END", 1))
        assert mod.check(tampered_op) and "hashes to" in mod.check(tampered_op)[0], mod.check(tampered_op)
        renamed_op = ops / "vote_convention_other.sql"
        renamed_op.write_bytes(DECLARE.read_bytes())
        assert any("names" in p for p in mod.check(renamed_op)), mod.check(renamed_op)
        renamed = WORK / "000099_other.sql"
        renamed.write_bytes(UP.read_bytes())
        assert any("names" in p for p in mod.check(renamed)), mod.check(renamed)
        unmarked = WORK / "000098_unmarked.sql"
        unmarked.write_bytes(b"BEGIN;\nCOMMIT;\n")
        assert "0 ledger marker lines" in mod.check(unmarked)[0]
        p = subprocess.run([sys.executable, str(CHECKER)], capture_output=True, text=True)
        assert p.returncode == 0, p.stdout + p.stderr
        assert "operations/vote_convention_declare.sql" in p.stdout
    case("ledger checker: the committed migration and operation pass; an edited body, a renamed file and a missing marker fail", checker)

    # 6. Grants.
    def grants(db):
        sql("postgres", "DROP ROLE IF EXISTS polis_probe_reader; CREATE ROLE polis_probe_reader LOGIN;")
        apply(db)
        sql(db, "GRANT USAGE ON SCHEMA public TO vc_exec_only;")
        eq(val(db, "SELECT version || '|' || agree_value FROM public.vote_convention_current();", user="vc_exec_only"), "0|-1", "case 6")
        eq(val(db, "SELECT has_table_privilege('vc_exec_only', 'public.vote_convention', 'SELECT');"), "f", "case 6")
        fails(db, "SELECT * FROM public.vote_convention;", "42501", user="vc_exec_only")
        fails(db, "UPDATE public.vote_convention SET version = 1, agree_value = 1;", "42501", user="vc_exec_only")
        fails(db, "SELECT * FROM public.vote_insert(990001, 1, 1, 1::smallint);", "42501", user="vc_exec_only")
        eq(val(db, "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) a "
                       "WHERE p.oid = 'public.vote_insert(integer,integer,integer,smallint,smallint,boolean,integer)'::regprocedure "
                       "AND a.grantee = 0;"), "0", "case 6")
        eq(val(db, "SELECT has_function_privilege('vc_exec_only', 'public.vote_insert(integer,integer,integer,smallint,smallint,boolean,integer)', 'EXECUTE');"), "f", "case 6")
        # An operator grant to a separate server login is enough to write.
        # EXECUTE alone: vote_insert is SECURITY DEFINER (its FOR SHARE needs UPDATE on vote_convention,
        # which no role but the owner holds), so the writer needs no grant on votes.
        sql(db, "GRANT USAGE ON SCHEMA public TO vc_writer; "
                "GRANT EXECUTE ON FUNCTION public.vote_insert(integer,integer,integer,smallint,smallint,boolean,integer) TO vc_writer;")
        eq(val(db, "SELECT vote FROM public.vote_insert(990001, 1, 1, 1::smallint);", user="vc_writer"), "-1", "case 6")
        eq(val(db, "SELECT vote FROM votes_latest_unique WHERE zid = 990001;"), "-1", "case 6")
        # The probe reader: no direct grant (provision_login.py refuses one); it reads through PUBLIC EXECUTE.
        eq(val(db, "SELECT count(*) FROM (SELECT relacl FROM pg_class WHERE relnamespace = 'public'::regnamespace "
                       "AND relname IN ('vote_convention','vote_convention_history','schema_migrations','votes_semantic','votes_latest_unique_semantic')) c, "
                       "LATERAL aclexplode(c.relacl) a WHERE a.grantee = 'polis_probe_reader'::regrole;"), "0", "case 6")
        eq(val(db, "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.proname LIKE 'vote\\_%' "
                       "AND a.grantee = 'polis_probe_reader'::regrole;"), "0", "case 6")
        sql(db, "GRANT USAGE ON SCHEMA public TO polis_probe_reader;")
        eq(val(db, "SELECT agree_value FROM public.vote_convention_current();", user="polis_probe_reader"), "-1", "case 6")
        # The coordinator grants are recorded in the ledger note, exactly.
        eq(val(db, f"SELECT note FROM public.schema_migrations WHERE name = '{NAME}';"), EXPECTED_GRANT_NOTE, "case 6")
        # No coordinator role reads the semantic views (they read votes with the owner's rights).
        eq(val(db, "SELECT has_table_privilege('polis_coordinator_observer', 'public.votes_semantic', 'SELECT'), "
                       "has_table_privilege('polis_coordinator_control', 'public.votes_semantic', 'SELECT'), "
                       "has_table_privilege('polis_coordinator_observer', 'public.vote_convention', 'UPDATE');"), "f|f|f", "case 6")
        eq(val(db, "SELECT has_table_privilege('vc_writer', 'votes', 'INSERT');"), "f", "case 6")
        fails(db, "INSERT INTO votes (zid, pid, tid, vote) VALUES (990009, 1, 1, -1);", "42501", user="vc_writer")
        sql(db, "REVOKE USAGE ON SCHEMA public FROM vc_writer, vc_exec_only, polis_probe_reader;")
        down(db)
        eq(val(db, "SELECT count(*) FROM pg_shdepend d JOIN pg_database b ON b.oid = d.dbid AND b.datname = current_database() "
                       "WHERE d.refobjid IN (SELECT oid FROM pg_roles WHERE rolname IN ('vc_exec_only','vc_writer','polis_probe_reader'));"), "0", "case 6")
        eq(dump(db) == baseline, True, "case 6 dump")
    case("grants: EXECUTE-only role reads the convention, not the table; vote_insert not PUBLIC; probe reader "
         "has no direct grant; coordinator grants recorded; down removes them", grants)
    sql("postgres", "DROP ROLE IF EXISTS polis_probe_reader;")

    # 7. The ledger and the checksum self-test.
    def ledger(db):
        apply(db)
        raw = UP.read_bytes()
        expected = ledger_checksum(raw)
        in_file = re.search(rb"VALUES \('" + NAME.encode() + rb"', '([0-9a-f]{64})'", raw)
        assert in_file and in_file.group(1).decode() == expected, f"file carries {in_file and in_file.group(1)}, computed {expected}"
        assert expected != hashlib.sha256(raw).hexdigest()
        assert val(db, f"SELECT checksum FROM public.schema_migrations WHERE name = '{NAME}';") == expected
        stems = [p.stem for p in migrations]
        assert val(db, "SELECT string_agg(name, ',' ORDER BY name) FROM public.schema_migrations WHERE checksum = 'verified';") == ",".join(stems)
        eq(val(db, "SELECT count(*) FROM public.schema_migrations WHERE checksum = 'unverified';"), "0", "full chain: nothing unverified")
        assert val(db, "SELECT count(*) FROM public.schema_migrations;") == str(len(stems) + 1)
        assert val(db, "SELECT bool_and(note LIKE 'signature observed when the ledger was created: %') FROM public.schema_migrations WHERE checksum = 'verified';") == "t"
        fails(db, "INSERT INTO public.schema_migrations (name, checksum) VALUES ('000098_bad', 'pre-ledger');", "23514")
        # The ledger line is the file's last statement, followed only by COMMIT.
        code = [line for line in raw.decode().splitlines() if line.strip() and not line.startswith("--")]
        eq(code[-1], "COMMIT;", "last line")
        assert code[-2].startswith("INSERT INTO public.schema_migrations") and code[-2].endswith(MARKER.decode()), code[-2]
        fails(db, "INSERT INTO public.schema_migrations (name, checksum) VALUES ('000099_bad', 'short');", "23514")
        fails(db, "INSERT INTO public.schema_migrations (name, checksum) VALUES ('99_bad', 'pre-ledger');", "23514")
        # The operation file carries its own checksum the same way.
        in_op = re.search(rb"'vote_convention_declare', '([0-9a-f]{64})'\); " + MARKER, DECLARE.read_bytes())
        assert in_op and in_op.group(1).decode() == declare_checksum, "operation checksum"
    case("ledger: own row = sha256 of the file without its marker line; every earlier file verified from the catalog; "
         "last statement; the operation carries its checksum the same way", ledger)

    # 7b. A copy shaped like pol.is: the dormant files 000019, 000021, 000023 and 000024 were never applied.
    # The ledger says so (unverified, with the probe) instead of assuming them, and 000025 needs none of them.
    def ledger_dormant_absent(_db):
        name = "vc_dormant"
        sql("postgres", f"CREATE DATABASE {name} TEMPLATE template0;")
        try:
            dormant = {"000019_create_polis_queue", "000021_create_polis_coordinator", "000023_create_delphi_foundation",
                       "000024_create_polis_queue_large_class"}
            for path in migrations:
                if path.stem not in dormant:
                    sql(name, path.read_text())
            hold_votes(name)
            p = apply(name)
            assert DECLARE_NEEDED in p.stderr, p.stderr
            assert "migration ledger: 20 earlier files verified in the catalog; unverified: 000019_create_polis_queue, " \
                   "000021_create_polis_coordinator, 000023_create_delphi_foundation, 000024_create_polis_queue_large_class" in p.stderr, p.stderr
            eq(val(name, "SELECT string_agg(name, ',' ORDER BY name) FROM public.schema_migrations WHERE checksum = 'unverified';"),
               ",".join(sorted(dormant)), "unverified rows")
            eq(val(name, "SELECT note FROM public.schema_migrations WHERE name = '000019_create_polis_queue';"),
               "signature NOT observed when the ledger was created (the file may never have run here): table public.polis_queue_install", "probe named")
            eq(val(name, "SELECT count(*) FROM public.schema_migrations WHERE checksum = 'verified';"), "20", "verified rows")
            # Roles are cluster-wide: 000021 ran in vc_base, so the coordinator roles exist here too and
            # the grants are made; a cluster that never ran 000021 records 'grants: none'.
            assert val(name, "SELECT note FROM public.schema_migrations WHERE name = '{}';".format(NAME)) in (
                EXPECTED_GRANT_NOTE, "vote storage convention; grants: none")
            declare(name, "-1")
            eq(val(name, "SELECT version || '|' || agree_value FROM public.vote_convention_current();"), "0|-1", "declared without the dormant files")
            down(name)
            eq(val(name, "SELECT to_regclass('public.schema_migrations') IS NULL;"), "t", "down drops the ledger with its unverified rows")
        finally:
            sql("postgres", f"DROP DATABASE {name} WITH (FORCE);")
    case("ledger on a copy without the dormant 000019/000021/000023/000024: those rows are unverified with the probe named, "
         "000025 applies, declares and reverses without them", ledger_dormant_absent)

    # 7c. The prerequisites: no vote tables, no apply.
    def prerequisites(_db):
        name = "vc_empty"
        sql("postgres", f"CREATE DATABASE {name} TEMPLATE template0;")
        try:
            before = dump(name)
            p = fails(name, UP.read_text(), "P0780")
            assert "the vote tables are missing" in p.stderr, p.stderr
            assert dump(name) == before, "a refused apply changed the catalog"
            eq(val(name, "SELECT to_regclass('public.schema_migrations') IS NULL;"), "t", "no ledger either")
        finally:
            sql("postgres", f"DROP DATABASE {name} WITH (FORCE);")
    case("prerequisites: without the vote tables (000000, 000006) the migration refuses P0780 and creates nothing", prerequisites)

    # 7d. The apply wrapper: preflight, budgets, the lock the file takes, the post-check and its refusals.
    def wrapper(db):
        assert SEAL.is_file(), SEAL
        def run_wrapper(*extra, ok=True):
            cmd = ["bash", str(WRAPPER), "--free-bytes", str(50 * 1024 ** 3), *extra, "000025", "--",
                   "docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db]
            p = subprocess.run(cmd, text=True, capture_output=True, env=dict(os.environ, DATABASE_URL=""))
            if ok and p.returncode:
                raise AssertionError(p.stdout + p.stderr)
            return p
        hold_votes(db)
        p = run_wrapper("--preflight-only")
        assert "preflight passed (--preflight-only); nothing applied" in p.stdout, p.stdout
        eq(val(db, "SELECT to_regclass('public.vote_convention') IS NULL;"), "t", "preflight-only applied nothing")
        # An old open transaction: the preflight refuses before sending the file.
        holder = subprocess.Popen(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-At", "-U", "postgres", "-d", db],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        holder.stdin.write("BEGIN; SELECT 1 FROM votes LIMIT 1; SELECT pg_sleep(3); COMMIT;\n")
        holder.stdin.close()
        try:
            time.sleep(1.2)
            p = run_wrapper("--max-xact-age", "1", ok=False)
            assert p.returncode == 4 and "FAIL  xacts" in p.stdout and "REFUSED: preflight failed" in p.stderr, p.stdout + p.stderr
        finally:
            holder.wait(timeout=30)
        eq(val(db, "SELECT to_regclass('public.vote_convention') IS NULL;"), "t", "refused preflight applied nothing")
        # An ACCESS EXCLUSIVE holder on votes: the file waits its 5 s lock budget, then rolls back; the wrapper exits 5.
        before = dump(db)
        holder = subprocess.Popen(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-At", "-U", "postgres", "-d", db],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        holder.stdin.write("BEGIN; LOCK TABLE public.votes IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(9); COMMIT;\n")
        holder.stdin.close()
        try:
            for _ in range(100):
                if val(db, "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.relation = 'public.votes'::regclass "
                           "AND l.mode = 'AccessExclusiveLock' AND l.granted;") == "1":
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("lock holder did not start")
            t0 = time.monotonic()
            p = run_wrapper(ok=False)
            waited = time.monotonic() - t0
            assert p.returncode == 5 and "FAILED: 000025_vote_convention.sql did not apply" in p.stderr, p.stdout + p.stderr
            assert "lock_timeout" in p.stderr or "55P03" in p.stderr or "canceling statement" in p.stderr, p.stderr
            assert 4.5 <= waited < 12, f"rolled back after {waited:.1f}s"
            assert "lock: this file holds AccessShareLock on public.votes and public.votes_latest_unique" in p.stdout, p.stdout
        finally:
            holder.wait(timeout=60)
        assert dump(db) == before, "a failed apply changed the catalog"
        (WORK / "wrapper-lock.txt").write_text(f"apply rolled back behind an ACCESS EXCLUSIVE holder after {waited:.2f}s\n")
        # The apply itself.
        p = run_wrapper()
        for line in ("ok    seal:", "ok    server:", "ok    rights:", "ok    chain: the vote tables exist", "ok    rows: no vote convention object exists yet",
                     "budgets: lock_timeout=5s statement_timeout=60s transaction_timeout=120s idle_in_transaction_session_timeout=30s",
                     "applied: 000025_vote_convention.sql (post-check 1)", "convention: DECLARE_NEEDED (earlier files in the ledger: 24 verified, 0 unverified)",
                     "next: the database holds votes; declare its sign once"):
            assert line in p.stdout, (line, p.stdout)
        (WORK / "wrapper-apply.txt").write_text(p.stdout)
        eq(val(db, f"SELECT length(checksum) FROM public.schema_migrations WHERE name = '{NAME}';"), "64", "ledger row")
        eq(val(db, "SELECT vote FROM votes WHERE zid = 990000;"), "-1", "the stored vote is untouched")
        # A second run is refused at the preflight: the objects exist.
        p = run_wrapper(ok=False)
        assert p.returncode == 4 and "FAIL  rows: 13 of the 13 vote convention objects already exist" in p.stdout, p.stdout + p.stderr
        # After the declaration the post-apply state line reads GUARDED (shown here through a fresh database).
        name = "vc_wrap_empty"
        sql("postgres", f"CREATE DATABASE {name} TEMPLATE vc_base;")
        try:
            cmd = ["bash", str(WRAPPER), "--free-bytes", str(50 * 1024 ** 3), "000025", "--",
                   "docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", name]
            p = subprocess.run(cmd, text=True, capture_output=True)
            assert p.returncode == 0 and "convention: GUARDED v0 agree -1 (earlier files in the ledger: 24 verified, 0 unverified)" in p.stdout, p.stdout + p.stderr
            assert "next:" not in p.stdout
        finally:
            sql("postgres", f"DROP DATABASE {name} WITH (FORCE);")
        # The seal: a file that differs from down/000025-files.sha256 is refused before any check.
        p = subprocess.run(["bash", "-c", f"cd {ROOT} && shasum -a 256 -c {SEAL}"], text=True, capture_output=True)
        assert p.returncode == 0, p.stdout + p.stderr
    case("apply wrapper: --preflight-only applies nothing; an old transaction refuses (exit 4); an ACCESS EXCLUSIVE holder on votes "
         "makes the apply roll back on its 5 s lock budget (exit 5, catalog unchanged); the apply passes every check, records the "
         "ledger row and prints DECLARE_NEEDED / GUARDED; a second run is refused (exit 4); the seal verifies", wrapper)

    # 8. The restore-detection rule (the query in docs/vote-convention.md, verbatim).
    def restore(db):
        assert val(db, "SELECT to_regclass('public.vote_convention') IS NOT NULL;") == "f"
        hold_votes(db)
        apply(db)
        eq(val(db, restore_sql), "undeclared", "a database that held votes: declare it")
        declare(db, "-1")
        eq(val(db, restore_sql), "pre-flip", "declared -1")
        sql(db, "INSERT INTO public.schema_migrations (name, checksum) VALUES ('000026_vote_sign_unflip', repeat('a', 64));")
        eq(val(db, restore_sql), "corrupt", "the un-flip row at version 0")
        flip(db)
        eq(val(db, restore_sql), "post-flip", "flip and row")
        sql(db, "DELETE FROM public.schema_migrations WHERE name = '000026_vote_sign_unflip';")
        eq(val(db, restore_sql), "corrupt", "version 1 without the row, not a declaration")
        sql(db, "ALTER TABLE public.vote_convention DISABLE TRIGGER USER; DELETE FROM public.vote_convention; ALTER TABLE public.vote_convention ENABLE TRIGGER USER;")
        eq(val(db, restore_sql), "undeclared", "no row at all: the components refuse until it is declared")
    case("restore detection: absent table -> apply; no row = undeclared; declared/seeded = pre-flip; flip+row = post-flip; "
         "either alone = corrupt", restore)

    def restore_declared_plus(db):
        hold_votes(db)
        apply(db)
        declare(db, "1")
        assert val(db, restore_sql) == "declared-agree-plus"
    case("restore detection: a deployment that declared +1 is its own state, not corruption", restore_declared_plus)

    # 9. Down refuses when dropping would lose information; drops an undeclared database.
    def down_refusals(db):
        apply(db)
        flip(db)
        before = dump(db)
        fails(db, DOWN.read_text(), "P0789")
        assert dump(db) == before and val(db, "SELECT version FROM public.vote_convention;") == "1"
    case("down refuses P0789 after the convention moved; nothing changed", down_refusals)

    def down_later(db):
        apply(db)
        sql(db, "INSERT INTO public.schema_migrations (name, checksum) VALUES ('000027_something_later', repeat('b', 64));")
        fails(db, DOWN.read_text(), "P0789")
        sql(db, "DELETE FROM public.schema_migrations WHERE name = '000027_something_later';")
        sql(db, "DROP VIEW public.votes_semantic;")
        fails(db, DOWN.read_text(), "P0789")   # a partial copy
    case("down refuses P0789 with a later ledger row, and on a partial copy", down_later)

    def down_undeclared(db):
        hold_votes(db)
        apply(db)
        eq(val(db, "SELECT count(*) FROM public.vote_convention;"), "0", "undeclared")
        down(db)
        assert dump(db) == baseline, "down of an undeclared database did not restore the catalog"
        eq(val(db, "SELECT vote FROM votes WHERE zid = 990000;"), "-1", "the vote is untouched")
        # Declared at -1 (the seed's state): down is allowed too; the row carried no information the data lacks.
        apply(db)
        declare(db, "-1")
        down(db)
        assert dump(db) == baseline
        # The row removed by hand with history behind it: refuse (inspect first).
        apply(db)
        declare(db, "-1")
        sql(db, "ALTER TABLE public.vote_convention DISABLE TRIGGER USER; DELETE FROM public.vote_convention; ALTER TABLE public.vote_convention ENABLE TRIGGER USER;")
        fails(db, DOWN.read_text(), "P0789")
    case("down of an undeclared database, and of one declared -1, restores the catalog exactly; a row removed by hand "
         "with history behind it refuses P0789", down_undeclared)

    # 10. The full chain on an empty database, three ways; and on a database holding votes.
    def chain(_db):
        # The chain through 000025; later files (000026 on) follow it and are
        # proven by their own down tests (test_000026_down.sh runs the whole
        # chain up, down and up).
        everything = [p for p in sorted(ROOT.glob("0*.sql")) if int(p.name[:6]) <= 25]
        assert everything[-1] == UP, [p.name for p in everything[-3:]]
        assert [int(p.name[:6]) for p in everything] == [n for n in range(25) if n != 20] + [25], [p.name for p in everything]
        for name, how in (("vc_chain_f", "file"), ("vc_chain_c", "single-call"), ("vc_chain_v", "with-votes")):
            sql("postgres", f"CREATE DATABASE {name} TEMPLATE template0;")
            try:
                for path in everything:
                    if how == "with-votes" and path == UP:
                        hold_votes(name)
                    if how == "single-call" and path == UP:
                        run(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", name, "-c", path.read_text()])
                    else:
                        sql(name, path.read_text())
                if how == "with-votes":
                    assert val(name, "SELECT count(*) FROM public.vote_convention;") == "0"
                    declare(name, "-1")
                assert val(name, "SELECT version || '|' || agree_value FROM public.vote_convention_current();") == "0|-1"
                assert val(name, "SELECT count(*) FROM public.schema_migrations;") == str(len(everything))
                if how == "file":
                    # run-migrations.sh replays the directory without ON_ERROR_STOP (the CI path):
                    # 000025 refuses and rolls back; the convention and ledger are unchanged.
                    # (000023, the Delphi job table, refuses its own replay the same way.)
                    before = val(name, "SELECT row_to_json(c)::text FROM public.vote_convention c;") + \
                        val(name, "SELECT string_agg(name || checksum, ',' ORDER BY name) FROM public.schema_migrations;")
                    p = sql(name, UP.read_text(), ok=False, stop=False)
                    assert "P0780" in p.stderr or "already exist" in p.stderr, p.stderr
                    after = val(name, "SELECT row_to_json(c)::text FROM public.vote_convention c;") + \
                        val(name, "SELECT string_agg(name || checksum, ',' ORDER BY name) FROM public.schema_migrations;")
                    assert before == after
            finally:
                sql("postgres", f"DROP DATABASE {name} WITH (FORCE);")
    case("chain: 000000..000024 then 000025 on an empty database (psql -f and one driver call) seeds v0; on a database "
         "holding votes it leaves the row for the declaration; replay without ON_ERROR_STOP is harmless", chain)

    for login in LOGINS:
        sql("postgres", f"DROP OWNED BY {login} CASCADE;", ok=False)
    sql("postgres", "DROP DATABASE vc_base WITH (FORCE);")
    for login in LOGINS:
        sql("postgres", f"DROP ROLE IF EXISTS {login};")

    summary = {"schema": "polis-vote-convention-migration-test/3", "passed": len(RESULTS) - len(FAILURES) - len(SKIPPED),
               "failed": len(FAILURES), "failures": FAILURES, "skipped": len(SKIPPED), "skip_reasons": SKIPPED, "cases": RESULTS,
               "migration_count_before_000025": len(migrations),
               "source_sha256": {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in [UP, DOWN, DECLARE, DECLARE_SH, CHECKER, WRAPPER, SEAL, Path(__file__), ROOT / "down/test_000025_down.sh",
                                           ROOT / "down/test_000025.compose.yml"]},
               "ledger_checksum": ledger_checksum(UP.read_bytes()),
               "declare_checksum": declare_checksum,
               "baseline_sha256": hashlib.sha256(baseline.encode()).hexdigest()}
    (WORK / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: summary[k] for k in ("passed", "failed", "skipped")}))
    if FAILURES:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
