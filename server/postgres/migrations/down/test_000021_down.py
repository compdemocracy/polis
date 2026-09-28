"""Real PostgreSQL migration/reversal controls; only the wrapper's own container.

No DATABASE_URL is accepted. Every case creates a disposable database cloned
from the full pre-000021 migration chain, and cleanup never targets other roles.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

CONTAINER, WORK = sys.argv[1], Path(sys.argv[2])
if not re.fullmatch(r"[0-9a-f]{64}|p027-m21-[a-z0-9-]+-postgres-1", CONTAINER):
    raise SystemExit("wrapper-owned container required")
ROOT = Path(__file__).resolve().parent.parent
UP = ROOT / "000021_create_polis_coordinator.sql"
DOWN = ROOT / "down/000021_drop_polis_coordinator.sql"
ROLES = ("polis_coordinator_observer", "polis_coordinator_control", "polis_coordinator_owner", "polis_coordinator_publication_owner", "polis_coordinator_publisher")
RESULTS = []
FAILURES = []


def run(args, content=None, ok=True):
    p = subprocess.run(["docker", "exec", "-i", CONTAINER, *args],
                       input=content, text=True, capture_output=True)
    if ok and p.returncode:
        raise AssertionError(p.stdout + p.stderr)
    return p


def sql(db, content, ok=True, user="postgres"):
    return run(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", db], content, ok)


def apply(db, ok=True, content=None):
    return sql(db, UP.read_text() if content is None else content, ok)


def down(db, force=False, ok=True):
    return run(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-v", f"force={int(force)}",
                "-U", "postgres", "-d", db], DOWN.read_text(), ok)


def dump(db):
    text = run(["pg_dump", "-U", "postgres", "--schema-only", "-d", db]).stdout
    return "\n".join(line for line in text.splitlines() if line.strip()
                     and not line.startswith(("--", "\\restrict ", "\\unrestrict "))) + "\n"


def role_state():
    return sql("postgres", "SELECT row_to_json(r) FROM (SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles WHERE rolname LIKE 'polis_coordinator_%' ORDER BY rolname) r;").stdout


def receipt_rows(db):
    return sql(db, "SELECT row_to_json(r) FROM polis_coordinator_install r; SELECT row_to_json(r) FROM polis_coordinator_install_roles r ORDER BY role_name; SELECT row_to_json(r) FROM polis_coordinator_install_grants r ORDER BY object_kind,object_name,column_name,grantee,privilege;").stdout


def case(name, body):
    db = f"c{len(RESULTS):02d}"
    sql("postgres", f"CREATE DATABASE {db} TEMPLATE coordinator_base;")
    try:
        body(db)
        RESULTS.append({"case": name, "status": "PASS"})
        print(f"PASS {len(RESULTS):02d}: {name}", flush=True)
    except Exception as exc:
        FAILURES.append({"case": name, "error": str(exc)})
        RESULTS.append({"case": name, "status": "FAIL"})
        print(f"FAIL {len(RESULTS):02d}: {name}: {exc}", flush=True)
    finally:
        sql("postgres", f"DROP DATABASE {db} WITH (FORCE);")
        # Only roles created for this isolated test case, after its DB is gone.
        for role in ROLES:
            sql("postgres", f"DROP ROLE IF EXISTS {role};")


def refuses_both(db, pattern="refusing"):
    before, roles = dump(db), role_state()
    for force in (False, True):
        p = down(db, force=force, ok=False)
        assert p.returncode != 0 and pattern in p.stderr, p.stdout + p.stderr
        assert dump(db) == before, "refusal changed schema/ACL"
        assert role_state() == roles, "refusal changed roles"


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    sql("postgres", "CREATE DATABASE coordinator_base;")
    migrations = [p for p in sorted(ROOT.glob("0*.sql")) if p.name < UP.name]
    for path in migrations:
        sql("coordinator_base", path.read_text())
    baseline = dump("coordinator_base")
    (WORK / "baseline.sql").write_text(baseline)
    (WORK / "profile.txt").write_text(sql("postgres", "SELECT version(); SHOW server_encoding; SELECT datcollate,datctype FROM pg_database WHERE datname=current_database();").stdout)

    def roundtrip(db):
        apply(db)
        first, prov = dump(db), receipt_rows(db)
        apply(db)
        assert dump(db) == first and receipt_rows(db) == prov, "replay changed catalog/provenance"
        assert sql(db, "SELECT count(*) FROM pg_attribute WHERE attrelid=ANY(ARRAY['math_ticks'::regclass,'math_main'::regclass,'math_bidtopid'::regclass,'math_ptptstats'::regclass]) AND attname IN ('publisher_epoch','operation_id','input_checkpoint','original_bytes','original_sha256') AND NOT attisdropped;").stdout.strip() == "0"
        down(db)
        assert dump(db) == baseline and role_state() == "", "round trip changed baseline"
        (WORK / "post-down.sql").write_text(dump(db))
        down(db)
        apply(db)
        down(db)
        assert dump(db) == baseline
    case("full-chain apply/replay/down/noop/reapply; math columns unchanged", roundtrip)
    case("never installed down is no-op in both force modes", lambda db: (down(db), down(db, True)))

    def live(db):
        apply(db)
        sql(db, "INSERT INTO conversations(zid,topic) VALUES (990001,'generated 000021'); INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES ('generated',990001,'owner-a',1,clock_timestamp()+interval '1 minute');")
        p = down(db, ok=False)
        assert p.returncode and "contains data" in p.stderr
        assert sql(db, "SELECT count(*) FROM polis_coordinator_leases;").stdout.strip() == "1"
        down(db, True)
        assert sql(db, "SELECT topic FROM conversations WHERE zid=990001;").stdout.strip() == "generated 000021"
        assert dump(db) == baseline
    case("live data refuses normally; force preserves source conversation", live)

    def sequence(db):
        sql(db, "INSERT INTO conversations(zid) VALUES (990001); INSERT INTO math_main(zid,math_env,caching_tick,data,last_vote_timestamp) VALUES(990001,'generated',734,'{}',0);")
        apply(db)
        assert sql(db, "SELECT nextval('polis_coordinator_caching_tick');").stdout.strip() == "735"
        apply(db)
        assert sql(db, "SELECT nextval('polis_coordinator_caching_tick');").stdout.strip() == "736"
        assert down(db, ok=False).returncode
        down(db, True)
        assert sql(db, "SELECT caching_tick FROM math_main WHERE zid=990001;").stdout.strip() == "734"
    case("sequence seeded above existing; replay does not reset; used sequence guarded", sequence)

    def drift_case(statement, pattern="refusing"):
        def body(db):
            apply(db)
            sql(db, statement)
            before = dump(db)
            refuses_both(db, pattern)
            assert apply(db, ok=False).returncode and dump(db) == before
        return body

    for name, statement in [
        ("added column", "ALTER TABLE polis_coordinator_leases ADD COLUMN alien text;"),
        ("dropped constraint", "ALTER TABLE polis_coordinator_payloads DROP CONSTRAINT polis_coordinator_payloads_check;"),
        ("added index", "CREATE INDEX polis_coordinator_extra ON polis_coordinator_leases(owner_epoch);"),
        ("RLS", "ALTER TABLE polis_coordinator_leases DISABLE ROW LEVEL SECURITY;"),
        ("ACL", "GRANT UPDATE ON polis_coordinator_generations TO polis_coordinator_control;"),
        ("sequence start", "ALTER SEQUENCE polis_coordinator_caching_tick START WITH 777;"),
        ("sequence definition", "ALTER SEQUENCE polis_coordinator_caching_tick CACHE 5;"),
        ("function body", "CREATE OR REPLACE FUNCTION pc_canonical(p_value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS 'SELECT ''drift''::text';"),
        ("public function collision", "CREATE FUNCTION pc_collision(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';"),
    ]:
        case(f"catalog {name} drift: both downs and replay refuse", drift_case(statement))

    for name, statement in [
        ("missing install", "DELETE FROM polis_coordinator_install;"),
        ("missing role record", "DELETE FROM polis_coordinator_install_roles WHERE role_name='polis_coordinator_control';"),
        ("missing grant record", "DELETE FROM polis_coordinator_install_grants WHERE grantee='polis_coordinator_control';"),
        ("changed created flag", "UPDATE polis_coordinator_install_roles SET created=false;"),
        ("changed prior grant flag", "UPDATE polis_coordinator_install_grants SET prior_present=true;"),
        ("foreign grantor", "UPDATE polis_coordinator_install_grants SET grantor='unrelated';"),
        ("changed role identity", "UPDATE polis_coordinator_install_roles SET role_oid=0;"),
        ("corrupt fingerprint", "UPDATE polis_coordinator_install SET catalog_fingerprint=repeat('0',32);"),
    ]:
        case(f"provenance {name}: both downs and replay refuse", drift_case(statement))

    def constraints(db):
        apply(db)
        for q in [
            "UPDATE polis_coordinator_install_grants SET prior_present=NULL",
            "UPDATE polis_coordinator_install_roles SET created=NULL",
            "UPDATE polis_coordinator_install_grants SET prior_grantable=NULL",
            "UPDATE polis_coordinator_install_grants SET grantee=NULL",
            "UPDATE polis_coordinator_install_roles SET role_name='unrelated'",
            "UPDATE polis_coordinator_install_grants SET prior_present=false,prior_grantable=true",
        ]:
            assert sql(db, q, ok=False).returncode, q
        down(db)
    case("six malformed provenance controls rejected by typed constraints", constraints)

    for name, statement in [
        ("unrelated owned table", "CREATE TABLE unrelated(v text); INSERT INTO unrelated VALUES('keep'); ALTER TABLE unrelated OWNER TO polis_coordinator_owner;"),
        ("new role setting", "ALTER ROLE polis_coordinator_control SET statement_timeout='3s';"),
        ("new role membership", "GRANT polis_coordinator_control TO postgres;"),
        ("new external grant", "GRANT SELECT ON votes TO polis_coordinator_control;"),
    ]:
        def extra(db, statement=statement):
            apply(db); sql(db, statement); refuses_both(db, "refusing to drop role")
        case(f"created-role belt protects {name} in both modes", extra)

    witnesses = [
        ("owner schema USAGE", "polis_coordinator_owner", "GRANT USAGE ON SCHEMA public TO polis_coordinator_owner"),
        ("owner schema CREATE", "polis_coordinator_owner", "GRANT CREATE ON SCHEMA public TO polis_coordinator_owner"),
        ("owner SELECT", "polis_coordinator_owner", "GRANT SELECT ON conversations TO polis_coordinator_owner"),
        ("owner UPDATE(topic)", "polis_coordinator_owner", "GRANT UPDATE(topic) ON conversations TO polis_coordinator_owner"),
        ("owner REFERENCES(zid)", "polis_coordinator_owner", "GRANT REFERENCES(zid) ON conversations TO polis_coordinator_owner"),
        ("pre-existing grant option", "polis_coordinator_owner", "GRANT USAGE ON SCHEMA public TO polis_coordinator_owner WITH GRANT OPTION"),
        ("control schema USAGE and unrelated grant", "polis_coordinator_control", "GRANT USAGE ON SCHEMA public TO polis_coordinator_control; GRANT SELECT ON votes TO polis_coordinator_control"),
        ("publisher schema USAGE", "polis_coordinator_publisher", "GRANT USAGE ON SCHEMA public TO polis_coordinator_publisher"),
    ]
    for table in ("math_ticks", "math_bidtopid", "math_ptptstats", "math_main"):
        for privilege in ("SELECT", "INSERT", "UPDATE"):
            witnesses.append((f"publication owner {table} {privilege}", "polis_coordinator_publication_owner",
                              f"GRANT {privilege} ON {table} TO polis_coordinator_publication_owner"))
    witnesses.append(("publication owner math grant option", "polis_coordinator_publication_owner",
                      "GRANT UPDATE ON math_main TO polis_coordinator_publication_owner WITH GRANT OPTION"))
    for table in ("math_main", "math_ticks", "math_bidtopid", "math_ptptstats"):
        for option in ("", " WITH GRANT OPTION"):
            witnesses.append((f"observer {table} SELECT{option}", "polis_coordinator_observer",
                              f"GRANT SELECT ON {table} TO polis_coordinator_observer{option}"))
    for name, role, grant in witnesses:
        def witness(db, role=role, grant=grant):
            sql(db, f"CREATE ROLE {role} NOLOGIN; ALTER ROLE {role} SET statement_timeout='3s'; {grant};")
            before, roles = dump(db), role_state()
            apply(db); apply(db); down(db)
            assert dump(db) == before and role_state() == roles, "adopted role/grant/setting changed"
            p = down(db, ok=False)
            assert p.returncode and "refusing" in p.stderr, "role alone must not be inferred as owned"
        case(f"coalescing/adopted {name} preserved byte-for-byte", witness)

    def privilege(db):
        apply(db)
        # Inspect effective permissions under SET ROLE, including PUBLIC grants.
        for role, query, expected in [
            ("polis_coordinator_control", "SELECT has_table_privilege(current_user,'polis_coordinator_generations','INSERT')", "f"),
            ("polis_coordinator_publisher", "SELECT has_table_privilege(current_user,'polis_coordinator_leases','UPDATE')", "f"),
            ("polis_coordinator_publisher", "SELECT has_table_privilege(current_user,'polis_coordinator_payloads','UPDATE')", "f"),
            ("polis_coordinator_publisher", "SELECT has_table_privilege(current_user,'polis_coordinator_payloads','DELETE')", "f"),
            ("polis_coordinator_control", "SELECT has_table_privilege(current_user,'math_main','UPDATE')", "f"),
            ("polis_coordinator_publisher", "SELECT has_table_privilege(current_user,'math_main','UPDATE')", "f"),
            ("polis_coordinator_control", "SELECT has_table_privilege(current_user,'polis_coordinator_leases','UPDATE')", "t"),
        ]:
            assert sql(db, f"SET ROLE {role}; {query};").stdout.splitlines()[-1] == expected
        down(db)
    case("control/publisher capabilities separated; no math writes or receipt rewrite", privilege)

    def originals(db):
        apply(db)
        sql(db, "INSERT INTO conversations(zid) VALUES(990001); INSERT INTO polis_coordinator_generations(math_env,zid,math_tick,caching_tick,owner_id,publisher_epoch,operation_id,capability_sha256,expected_tick,input_checkpoint) VALUES('generated',990001,0,1,'owner-a',1,'op-a',repeat('a',64),NULL,'{}');")
        p = sql(db, "INSERT INTO polis_coordinator_payloads VALUES('generated',990001,0,'main',convert_to('{}','UTF8'),repeat('0',64),repeat('a',64));", ok=False)
        assert p.returncode and "check constraint" in p.stderr
        sql(db, "INSERT INTO polis_coordinator_payloads VALUES('generated',990001,0,'main',convert_to('{}','UTF8'),encode(sha256(convert_to('{}','UTF8')),'hex'),repeat('a',64));")
        assert sql(db, "INSERT INTO polis_coordinator_generations(math_env,zid,math_tick,caching_tick,owner_id,publisher_epoch,operation_id,capability_sha256,expected_tick,input_checkpoint) VALUES('generated',990001,1,2,'owner-a',1,'op-a',repeat('a',64),0,'{}');", ok=False).returncode
        assert sql(db, "INSERT INTO polis_coordinator_payloads SELECT math_env,zid,9,payload_kind,original_bytes,original_sha256,storage_sha256 FROM polis_coordinator_payloads;", ok=False).returncode
        down(db, True)
    case("original byte integrity, operation uniqueness and generation FK controls", originals)

    def writer_race(db):
        apply(db)
        sql(db, "INSERT INTO conversations(zid) VALUES(990001);")
        proc = subprocess.Popen(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        proc.stdin.write("BEGIN; INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('generated',990001,'owner-a',1,clock_timestamp()+interval '1 minute'); SELECT pg_sleep(2); COMMIT;\n")
        proc.stdin.close()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if sql(db, "SELECT count(*) FROM pg_locks WHERE relation='polis_coordinator_leases'::regclass AND mode='RowExclusiveLock' AND granted;").stdout.strip() == "1":
                break
            time.sleep(0.05)
        else:
            raise AssertionError("writer never acquired lock")
        p = down(db, ok=False)
        assert p.returncode and "contains data" in p.stderr, p.stderr
        assert proc.wait(timeout=5) == 0
        assert sql(db, "SELECT count(*) FROM polis_coordinator_leases;").stdout.strip() == "1"
        down(db, True)
    case("concurrently committed writer seen under down lock; no row lost", writer_race)

    def bypass_live(db):
        apply(db)
        sql(db, "INSERT INTO conversations(zid) VALUES(990001); INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('generated',990001,'owner-a',1,clock_timestamp()+interval '1 minute');")
        assert down(db, ok=False).returncode
        mutated = DOWN.read_text().replace("current_setting('polis_coordinator.force') <> '1' AND", "false AND")
        assert mutated != DOWN.read_text()
        p = sql(db, mutated)
        assert p.returncode == 0
        assert sql(db, "SELECT to_regclass('polis_coordinator_leases') IS NULL;").stdout.strip() == "t"
        # The real live-row test's nonzero/refusal assertion rejects this mutant.
    case("negative control: removing live-data guard permits forbidden down", bypass_live)

    def bypass_provenance(db):
        apply(db)
        sql(db, "UPDATE polis_coordinator_install SET provenance_fingerprint=repeat('0',32);")
        refuses_both(db)
        mutated = DOWN.read_text().replace(" SELECT pg_temp.pc_assert_provenance();", " -- MUTANT: provenance validation removed")
        assert mutated != DOWN.read_text()
        assert sql(db, mutated).returncode == 0
        # Both-force corruption cases would fail their refusal assertion.
    case("negative control: removing provenance guard permits corrupt down", bypass_provenance)

    def arm(db, operation="op-a", epoch=1, owner="owner-a", expected="NULL", duration="interval '1 minute'", margin=500):
        sql(db, f"""INSERT INTO conversations(zid) VALUES(990001) ON CONFLICT DO NOTHING;
        INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at,
         dispatch_operation_id,dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_expected_tick,dispatch_margin_ms)
        VALUES('generated',990001,'{owner}',{epoch},clock_timestamp()+{duration},'{operation}',
         encode(sha256(decode(repeat('ab',32),'hex')),'hex'),encode(sha256(convert_to('{{}}'::jsonb::text,'UTF8')),'hex'),{expected},{margin})
        ON CONFLICT(math_env,zid) DO UPDATE SET owner_id=excluded.owner_id,owner_epoch=excluded.owner_epoch,
         expires_at=excluded.expires_at,dispatch_operation_id=excluded.dispatch_operation_id,
         dispatch_capability_sha256=excluded.dispatch_capability_sha256,dispatch_checkpoint_sha256=excluded.dispatch_checkpoint_sha256,
         dispatch_expected_tick=excluded.dispatch_expected_tick,dispatch_margin_ms=excluded.dispatch_margin_ms;""")
        sql(db,"INSERT INTO polis_coordinator_budgets VALUES('generated',8,16777216) ON CONFLICT DO NOTHING;")
        admitted=sql(db,f"SET ROLE polis_coordinator_control; SELECT pc_admit('generated',990001,'{owner}',{epoch},'{operation}',repeat('a',64),2097152);",ok=False)
        if admitted.returncode:
            assert 'ADMISSION_TICK_CONFLICT' in admitted.stderr or 'LEASE-EXPIRED' in admitted.stderr,admitted.stderr


    def call(db, operation="op-a", epoch=1, owner="owner-a", expected="NULL", capability="ab", checkpoint="{}", ok=True):
        return sql(db, f"""SELECT * FROM pc_publish('generated',990001,'{owner}',{epoch},'{operation}',
         decode(repeat('{capability}',32),'hex'),{expected},'{checkpoint}',
         convert_to('{{"zid":990001,"lastVoteTimestamp":0,"value":1.0}}','UTF8'),
         convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'),
         convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'));""",ok=ok,user="p027_m21_publisher")

    def publication_case(name, body):
        def wrapped(db):
            apply(db)
            sql(db, "CREATE ROLE p027_m21_publisher LOGIN IN ROLE polis_coordinator_publisher;")
            sql(db, "INSERT INTO polis_coordinator_namespaces VALUES('generated','python',128); INSERT INTO polis_coordinator_principals SELECT oid,rolname,'generated',false FROM pg_roles WHERE rolname IN ('postgres','p027_m21_publisher');")
            try:
                body(db)
            finally:
                sql(db, "DROP ROLE p027_m21_publisher;")
            down(db, True)
        case(name, wrapped)

    def published(db):
        arm(db)
        assert call(db).stdout.strip().startswith("committed|0|")
        assert sql(db, "SELECT count(*) FROM polis_coordinator_payloads;").stdout.strip() == "3"
        assert sql(db, "SELECT count(DISTINCT math_tick) FROM (SELECT math_tick FROM math_ticks UNION ALL SELECT math_tick FROM math_main UNION ALL SELECT math_tick FROM math_bidtopid UNION ALL SELECT math_tick FROM math_ptptstats) r;").stdout.strip() == "1"
        assert call(db).stdout.strip().startswith("already_committed|0|")
        assert sql(db, "SELECT last_value FROM polis_coordinator_caching_tick;").stdout.strip() == "1"
        for table in ("math_ticks", "math_main", "math_bidtopid", "math_ptptstats", "polis_coordinator_leases", "polis_coordinator_generations", "polis_coordinator_payloads"):
            assert sql(db, f"DELETE FROM {table};", ok=False, user="p027_m21_publisher").returncode
        assert sql(db, "SELECT nextval('polis_coordinator_caching_tick');",ok=False,user="p027_m21_publisher").returncode
        assert sql(db, "SET ROLE polis_coordinator_control; SELECT * FROM pc_publish('generated',990001,'owner-a',1,'op-a',decode(repeat('ab',32),'hex'),NULL,'{}','{}','{}','{}');",ok=False).returncode
    publication_case("real restricted publisher commits coherent rows/receipts and retries idempotently; direct writes denied", published)

    def history_floor(db, mode):
        arm(db);assert call(db).stdout.strip().startswith("committed|0|")
        arm(db,operation="op-b",epoch=2,expected="0")
        assert call(db,operation="op-b",epoch=2,expected="0").stdout.strip().startswith("committed|1|")
        if mode == "deleted":
            for table in ("math_ticks","math_main","math_bidtopid","math_ptptstats"):
                sql(db,f"DELETE FROM {table};")
        else:
            sql(db,"UPDATE math_ticks SET math_tick=0;")
        arm(db,operation="op-c",epoch=3,expected="1")
        assert call(db,operation="op-c",epoch=3,expected="1").stdout.strip().startswith("committed|2|")
        assert sql(db,"SELECT count(*),min(math_tick),max(math_tick) FROM polis_coordinator_generations;").stdout.strip()=="3|0|2"
        assert sql(db,"SELECT count(*) FROM polis_coordinator_payloads;").stdout.strip()=="9"
        assert sql(db,"SELECT count(DISTINCT math_tick),min(math_tick) FROM (SELECT math_tick FROM math_ticks UNION ALL SELECT math_tick FROM math_main UNION ALL SELECT math_tick FROM math_bidtopid UNION ALL SELECT math_tick FROM math_ptptstats) t;").stdout.strip()=="1|2"
    for mode in ("deleted","regressed"):
        publication_case(f"retained history repairs {mode} current generation without tick reuse",lambda db,mode=mode:history_floor(db,mode))

    def absent_stale_expected(db):
        arm(db);assert call(db).stdout.strip().startswith("committed|0|")
        sql(db,"DELETE FROM math_ticks;")
        arm(db,operation="op-b",epoch=2)
        assert "OPERATION_NOT_ADMITTED" in call(db,operation="op-b",epoch=2,ok=False).stderr
        assert sql(db,"SELECT count(*) FROM math_ticks;").stdout.strip()=="0"
        assert sql(db,"SELECT count(*) FROM polis_coordinator_generations;").stdout.strip()=="1"
    publication_case("missing current pointer cannot reset expected tick below retained history",absent_stale_expected)

    def history_mutant(db):
        arm(db);assert call(db).stdout.strip().startswith("committed|0|")
        sql(db,"DELETE FROM math_ticks;")
        original=sql(db,"SELECT pg_get_functiondef('pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea)'::regprocedure);").stdout
        line=" SELECT greatest(current_tick,max(g.math_tick)) INTO current_tick\n FROM public.polis_coordinator_generations g WHERE g.zid=p_zid AND g.math_env=p_env;"
        assert original.count(line)==1
        floor=" SELECT greatest(current_tick,(SELECT f.math_tick FROM public.polis_coordinator_floors f WHERE f.math_env=p_env AND f.zid=p_zid)) INTO current_tick;"
        assert original.count(floor)==1
        sql(db,original.replace(line," -- scratch history-floor mutation").replace(floor," -- scratch compact-floor mutation"))
        try:
            arm(db,operation="op-b",epoch=2,expected="0")
            result=call(db,operation="op-b",epoch=2,expected="0")
            assert not result.stdout.strip().startswith("committed|1|") # intact repair oracle fails
            assert result.stdout.strip().startswith("conflict|")
        finally:
            sql(db,original)
    publication_case("negative control: removed history floor fails the missing-pointer repair oracle",history_mutant)

    def refused(db, changes, code):
        arm(db)
        p = call(db,ok=False,**changes)
        assert p.returncode and code in p.stderr,p.stderr
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="0"
        assert sql(db,"SELECT count(*) FROM polis_coordinator_generations;").stdout.strip()=="0"
    for label,changes,code in [
        ("stale owner", {"owner":"owner-b"}, "FENCED"),
        ("stale epoch", {"epoch":2}, "FENCED"),
        ("wrong capability", {"capability":"cd"}, "DISPATCH_IDENTITY_CONFLICT"),
        ("changed operation", {"operation":"op-b"}, "DISPATCH_IDENTITY_CONFLICT"),
        ("changed checkpoint", {"checkpoint":'{"source":"wrong"}'}, "DISPATCH_IDENTITY_CONFLICT"),
        ("changed expected tick", {"expected":"0"}, "DISPATCH_IDENTITY_CONFLICT"),
    ]:
        publication_case(f"publication refuses {label} without writes",lambda db, changes=changes,code=code: refused(db,changes,code))

    def expired(db):
        arm(db,duration="interval '-1 second'")
        p=call(db,ok=False)
        assert p.returncode and 'LEASE-EXPIRED' in p.stderr
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="0"
    publication_case("expired lease refuses publication",expired)

    def final_margin(db):
        arm(db,duration="interval '30 seconds'",margin=60000)
        p=call(db,ok=False)
        assert p.returncode and 'LEASE-EXPIRED' in p.stderr
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="0"
        assert sql(db,"SELECT count(*) FROM polis_coordinator_generations;").stdout.strip()=="0"
        # nextval is nontransactional: this proves the write sequence reached the
        # final check and rolled back, rather than refusing at admission.
        assert sql(db,"SELECT is_called FROM polis_coordinator_caching_tick;").stdout.strip()=="t"
    publication_case("positive but insufficient final lease margin rolls back all writes",final_margin)

    def overwritten(db):
        arm(db); assert call(db).stdout.startswith('committed|0|')
        arm(db,operation='op-b',epoch=2,expected='0')
        assert call(db,operation='op-b',epoch=2,expected='0').stdout.startswith('committed|1|')
        assert call(db).stdout.startswith('already_committed|0|')
        p=call(db,capability='cd',ok=False)
        assert p.returncode and 'OPERATION_IDENTITY_CONFLICT' in p.stderr
        assert sql(db,"SELECT math_tick FROM math_main;").stdout.strip()=="1"
        assert sql(db,"SELECT count(*) FROM polis_coordinator_generations;").stdout.strip()=="2"
    publication_case("exact lost-ack proof survives newer publication/takeover; forged retry refused",overwritten)

    def actual_conflict(db):
        arm(db)
        sql(db,"INSERT INTO math_ticks(zid,math_env,math_tick) VALUES(990001,'generated',7);")
        assert call(db).stdout.strip()=='conflict|7|'
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="0"
    publication_case("expected-tick conflict performs no writes",actual_conflict)

    def canonical(db):
        value='{"z":-0.0,"nested":[1.000,1e3,1e-3],"a":"é"}'
        result=sql(db,f"SELECT pc_canonical('{value}');").stdout.strip()
        assert result=='{"a":"é","nested":[1,1000,0.001],"z":0}',result
    publication_case("storage canonicalization keeps numeric equality distinct from original bytes",canonical)

    def expires_inside(db):
        sql(db,"CREATE FUNCTION p027_m21_delay() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2); RETURN NULL; END$$; CREATE TRIGGER p027_m21_delay AFTER INSERT ON polis_coordinator_payloads FOR EACH STATEMENT EXECUTE FUNCTION p027_m21_delay();")
        try:
            arm(db,duration="interval '1 second'",margin=50)
            p=call(db,ok=False)
            assert p.returncode and 'LEASE-EXPIRED' in p.stderr,p.stderr
            assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="0"
            assert sql(db,"SELECT count(*) FROM polis_coordinator_generations;").stdout.strip()=="0"
        finally:
            sql(db,"DROP TRIGGER p027_m21_delay ON polis_coordinator_payloads; DROP FUNCTION p027_m21_delay();")
    publication_case("real DB-time expiry during write rolls back payloads and receipts",expires_inside)

    def missing_final_check(db):
        original=sql(db,"SELECT pg_get_functiondef('pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea)'::regprocedure);").stdout
        mutant=original.replace('IF lease.expires_at<=clock_timestamp()+make_interval','IF false AND lease.expires_at<=clock_timestamp()+make_interval')
        assert mutant!=original
        sql(db,mutant)
        try:
            arm(db,duration="interval '30 seconds'",margin=60000)
            # The same positive-but-insufficient-margin case above now violates
            # the policy and commits. Its rollback assertion rejects this mutant.
            assert call(db).stdout.startswith('committed|0|')
            assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="1"
        finally:
            sql(db,original)
    publication_case("negative control: removing final margin check commits forbidden publication",missing_final_check)

    def malformed_json(db):
        arm(db)
        for raw in ['{"zid":990001,"zid":990001,"lastVoteTimestamp":0}',
                    '{"zid":990001,"lastVoteTimestamp":NaN}',
                    '{"zid":990002,"lastVoteTimestamp":0}']:
            p=sql(db,f"""SELECT * FROM pc_publish('generated',990001,'owner-a',1,'op-a',decode(repeat('ab',32),'hex'),NULL,'{{}}',
              convert_to('{raw}','UTF8'),convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'),convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'));""",ok=False,user='p027_m21_publisher')
            assert p.returncode and ('INVALID_ORIGINAL_JSON' in p.stderr or 'FOREIGN_OR_INCONSISTENT_PAYLOAD' in p.stderr),p.stderr
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="0"
    publication_case("duplicate/nonfinite/foreign original payloads refused before writes",malformed_json)

    def control(db, text, ok=True):
        return sql(db, 'SET ROLE polis_coordinator_control; '+text, ok=ok)

    def no_admission(db):
        arm(db)
        sql(db,"DELETE FROM polis_coordinator_operations;")
        assert 'OPERATION_NOT_ADMITTED' in call(db,ok=False).stderr
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=='0'
    publication_case('publication requires durable operation admission',no_admission)

    def profile_required(db):
        arm(db)
        sql(db,"DELETE FROM polis_coordinator_operations; DELETE FROM polis_coordinator_budgets;")
        r=control(db,"SELECT pc_admit('generated',990001,'owner-a',1,'op-a',repeat('a',64),2097152);",False)
        assert 'ADMISSION_PROFILE_REQUIRED' in r.stderr
    publication_case('no implicit admission profile; explicit operator limits required',profile_required)

    def limits(db,kind):
        arm(db)
        if kind=='count':
            sql(db,"UPDATE polis_coordinator_budgets SET max_operations=1;")
        else:
            sql(db,"UPDATE polis_coordinator_budgets SET max_bytes=2097152;")
        sql(db,"UPDATE polis_coordinator_leases SET dispatch_operation_id='op-b';")
        r=control(db,"SELECT pc_admit('generated',990001,'owner-a',1,'op-b',repeat('a',64),2097152);",False)
        assert 'ADMISSION_CAPACITY' in r.stderr
        assert sql(db,"SELECT count(*),sum(reserved_bytes) FROM polis_coordinator_operations;").stdout.strip()=='1|2097152'
        # Reconciliation is still permitted at capacity and remains unresolved.
        assert control(db,"SELECT pc_reconcile('generated',990001,'op-a');").stdout.strip().endswith('unresolved')
    for kind in ('count','bytes'):
        publication_case(f'{kind} capacity refuses new work and preserves reconciliation',lambda db,kind=kind:limits(db,kind))

    def byte_limit(db):
        arm(db)
        sql(db,"UPDATE polis_coordinator_operations SET reserved_bytes=1048576;")
        assert 'PUBLICATION_BYTE_CAPACITY' in call(db,ok=False).stderr
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=='0'
    publication_case('publication cannot exceed its reserved logical byte ceiling',byte_limit)

    def admission_identity(db):
        arm(db)
        assert control(db,"SELECT pc_admit('generated',990001,'owner-a',1,'op-a',repeat('a',64),2097152);").stdout.strip().endswith('already_admitted')
        for value in ("repeat('b',64),2097152", "repeat('a',64),4194304"):
            assert 'ADMISSION_IDENTITY_CONFLICT' in control(db,f"SELECT pc_admit('generated',990001,'owner-a',1,'op-a',{value});",False).stderr
    publication_case('admission retry preserves exact source identity and reservation',admission_identity)

    def resumed(db):
        arm(db)
        assert control(db,"SELECT pc_reconcile('generated',990001,'op-a');").stdout.strip().endswith('unresolved')
        # Each sql() uses a new real connection; no process-local catalog exists.
        assert sql(db,"SELECT state,resolved_tick,reconciled_at>'-infinity' FROM polis_coordinator_operations;").stdout.strip()=='unresolved||t'
        assert control(db,"SELECT pc_cleanup('generated',990001,'op-a');").stdout.strip().endswith('f')
        assert call(db).stdout.startswith('committed|0|')
        arm(db,operation='op-b',epoch=2,expected='0'); assert call(db,operation='op-b',epoch=2,expected='0').stdout.startswith('committed|1|')
        assert control(db,"SELECT pc_reconcile('generated',990001,'op-a');").stdout.strip().endswith('resolved')
        assert sql(db,"SELECT resolved_tick FROM polis_coordinator_operations WHERE operation_id='op-a';").stdout.strip()=='0'
    publication_case('new controller connection enumerates missing receipt and resolves exact older commit',resumed)

    def cleanup_ready(db):
        arm(db);assert call(db).stdout.startswith('committed|0|')
        control(db,"SELECT pc_reconcile('generated',990001,'op-a');")
        arm(db,operation='op-b',epoch=2,expected='0');assert call(db,operation='op-b',epoch=2,expected='0').stdout.startswith('committed|1|')
        control(db,"SELECT pc_reconcile('generated',990001,'op-b');")
        sql(db,"UPDATE polis_coordinator_leases SET dispatch_operation_id=NULL,dispatch_capability_sha256=NULL,dispatch_checkpoint_sha256=NULL,dispatch_expected_tick=NULL,dispatch_margin_ms=NULL;")

    def cleaned_floor(db,mode):
        cleanup_ready(db)
        control(db,"SELECT pc_protect('generated',990001,'op-a',true);")
        assert control(db,"SELECT pc_cleanup('generated',990001,'op-a');").stdout.strip().endswith('f')
        control(db,"SELECT pc_protect('generated',990001,'op-a',false);")
        assert control(db,"SELECT pc_cleanup('generated',990001,'op-a');").stdout.strip().endswith('t')
        assert sql(db,"SELECT count(*),sum(reserved_bytes) FROM polis_coordinator_operations;").stdout.strip()=='1|2097152'
        assert sql(db,"SELECT count(*) FROM polis_coordinator_payloads;").stdout.strip()=='3'
        if mode=='deleted':
            for table in ('math_ticks','math_main','math_bidtopid','math_ptptstats'):
                sql(db,f'DELETE FROM {table};')
        else:
            sql(db,'UPDATE math_ticks SET math_tick=0;')
        assert control(db,"SELECT pc_cleanup('generated',990001,'op-b');").stdout.strip().endswith('f')
        arm(db,operation='op-c',epoch=3,expected='1');assert call(db,operation='op-c',epoch=3,expected='1').stdout.startswith('committed|2|')
        assert sql(db,"SELECT math_tick,caching_tick FROM polis_coordinator_floors;").stdout.strip()=='2|3'
    for mode in ('deleted','regressed'):
        publication_case(f'protected cleanup releases capacity and {mode} pointers retain generation/cursor floor',lambda db,mode=mode:cleaned_floor(db,mode))

    def pending_reference(db):
        cleanup_ready(db)
        # Model an unresolved earlier attempt whose expected generation is 0.
        sql(db,"INSERT INTO polis_coordinator_operations SELECT math_env,zid,'op-pending',owner_id,owner_epoch,0,capability_sha256,checkpoint_sha256,source_sha256,reserved_bytes,'unresolved',false,admitted_at,reconciled_at,NULL FROM polis_coordinator_operations WHERE operation_id='op-a';")
        assert control(db,"SELECT pc_cleanup('generated',990001,'op-a');").stdout.strip().endswith('f')
        assert sql(db,"SELECT count(*) FROM polis_coordinator_payloads;").stdout.strip()=='6'
    publication_case('unresolved expected-generation reference forbids historical deletion',pending_reference)

    def direct_denied(db):
        arm(db)
        for table in ('polis_coordinator_operations','polis_coordinator_budgets','polis_coordinator_floors','polis_coordinator_generations','polis_coordinator_payloads'):
            assert control(db,f'DELETE FROM {table};',False).returncode
            assert sql(db,f'DELETE FROM {table};',False,user='p027_m21_publisher').returncode
        assert sql(db,"SELECT pc_cleanup('generated',990001,'op-a');",False,user='p027_m21_publisher').returncode
        assert control(db,"UPDATE polis_coordinator_budgets SET max_operations=999999;",False).returncode
    publication_case('control DELETE is function-scoped; publisher and direct metadata writes denied',direct_denied)

    def false_receipt(db):
        arm(db);assert call(db).stdout.startswith('committed|0|')
        sql(db,"UPDATE polis_coordinator_generations SET owner_id='foreign-owner';")
        assert 'RECEIPT_IDENTITY_CONFLICT' in control(db,"SELECT pc_reconcile('generated',990001,'op-a');",False).stderr
        assert sql(db,"SELECT state FROM polis_coordinator_operations;").stdout.strip()=='pending'
    publication_case('reconciliation refuses a foreign receipt without resolving the operation',false_receipt)

    def cleanup_mutant(db):
        cleanup_ready(db)
        control(db,"SELECT pc_protect('generated',990001,'op-a',true);")
        original=sql(db,"SELECT pg_get_functiondef('pc_cleanup(text,integer,text)'::regprocedure);").stdout
        assert original.count(' OR op.protected')==1
        mutant=original.replace(' OR op.protected','').replace("(state<>'resolved' OR protected)","(state<>'resolved')")
        sql(db,mutant)
        try:
            assert control(db,"SELECT pc_cleanup('generated',990001,'op-a');").stdout.strip().endswith('t')
            # The intact protected-deletion refusal oracle rejects this result.
        finally:
            sql(db,original)
    publication_case('negative control: removed protection permits forbidden receipt deletion',cleanup_mutant)

    def named_references(db):
        cleanup_ready(db)
        for name in ('consumer-a','consumer-b'):
            control(db,f"SELECT pc_reference('generated',990001,'op-a','{name}',true);")
        control(db,"SELECT pc_reference('generated',990001,'op-a','consumer-a',false);")
        assert control(db,"SELECT pc_cleanup('generated',990001,'op-a');").stdout.strip().endswith('f')
        control(db,"SELECT pc_reference('generated',990001,'op-a','consumer-b',false);")
        assert control(db,"SELECT pc_cleanup('generated',990001,'op-a');").stdout.strip().endswith('t')
    publication_case('named references must all release before receipt cleanup',named_references)

    def reference_bound(db):
        arm(db)
        control(db,"SELECT pc_reference('generated',990001,'op-a','ref-'||g,true) FROM generate_series(1,128) g;")
        assert 'REFERENCE_CAPACITY' in control(db,"SELECT pc_reference('generated',990001,'op-a','overflow',true);",False).stderr
        control(db,"SELECT pc_reference('generated',990001,'op-a','ref-1',true);")
        assert sql(db,"SELECT count(*) FROM polis_coordinator_references;").stdout.strip()=='128'
    publication_case('reference catalog is bounded and duplicate registration is idempotent',reference_bound)

    def admission_commit(db):
        arm(db)
        sql(db,"DELETE FROM polis_coordinator_operations;")
        r=sql(db,"""BEGIN; SET LOCAL ROLE polis_coordinator_control;
        SELECT pc_admit('generated',990001,'owner-a',1,'op-a',repeat('a',64),2097152);
        RESET ROLE; SET LOCAL ROLE polis_coordinator_publisher;
        SELECT * FROM pc_publish('generated',990001,'owner-a',1,'op-a',decode(repeat('ab',32),'hex'),NULL,'{}',
         convert_to('{"zid":990001,"lastVoteTimestamp":0}','UTF8'),
         convert_to('{"zid":990001,"lastVoteTimestamp":0}','UTF8'),
         convert_to('{"zid":990001,"lastVoteTimestamp":0}','UTF8')); COMMIT;""",False)
        assert 'ADMISSION_NOT_DURABLE' in r.stderr
        assert sql(db,"SELECT count(*) FROM polis_coordinator_operations;").stdout.strip()=='0'
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=='0'
    publication_case('same-transaction admission and publication is refused atomically',admission_commit)

    def concurrent_capacity(db):
        arm(db)
        sql(db,"""DELETE FROM polis_coordinator_operations; UPDATE polis_coordinator_budgets SET max_operations=1;
        INSERT INTO conversations(zid) VALUES(990002);
        INSERT INTO polis_coordinator_leases SELECT math_env,990002,owner_id,owner_epoch,expires_at,
        'op-b',dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_expected_tick,dispatch_margin_ms FROM polis_coordinator_leases;""")
        first=subprocess.Popen(['docker','exec','-i',CONTAINER,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        first.stdin.write("BEGIN; SET LOCAL ROLE polis_coordinator_control; SELECT pc_admit('generated',990001,'owner-a',1,'op-a',repeat('a',64),2097152); SELECT pg_advisory_xact_lock(210024); SELECT pg_sleep(3); COMMIT;")
        first.stdin.close();first.stdin=None
        try:
            for _ in range(100):
                if sql(db,"SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=210024 AND granted;").stdout.strip()=='1':break
                time.sleep(0.02)
            else:raise AssertionError('first admission never reached its reservation lock')
            r=control(db,"SELECT pc_admit('generated',990002,'owner-a',1,'op-b',repeat('a',64),2097152);",False)
            assert 'ADMISSION_CAPACITY' in r.stderr
        finally:
            output,error=first.communicate(timeout=15)
            assert first.returncode==0,output+error
        assert sql(db,"SELECT count(*),sum(reserved_bytes) FROM polis_coordinator_operations;").stdout.strip()=='1|2097152'
    publication_case('two concurrent conversations cannot overbook the final namespace slot',concurrent_capacity)

    def budget_mutant(db):
        arm(db)
        sql(db,"UPDATE polis_coordinator_budgets SET max_operations=1; UPDATE polis_coordinator_leases SET dispatch_operation_id='op-b';")
        original=sql(db,"SELECT pg_get_functiondef('pc_admit(text,integer,text,bigint,text,text,bigint)'::regprocedure);").stdout
        predicate='IF n>=budget.max_operations OR used+p_reserved_bytes>budget.max_bytes THEN'
        assert original.count(predicate)==1
        sql(db,original.replace(predicate,'IF false THEN'))
        try:
            control(db,"SELECT pc_admit('generated',990001,'owner-a',1,'op-b',repeat('a',64),2097152);")
            assert sql(db,"SELECT count(*) FROM polis_coordinator_operations;").stdout.strip()=='2'
        finally:sql(db,original)
    publication_case('negative control: removed admission bound overbooks capacity',budget_mutant)

    def independent_publication(db, preadmitted=False, old_lock=False, transition_attempt=False):
        """Real after-main latch; another zid must finish before its release."""
        arm(db)
        sql(db,"""INSERT INTO conversations(zid) VALUES(990002);
        INSERT INTO polis_coordinator_leases SELECT math_env,990002,owner_id,owner_epoch,expires_at,
        'op-b',dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_expected_tick,dispatch_margin_ms
        FROM polis_coordinator_leases WHERE zid=990001;""")
        admit_b="SELECT pc_admit('generated',990002,'owner-a',1,'op-b',repeat('a',64),2097152);"
        if preadmitted:
            control(db,admit_b)
        original=sql(db,"SELECT pg_get_functiondef('pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea)'::regprocedure);").stdout
        if old_lock:
            marker=" SELECT * INTO op FROM public.polis_coordinator_operations WHERE math_env=p_env AND zid=p_zid AND operation_id=p_operation FOR UPDATE;"
            assert original.count(marker)==1
            sql(db,original.replace(marker," PERFORM 1 FROM public.polis_coordinator_budgets WHERE math_env=p_env FOR UPDATE;\n"+marker))
        sql(db,"""CREATE FUNCTION p027_m21_after_main() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.zid=990001 THEN PERFORM pg_advisory_xact_lock(210025); END IF; RETURN NEW; END$$;
        CREATE TRIGGER p027_m21_after_main AFTER INSERT ON math_main FOR EACH ROW EXECUTE FUNCTION p027_m21_after_main();""")
        def process(user):
            return subprocess.Popen(['docker','exec','-i',CONTAINER,'psql','-X','-At','-v','ON_ERROR_STOP=1',
                                     '-U',user,'-d',db],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        def publish_text(zid,operation):
            payload=f'{{"zid":{zid},"lastVoteTimestamp":0}}'
            return f"SELECT * FROM pc_publish('generated',{zid},'owner-a',1,'{operation}',decode(repeat('ab',32),'hex'),NULL,'{{}}'," + ','.join(f"convert_to('{payload}','UTF8')" for _ in range(3))+');'
        gate=process('postgres');first=None
        gate.stdin.write('SELECT pg_advisory_lock(210025);\n');gate.stdin.flush()
        try:
            for _ in range(100):
                if sql(db,"SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=210025 AND granted;").stdout.strip()=='1':break
                time.sleep(.02)
            else:raise AssertionError('after-main gate not held')
            first=process('p027_m21_publisher')
            first.stdin.write("SET statement_timeout='30s'; "+publish_text(990001,'op-a')+'\n')
            first.stdin.close();first.stdin=None
            for _ in range(100):
                if sql(db,"SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=210025 AND NOT granted;").stdout.strip()=='1':break
                time.sleep(.02)
            else:raise AssertionError('first publication did not reach its actual after-main trigger')
            assert first.poll() is None
            assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=='0'
            if transition_attempt:
                r=transition(db,ok=False)
                assert r.returncode and 'lock timeout' in r.stderr,r.stderr
                assert sql(db,'SELECT count(*) FROM polis_coordinator_transitions;').stdout.strip()=='0'
                assert first.poll() is None
            # Admission happens in its own transaction, with the real namespace
            # arithmetic; publication happens through the restricted login.
            if not preadmitted:
                admitted=control(db,"SET lock_timeout='1s'; "+admit_b,ok=False)
                if old_lock:
                    assert admitted.returncode and 'lock timeout' in admitted.stderr,admitted.stdout+admitted.stderr
                    assert sql(db,"SELECT count(*) FROM polis_coordinator_operations;").stdout.strip()=='1'
                else:
                    assert admitted.returncode==0,admitted.stdout+admitted.stderr
            if not old_lock:
                second=sql(db,"SET lock_timeout='1s'; "+publish_text(990002,'op-b'),user='p027_m21_publisher')
                assert 'committed|0|2' in second.stdout,second.stdout
                assert first.poll() is None
                assert sql(db,"SELECT zid,math_tick,caching_tick FROM math_main;").stdout.strip()=='990002|0|2'
                assert sql(db,"SELECT count(*),sum(reserved_bytes) FROM polis_coordinator_operations;").stdout.strip()=='2|4194304'
                assert sql(db,"SELECT count(DISTINCT math_tick),count(*) FROM (SELECT math_tick FROM math_ticks UNION ALL SELECT math_tick FROM math_main UNION ALL SELECT math_tick FROM math_bidtopid UNION ALL SELECT math_tick FROM math_ptptstats) r;").stdout.strip()=='1|4'
        finally:
            gate.stdin.write('SELECT pg_advisory_unlock(210025);\n');gate.stdin.close();gate.stdin=None
            gout,gerr=gate.communicate(timeout=10)
            if first is not None:
                aout,aerr=first.communicate(timeout=15)
            sql(db,"DROP TRIGGER p027_m21_after_main ON math_main; DROP FUNCTION p027_m21_after_main();")
            if old_lock:sql(db,original)
        assert gate.returncode==0,gout+gerr
        assert first.returncode==0 and 'committed|0|1' in aout,aout+aerr
        if not old_lock:
            assert sql(db,"SELECT zid,caching_tick FROM math_main ORDER BY zid;").stdout.strip()=='990001|1\n990002|2'
            assert sql(db,"SELECT count(*) FROM polis_coordinator_payloads;").stdout.strip()=='6'
        (WORK/f'r12-{preadmitted}-{old_lock}-{transition_attempt}.json').write_text(json.dumps({
            'first_paused_after_actual_main_insert':True,'second_preadmitted':preadmitted,
            'old_namespace_lock_mutation':old_lock,'second_completed_before_first':not old_lock,
            'old_lock_rejected_by_same_admission_oracle':old_lock,'reservation_bytes':2097152,
            'first_cursor':1,'second_cursor':None if old_lock else 2},indent=2)+'\n')
    publication_case('R12: paused main write does not block another zid admission and publication',independent_publication)
    publication_case('R12: two admitted zids may publish and commit out of sequence order',lambda db:independent_publication(db,preadmitted=True))
    publication_case('negative control: old publication budget lock fails the R12 admission oracle',lambda db:independent_publication(db,old_lock=True))

    def maximum_metadata(db):
        arm(db)
        sql(db,"""INSERT INTO polis_coordinator_budgets VALUES(repeat(chr(128512),999),1,2097152);
        INSERT INTO polis_coordinator_leases SELECT repeat(chr(128512),999),zid,owner_id,owner_epoch,expires_at,
        repeat(chr(128512),128),dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_expected_tick,dispatch_margin_ms FROM polis_coordinator_leases;""")
        sql(db,"INSERT INTO polis_coordinator_namespaces VALUES(repeat(chr(128512),999),'python',128); UPDATE polis_coordinator_principals SET math_env=repeat(chr(128512),999) WHERE principal_name='postgres';")
        control(db,"SELECT pc_admit(repeat(chr(128512),999),990001,'owner-a',1,repeat(chr(128512),128),repeat('a',64),2097152);")
        control(db,"SELECT pc_reference(repeat(chr(128512),999),990001,repeat(chr(128512),128),repeat(chr(128512),124)||g,true) FROM generate_series(1,128) g;")
        size=sql(db,"SELECT sum(octet_length(math_env)+octet_length(operation_id)+octet_length(reference_name)+4) FROM polis_coordinator_references;").stdout.strip()
        assert 600000<int(size)<1048576,size
        assert 'REFERENCE_CAPACITY' in control(db,"SELECT pc_reference(repeat(chr(128512),999),990001,repeat(chr(128512),128),'overflow',true);",False).stderr
        assert sql(db,"SELECT count(*) FROM polis_coordinator_references;").stdout.strip()=='128'
    publication_case('maximum UTF8 reference keys fit the reserved metadata allowance',maximum_metadata)

    def prototype(db):
        sql(db, "ALTER TABLE math_ticks ADD COLUMN publisher_epoch bigint;")
        p = apply(db, ok=False)
        assert p.returncode and "prototype coordinator schema" in p.stderr
        assert role_state() == ""
    case("prototype schema cannot be silently adopted", prototype)

    def unsafe_role(db):
        sql(db, "CREATE ROLE polis_coordinator_owner NOLOGIN CREATEROLE;")
        before = dump(db)
        p = apply(db, ok=False)
        assert p.returncode and "unsafe coordinator role" in p.stderr
        assert dump(db) == before
    case("unsafe pre-existing role refused without changes", unsafe_role)

    def non_super(db):
        # Reuse the baseline's safe NOLOGIN role through SET ROLE, not a login.
        p = sql(db, "SET ROLE polis_queue_executor;" + UP.read_text(), ok=False)
        assert p.returncode and "requires superuser installer" in p.stderr
        assert dump(db) == baseline and role_state() == ""
    case("explicit non-superuser precondition is atomic", non_super)

    def namespace_case(name, body):
        def wrapped(db):
            logins = ('p027_m21_python_control', 'p027_m21_legacy_control',
                      'p027_m21_python_transition', 'p027_m21_legacy_transition')
            for login in logins:
                sql(db, f'CREATE ROLE {login} LOGIN IN ROLE polis_coordinator_control;')
            sql(db, "INSERT INTO polis_coordinator_namespaces VALUES('legacy','legacy',128);")
            for login in logins:
                env = 'legacy' if '_legacy_' in login else 'generated'
                allowed = 'true' if login.endswith('_transition') else 'false'
                sql(db, f"INSERT INTO polis_coordinator_principals SELECT oid,rolname,'{env}',{allowed} FROM pg_roles WHERE rolname='{login}';")
            try:
                body(db)
            finally:
                for login in logins:
                    sql(db, f'DROP ROLE {login};')
        publication_case(name, wrapped)

    def transition(db, source='legacy', dest='generated', ident='transfer-a', last='100', ok=True):
        who = 'legacy' if dest == 'legacy' else 'python'
        return sql(db, f"SELECT * FROM pc_transition('{source}','{dest}',990001,'{ident}',{last},repeat('e',64));",
                   ok=ok, user=f'p027_m21_{who}_transition')

    def seed_legacy(db, tick=100):
        # Public fixture only. No generation/original-byte receipt is fabricated.
        for table in ('math_ticks','math_bidtopid','math_ptptstats','math_main'):
            if table == 'math_ticks':
                q = f"INSERT INTO {table}(zid,math_env,math_tick) VALUES(990001,'legacy',{tick});"
            elif table == 'math_main':
                q = f"INSERT INTO {table}(zid,math_env,math_tick,data,last_vote_timestamp,caching_tick) VALUES(990001,'legacy',{tick},'{{}}',0,0);"
            else:
                q = f"INSERT INTO {table}(zid,math_env,math_tick,data) VALUES(990001,'legacy',{tick},'{{}}');"
            sql(db, q)

    def namespace_leases(db):
        sql(db, 'INSERT INTO conversations(zid) VALUES(990001);')
        for own, foreign, who in [('generated','legacy','python'),('legacy','generated','legacy')]:
            user = f'p027_m21_{who}_control'
            def insert(env):
                return f"INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('{env}',990001,'test-owner',1,clock_timestamp()+interval '1 minute');"
            assert sql(db, insert(own), user=user).returncode == 0
            r = sql(db, 'BEGIN; '+insert(foreign)+' COMMIT;', ok=False, user=user)
            assert r.returncode and 'row-level security' in r.stderr, r.stderr
            r = sql(db, f"UPDATE polis_coordinator_leases SET math_env='{foreign}' WHERE math_env='{own}';", ok=False, user=user)
            assert r.returncode and 'row-level security' in r.stderr, r.stderr
            assert sql(db, 'SELECT math_env FROM polis_coordinator_leases;', user=user).stdout.strip() == own
        assert sql(db,'SELECT count(*) FROM polis_coordinator_leases;').stdout.strip() == '2'
    namespace_case('actual Python and legacy control logins commit only their own namespace leases', namespace_leases)

    def namespace_functions(db):
        arm(db)
        calls = ["pc_admit('legacy',990001,'owner-a',1,'op-a',repeat('a',64),2097152)",
                 "pc_reconcile('legacy',990001,'op-a')", "pc_protect('legacy',990001,'op-a',true)",
                 "pc_reference('legacy',990001,'op-a','reader',true)", "pc_cleanup('legacy',990001,'op-a')"]
        for expr in calls:
            r = sql(db, 'SELECT '+expr+';', False, 'p027_m21_python_control')
            assert r.returncode and 'NAMESPACE_AUTHORITY_REQUIRED' in r.stderr, r.stderr
        # Even valid stolen public dispatch metadata and the correct capability
        # cannot authorize a publisher in the foreign namespace.
        q = "SELECT * FROM pc_publish('legacy',990001,'owner-a',1,'op-a',decode(repeat('ab',32),'hex'),NULL,'{}','{}','{}','{}');"
        r = sql(db,q,False,'p027_m21_publisher')
        assert r.returncode and 'NAMESPACE_AUTHORITY_REQUIRED' in r.stderr
        assert call(db).stdout.startswith('committed|0|')
        assert sql(db, 'SELECT math_env FROM polis_coordinator_generations;',user='p027_m21_publisher').stdout.strip() == 'generated'
    namespace_case('all six privileged mutation entry points refuse foreign namespace before readback', namespace_functions)

    def namespace_spoof(db):
        arm(db)
        sql(db, 'GRANT polis_coordinator_control TO p027_m21_publisher;')
        q = "SET ROLE polis_coordinator_control; SET polis_coordinator.math_env='legacy'; SELECT pc_admit('legacy',990001,'owner-a',1,'op-a',repeat('a',64),2097152);"
        r=sql(db,q,False,'p027_m21_publisher')
        assert r.returncode and 'NAMESPACE_AUTHORITY_REQUIRED' in r.stderr
        for table in ('polis_coordinator_principals','polis_coordinator_namespaces'):
            assert sql(db,f'DELETE FROM {table};',False,'p027_m21_python_control').returncode
        sql(db, 'DROP ROLE p027_m21_python_control; CREATE ROLE p027_m21_python_control LOGIN IN ROLE polis_coordinator_control;')
        q="INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('generated',990002,'owner',1,clock_timestamp());"
        sql(db,'INSERT INTO conversations(zid) VALUES(990002);')
        r=sql(db,q,False,'p027_m21_python_control')
        assert r.returncode and 'row-level security' in r.stderr
    namespace_case('SET ROLE and custom settings cannot change namespace; recreated login OID is refused', namespace_spoof)

    def namespace_mutant(db):
        arm(db)
        original=sql(db,"SELECT pg_get_functiondef('pc_namespace_allowed(text)'::regprocedure);").stdout
        sql(db,"CREATE OR REPLACE FUNCTION pc_namespace_allowed(p_env text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'SELECT true';")
        try:
            q="INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('legacy',990001,'owner',1,clock_timestamp()+interval '1 minute');"
            assert sql(db,q,user='p027_m21_python_control').returncode == 0
            assert sql(db,"SELECT count(*) FROM polis_coordinator_leases WHERE math_env='legacy';").stdout.strip()=='1'
        finally: sql(db,original)
    namespace_case('negative control: removed session mapping permits forbidden foreign lease', namespace_mutant)

    namespace_case('paused actual publication blocks same-zid transition while unrelated zid completes',lambda db:independent_publication(db,transition_attempt=True))

    def namespace_publish_mutant(db):
        arm(db)
        sql(db,"INSERT INTO polis_coordinator_budgets VALUES('legacy',8,16777216); INSERT INTO polis_coordinator_leases SELECT 'legacy',zid,owner_id,owner_epoch,expires_at,dispatch_operation_id,dispatch_capability_sha256,dispatch_checkpoint_sha256,dispatch_expected_tick,dispatch_margin_ms FROM polis_coordinator_leases;")
        sql(db,"SELECT pc_admit('legacy',990001,'owner-a',1,'op-a',repeat('a',64),2097152);",user='p027_m21_legacy_control')
        payload='{"zid":990001,"lastVoteTimestamp":0}'
        q="SELECT * FROM pc_publish('legacy',990001,'owner-a',1,'op-a',decode(repeat('ab',32),'hex'),NULL,'{}',"+','.join(f"convert_to('{payload}','UTF8')" for _ in range(3))+');'
        r=sql(db,q,False,'p027_m21_publisher')
        assert r.returncode and 'NAMESPACE_AUTHORITY_REQUIRED' in r.stderr,r.stderr
        assert sql(db,'SELECT count(*) FROM math_main;').stdout.strip()=='0'
        original=sql(db,"SELECT pg_get_functiondef('pc_namespace_allowed(text)'::regprocedure);").stdout
        sql(db,"CREATE OR REPLACE FUNCTION pc_namespace_allowed(p_env text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'SELECT true';")
        try:
            assert sql(db,q,user='p027_m21_publisher').stdout.startswith('committed|0|')
            assert sql(db,"SELECT math_env FROM math_main;").stdout.strip()=='legacy'
        finally:sql(db,original)
    namespace_case('negative control: valid foreign capability still needs mapping; removing it permits forbidden publication',namespace_publish_mutant)

    def transition_roundtrip(db):
        arm(db); assert call(db).stdout.startswith('committed|0|'); seed_legacy(db)
        originals=sql(db,"SELECT original_sha256 FROM polis_coordinator_payloads ORDER BY payload_kind;").stdout
        r=transition(db)
        assert r.stdout.strip()=='publication_required|100||2',r.stdout
        assert sql(db,"SELECT math_tick FROM math_main WHERE math_env='generated';").stdout.strip()=='0'
        assert sql(db,"SELECT bool_and(expires_at<=clock_timestamp() AND dispatch_operation_id IS NULL) FROM polis_coordinator_leases;").stdout.strip()=='t'
        assert transition(db).stdout.strip()=='already_committed|100||2'
        arm(db,operation='op-b',epoch=2,expected='100')
        assert call(db,operation='op-b',epoch=2,expected='100').stdout.startswith('committed|101|3')
        assert transition(db,source='generated',dest='legacy',ident='fallback',last='101').stdout.strip()=='legacy_reticked|101|102|4'
        assert sql(db,"SELECT count(DISTINCT math_tick),min(math_tick),count(*) FROM (SELECT math_tick FROM math_ticks WHERE math_env='legacy' UNION ALL SELECT math_tick FROM math_main WHERE math_env='legacy' UNION ALL SELECT math_tick FROM math_bidtopid WHERE math_env='legacy' UNION ALL SELECT math_tick FROM math_ptptstats WHERE math_env='legacy') t;").stdout.strip()=='1|102|4'
        assert sql(db,"SELECT count(*) FROM polis_coordinator_generations WHERE math_env='legacy';").stdout.strip()=='0'
        assert sql(db,"SELECT original_sha256 FROM polis_coordinator_payloads WHERE math_tick=0 ORDER BY payload_kind;").stdout==originals
        assert sql(db,"SELECT data FROM math_main WHERE math_env='legacy';").stdout.strip()=='{}'
        assert transition(db,source='generated',dest='legacy',ident='fallback',last='101').stdout.strip()=='already_committed|101|102|4'
        assert sql(db,"SELECT last_value FROM polis_coordinator_caching_tick;").stdout.strip()=='4'
        assert transition(db).stdout.strip()=='already_committed|100||2'
        assert sql(db,"SELECT math_tick FROM polis_coordinator_floors WHERE math_env='generated';").stdout.strip()=='101'
    namespace_case('L to P to L advances old client clocks with exact retry and preserves raw originals',transition_roundtrip)

    for source_mode in ('absent','zero','empty'):
        def absent_zero_empty(db,mode=source_mode):
            arm(db)
            if mode!='absent':seed_legacy(db,0)
            if mode=='zero':
                sql(db,"UPDATE math_main SET data='{\"n\":1}' WHERE math_env='legacy';")
            assert transition(db,last='0').stdout.strip()=='publication_required|0||1'
            arm(db,operation='op-b',epoch=2,expected='0')
            assert call(db,operation='op-b',epoch=2,expected='0').stdout.startswith('committed|1|2')
        namespace_case(f'{source_mode} source rows preserve zero-token transition floor before real Python publish',absent_zero_empty)

    def legacy_incomplete(db):
        arm(db); assert call(db).stdout.startswith('committed|0|')
        for count in range(4):
            if count==1:seed_legacy(db,0);sql(db,"DELETE FROM math_bidtopid WHERE math_env='legacy';")
            if count==2:sql(db,"INSERT INTO math_bidtopid(zid,math_env,math_tick,data) VALUES(990001,'legacy',7,'{}');")
            if count==3:sql(db,"UPDATE math_bidtopid SET math_tick=0 WHERE math_env='legacy';")
            r=transition(db,source='generated',dest='legacy',last='0',ok=False)
            if count<3:
                assert r.returncode and 'LEGACY_COHERENT_REBUILD_REQUIRED' in r.stderr
                assert sql(db,'SELECT count(*) FROM polis_coordinator_transitions;').stdout.strip()=='0'
            else:assert r.stdout.strip()=='legacy_reticked|0|1|2'
    namespace_case('legacy absent partial and mixed-generation rows refuse; coherent stored-empty rows retick',legacy_incomplete)

    def transition_permissions(db):
        arm(db)
        q="SELECT * FROM pc_transition('legacy','generated',990001,'transfer-a',100,repeat('e',64));"
        r=sql(db,q,False,'p027_m21_python_control')
        assert r.returncode and 'TRANSITION_AUTHORITY_REQUIRED' in r.stderr
        r=sql(db,q,False,'p027_m21_legacy_transition')
        assert r.returncode and 'NAMESPACE_AUTHORITY_REQUIRED' in r.stderr
        assert sql(db,'DELETE FROM polis_coordinator_transitions;',False,'p027_m21_python_transition').returncode
        assert sql(db,'UPDATE polis_coordinator_floors SET math_tick=100;',False,'p027_m21_python_transition').returncode
    namespace_case('transition is separately provisioned and destination-bound with no direct receipt or floor write',transition_permissions)

    def transition_limits(db):
        arm(db); seed_legacy(db)
        sql(db,"UPDATE polis_coordinator_namespaces SET max_transitions=1 WHERE math_env='generated';")
        assert transition(db).stdout.startswith('publication_required|100|')
        r=transition(db,ident='new-transfer',ok=False)
        assert r.returncode and 'TRANSITION_CAPACITY' in r.stderr
        assert transition(db).stdout.startswith('already_committed|100|')
        r=transition(db,last='99',ok=False)
        assert r.returncode and 'TRANSITION_IDENTITY_CONFLICT' in r.stderr
        assert sql(db,'SELECT count(*) FROM polis_coordinator_transitions;').stdout.strip()=='1'
    namespace_case('bounded retained transition receipts refuse new work but preserve exact old acknowledgments',transition_limits)

    def transition_overflow(db):
        arm(db);seed_legacy(db,9007199254740991)
        r=transition(db,ok=False)
        assert r.returncode and 'TRANSITION_TICK_EXHAUSTED' in r.stderr
        assert sql(db,'SELECT count(*) FROM polis_coordinator_transitions;').stdout.strip()=='0'
        assert sql(db,'SELECT is_called FROM polis_coordinator_caching_tick;').stdout.strip()=='f'
    namespace_case('exhausted source math clock refuses atomically before sequence and receipt writes',transition_overflow)

    def transition_rollback(db):
        arm(db);seed_legacy(db)
        sql(db,"CREATE FUNCTION p027_m21_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt fault'; END $$; CREATE TRIGGER p027_m21_fail_receipt BEFORE INSERT ON polis_coordinator_transitions FOR EACH ROW EXECUTE FUNCTION p027_m21_fail_receipt();")
        try:
            r=transition(db,source='generated',dest='legacy',last='100',ok=False)
            assert r.returncode and 'receipt fault' in r.stderr
            assert sql(db,"SELECT math_tick FROM math_main WHERE math_env='legacy';").stdout.strip()=='100'
            assert sql(db,'SELECT count(*) FROM polis_coordinator_floors;').stdout.strip()=='0'
            assert sql(db,'SELECT count(*) FROM polis_coordinator_writer_authority;').stdout.strip()=='0'
            assert sql(db,"SELECT dispatch_operation_id FROM polis_coordinator_leases;").stdout.strip()=='op-a'
        finally:
            sql(db,'DROP TRIGGER p027_m21_fail_receipt ON polis_coordinator_transitions; DROP FUNCTION p027_m21_fail_receipt();')
    namespace_case('receipt insertion fault rolls back legacy retick floor and dispatch revocation atomically',transition_rollback)

    def transition_floor_mutant(db):
        arm(db);seed_legacy(db)
        original=sql(db,"SELECT pg_get_functiondef('pc_transition(text,text,integer,text,bigint,text)'::regprocedure);").stdout
        needle='base_tick:=greatest(source_tick,destination_tick,p_last_served,0);'
        assert original.count(needle)==1
        sql(db,original.replace(needle,'base_tick:=greatest(destination_tick,0);'))
        try:
            r=transition(db)
            assert r.stdout.startswith('publication_required|0|'),r.stdout
            # The intact old-client floor oracle requires 100 and rejects this.
        finally:sql(db,original)
    namespace_case('negative control: ignoring source and client clocks fails the monotonic floor oracle',transition_floor_mutant)

    def policy_drift(db):
        apply(db)
        sql(db,'ALTER POLICY pc_namespace ON polis_coordinator_leases USING (true) WITH CHECK (true);')
        refuses_both(db)
        assert apply(db,ok=False).returncode
    case('namespace policy expression drift is sealed in catalog for replay and both down modes',policy_drift)

    def acquire_text(env='generated', zid=990001):
        return f"""INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at)
        VALUES('{env}',{zid},'restarted-owner',1,clock_timestamp()+interval '1 minute')
        ON CONFLICT(math_env,zid) DO UPDATE SET owner_id=excluded.owner_id,
        owner_epoch=polis_coordinator_leases.owner_epoch+1,expires_at=excluded.expires_at
        WHERE polis_coordinator_leases.expires_at<=clock_timestamp() RETURNING owner_epoch;"""

    def rollback_writer(db):
        arm(db); seed_legacy(db)
        assert transition(db,source='generated',dest='legacy',ident='rollback').stdout.startswith('legacy_reticked|')

    def authority_scope(db):
        sql(db,'INSERT INTO conversations(zid) VALUES(990001),(990002);')
        user='p027_m21_python_control'
        assert sql(db,"SELECT pc_writer_allowed('generated',990001),pc_writer_allowed('legacy',990001),pc_writer_allowed('generated',-1);",user=user).stdout.strip()=='t|f|f'
        assert sql(db,acquire_text(),user=user).stdout.startswith('1\n')
        assert sql(db,'SELECT count(*) FROM polis_coordinator_writer_authority;').stdout.strip()=='0'
    namespace_case('per-zid initial authority requires mapped login and existing parent',authority_scope)

    def restart_refused(db, delete=False):
        rollback_writer(db)
        user='p027_m21_python_control'
        assert sql(db,"SELECT pc_namespace_allowed('generated'),pc_writer_allowed('generated',990001);",user=user).stdout.strip()=='t|f'
        if delete:sql(db,"DELETE FROM polis_coordinator_leases WHERE math_env='generated';",user=user)
        before=sql(db,'TABLE polis_coordinator_leases;').stdout
        r=sql(db,acquire_text(),False,user)
        assert r.returncode and 'row-level security' in r.stderr,r.stdout+r.stderr
        assert sql(db,'TABLE polis_coordinator_leases;').stdout==before
        assert sql(db,acquire_text('legacy'),user='p027_m21_legacy_control').stdout.startswith('1\n')
        sql(db,'INSERT INTO conversations(zid) VALUES(990002);')
        assert sql(db,acquire_text(zid=990002),user=user).stdout.startswith('1\n')
        assert sql(db,"SELECT math_env,enabled FROM polis_coordinator_writer_authority ORDER BY math_env;",user=user).stdout.strip()=='generated|f'
    for absent in (False,True):
        namespace_case(f'rollback refuses restarted acquire with absent lease={absent}; legacy and other zid remain enabled',lambda db,absent=absent:restart_refused(db,absent))

    def revoked_mutations(db):
        rollback_writer(db)
        u='p027_m21_python_control'
        for q in ("UPDATE polis_coordinator_leases SET expires_at=clock_timestamp()+interval '1 minute';",
                  "UPDATE polis_coordinator_writer_authority SET enabled=true;",
                  "DELETE FROM polis_coordinator_writer_authority;",
                  "INSERT INTO polis_coordinator_writer_authority VALUES('generated',990002,true);"):
            assert sql(db,q,False,u).returncode,q
        r=sql(db,"SELECT pc_admit('generated',990001,'owner-a',1,'op-a',repeat('a',64),2097152);",False,u)
        assert r.returncode and 'WRITER_AUTHORITY_REQUIRED' in r.stderr,r.stderr
        r=call(db,ok=False)
        assert r.returncode and 'WRITER_AUTHORITY_REQUIRED' in r.stderr,r.stderr
        # Readback/reconciliation are retained, not treated as new writer work.
        assert sql(db,"SELECT pc_reconcile('generated',990001,'op-a');",user=u).stdout.strip()=='unresolved'
    namespace_case('revoked authority refuses renewal state tampering admission and new publication; reconciliation survives',revoked_mutations)

    def historical_and_reenable(db):
        arm(db); assert call(db).stdout.startswith('committed|0|');seed_legacy(db)
        assert transition(db,source='generated',dest='legacy',ident='rollback').stdout.startswith('legacy_reticked|')
        assert call(db).stdout.startswith('already_committed|0|')
        assert transition(db,ident='reenable').stdout.startswith('publication_required|')
        assert sql(db,"SELECT math_env,enabled FROM polis_coordinator_writer_authority ORDER BY math_env;").stdout.strip()=='generated|t\nlegacy|f'
        assert transition(db,source='generated',dest='legacy',ident='rollback').stdout.startswith('already_committed|')
        assert sql(db,"SELECT enabled FROM polis_coordinator_writer_authority WHERE math_env='generated';").stdout.strip()=='t'
        assert sql(db,acquire_text(),user='p027_m21_python_control').stdout.startswith('2\n')
        r=sql(db,acquire_text('legacy'),False,'p027_m21_legacy_control')
        assert r.returncode and 'row-level security' in r.stderr
    namespace_case('explicit return transition restores only destination; historical retries cannot undo current authority',historical_and_reenable)

    def observer_boundary(db):
        rollback_writer(db)
        login='p027_m21_observer'
        sql(db,f'CREATE ROLE {login} LOGIN IN ROLE polis_coordinator_observer;')
        try:
            tables=sql(db,"SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND starts_with(relname,'polis_coordinator_') ORDER BY relname;").stdout.splitlines()
            for table in tables:
                sql(db,f'SELECT count(*) FROM {table};',user=login)
                for op in (f'DELETE FROM {table};',f'INSERT INTO {table} DEFAULT VALUES;'):
                    r=sql(db,op,False,login)
                    assert r.returncode and 'permission denied' in r.stderr,(table,r.stderr)
            assert sql(db,"SELECT math_env,operation_id,state FROM polis_coordinator_operations;",user=login).stdout.strip()=='generated|op-a|pending'
            assert sql(db,"SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pc_') AND has_function_privilege(current_user,oid,'EXECUTE');",user=login).stdout.strip()=='0'
            for q in ("SELECT pc_namespace_allowed('generated');","SELECT pc_writer_allowed('generated',990001);","SELECT pc_admit('generated',990001,'owner-a',1,'op-a',repeat('a',64),2097152);","SELECT nextval('polis_coordinator_caching_tick');",'SET ROLE polis_coordinator_control;',"UPDATE math_main SET math_tick=0;"):
                assert sql(db,q,False,login).returncode,q
            assert sql(db,"SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'polis_coordinator_') AND relkind='r' AND (has_table_privilege(current_user,oid,'INSERT') OR has_table_privilege(current_user,oid,'UPDATE') OR has_table_privilege(current_user,oid,'DELETE') OR has_table_privilege(current_user,oid,'TRUNCATE') OR has_table_privilege(current_user,oid,'TRIGGER'));",user=login).stdout.strip()=='0'
        finally:sql(db,f'DROP ROLE {login};')
    namespace_case('unmapped observer independently sees pending operations and both authorities with zero function or write privilege',observer_boundary)

    def process(db,user):
        return subprocess.Popen(['docker','exec','-i',CONTAINER,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U',user,'-d',db],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

    def await_activity(db,app,condition):
        for _ in range(150):
            if sql(db,f"SELECT count(*) FROM pg_stat_activity WHERE datname='{db}' AND application_name='{app}' AND {condition};").stdout.strip()=='1':return
            time.sleep(.02)
        raise AssertionError(f'{app}: {condition} not observed')

    def waiting_acquire(db, existing=False, commit=True):
        arm(db); seed_legacy(db)
        if not existing:sql(db,'DELETE FROM polis_coordinator_leases;')
        sql(db,'INSERT INTO conversations(zid) VALUES(990002);')
        t=process(db,'p027_m21_legacy_transition');a=None
        try:
            t.stdin.write("SET application_name='rev7-transition'; BEGIN; SELECT * FROM pc_transition('generated','legacy',990001,'rollback',100,repeat('e',64));\n");t.stdin.flush()
            await_activity(db,'rev7-transition',"state='idle in transaction'")
            # Distinct zid remains independently writable while transition is open.
            assert sql(db,acquire_text(zid=990002),user='p027_m21_python_control').stdout.startswith('1\n')
            a=process(db,'p027_m21_python_control')
            a.stdin.write("SET application_name='rev7-acquire'; SET statement_timeout='20s'; "+acquire_text()+'\n');a.stdin.close();a.stdin=None
            await_activity(db,'rev7-acquire',"wait_event_type='Lock'")
            assert a.poll() is None
            t.stdin.write(('COMMIT;' if commit else 'ROLLBACK;')+'\n');t.stdin.close();t.stdin=None
            tout,terr=t.communicate(timeout=10);assert t.returncode==0,tout+terr
            aout,aerr=a.communicate(timeout=15)
            if commit:
                assert a.returncode and 'row-level security' in aerr,aout+aerr
                assert sql(db,"SELECT count(*) FROM polis_coordinator_leases WHERE zid=990001 AND owner_id='restarted-owner';").stdout.strip()=='0'
            else:
                assert a.returncode==0 and '1\n' in aout,aout+aerr
            (WORK/f'rev7-waiting-{existing}-{commit}.json').write_text(json.dumps({'existing_lease':existing,'transition_committed':commit,'observed_lock_wait':True,'unrelated_zid_acquired':True,'acquire_refused':bool(a.returncode)},indent=2)+'\n')
        finally:
            if t.poll() is None:
                if t.stdin:t.stdin.close();t.stdin=None
                t.communicate(timeout=10)
            if a is not None and a.poll() is None:a.communicate(timeout=25)
    for existing,commit in ((False,True),(True,True),(False,False)):
        namespace_case(f'waiting acquire sees committed authority after parent lock; existing={existing},commit={commit}',lambda db,existing=existing,commit=commit:waiting_acquire(db,existing,commit))

    def held_admission(db):
        arm(db);seed_legacy(db)
        p=process(db,'p027_m21_python_control')
        try:
            p.stdin.write("SET application_name='rev7-admission'; BEGIN; SELECT pc_writer_allowed('generated',990001);\n");p.stdin.flush()
            await_activity(db,'rev7-admission',"state='idle in transaction'")
            r=transition(db,source='generated',dest='legacy',ident='rollback',ok=False)
            assert r.returncode and 'lock timeout' in r.stderr,r.stderr
            assert sql(db,'SELECT count(*) FROM polis_coordinator_writer_authority;').stdout.strip()=='0'
        finally:
            p.stdin.write('ROLLBACK;\n');p.stdin.close();p.stdin=None
            out,err=p.communicate(timeout=10);assert p.returncode==0,out+err
    namespace_case('writer admission holds parent serialization until transaction end and excludes transition',held_admission)

    for isolation in ('REPEATABLE READ','SERIALIZABLE'):
        def stale_snapshot(db,isolation=isolation):
            rollback_writer(db)
            r=sql(db,f"BEGIN ISOLATION LEVEL {isolation}; SELECT pc_writer_allowed('generated',990001);",False,'p027_m21_python_control')
            assert r.returncode and 'WRITER_READ_COMMITTED_REQUIRED' in r.stderr,r.stderr
            r=sql(db,f'BEGIN ISOLATION LEVEL {isolation}; '+acquire_text(),False,'p027_m21_python_control')
            assert r.returncode and 'WRITER_READ_COMMITTED_REQUIRED' in r.stderr,r.stderr
        namespace_case(f'{isolation} writer snapshots refuse instead of reusing stale authority',stale_snapshot)

    def authority_mutation(db):
        original=sql(db,"SELECT pg_get_functiondef('pc_transition(text,text,integer,text,bigint,text)'::regprocedure);").stdout
        needle='VALUES(p_source,p_zid,false),(p_env,p_zid,true)'
        assert original.count(needle)==1
        sql(db,original.replace(needle,'VALUES(p_source,p_zid,true),(p_env,p_zid,true)'))
        try:
            rollback_writer(db)
            # The same restart-refusal oracle fails when transition omits revocation.
            assert sql(db,acquire_text(),user='p027_m21_python_control').stdout.startswith('2\n')
        finally:sql(db,original)
    namespace_case('negative control: missing transition revocation admits the forbidden restart',authority_mutation)

    def acquisition_mutation(db):
        rollback_writer(db)
        sql(db,'ALTER POLICY pc_namespace ON polis_coordinator_leases WITH CHECK (public.pc_namespace_allowed(math_env));')
        try:assert sql(db,acquire_text(),user='p027_m21_python_control').stdout.startswith('2\n')
        finally:sql(db,'ALTER POLICY pc_namespace ON polis_coordinator_leases WITH CHECK (public.pc_writer_allowed(math_env,zid));')
    namespace_case('negative control: namespace-only lease policy admits the forbidden restart',acquisition_mutation)

    case('observer EXECUTE privilege drift refuses replay and both down modes',drift_case('GRANT EXECUTE ON FUNCTION pc_namespace_allowed(text) TO polis_coordinator_observer;'))
    case('observer policy drift refuses replay and both down modes',drift_case('ALTER POLICY pc_observer ON polis_coordinator_operations USING (false);'))
    case('writer predicate drift refuses replay and both down modes',drift_case("CREATE OR REPLACE FUNCTION pc_writer_allowed(p_env text,p_zid integer) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN RETURN true; END $$;"))

    def revoked_live_dispatch(db, mutant=False):
        arm(db);seed_legacy(db)
        lease=sql(db,"SELECT row_to_json(l) FROM polis_coordinator_leases l;").stdout.strip()
        assert transition(db,source='generated',dest='legacy',ident='rollback').stdout.startswith('legacy_reticked|')
        # An installer-only fault restores a live, exact admitted dispatch. The
        # independent writer predicate must still stop its actual publication.
        sql(db,"DELETE FROM polis_coordinator_leases; INSERT INTO polis_coordinator_leases SELECT * FROM json_populate_record(NULL::polis_coordinator_leases,'"+lease+"');")
        definition=sql(db,"SELECT pg_get_functiondef('pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea)'::regprocedure);").stdout
        needle=' PERFORM public.pc_assert_writer(p_env,p_zid);'
        assert definition.count(needle)==1
        if mutant:sql(db,definition.replace(needle,''))
        try:
            r=call(db,ok=False)
            if mutant:
                assert not r.returncode and r.stdout.startswith('committed|0|'),r.stdout+r.stderr
            else:
                assert r.returncode and 'WRITER_AUTHORITY_REQUIRED' in r.stderr,r.stdout+r.stderr
                assert sql(db,"SELECT count(*) FROM math_main WHERE math_env='generated';").stdout.strip()=='0'
        finally:
            if mutant:sql(db,definition)
    namespace_case('authority blocks actual publication even when an installer fault restores its live admitted dispatch',revoked_live_dispatch)
    namespace_case('negative control: removing publication authority permits a restored live dispatch after rollback',lambda db:revoked_live_dispatch(db,True))

    def revoked_admit_mutation(db):
        arm(db);seed_legacy(db)
        lease=sql(db,"SELECT row_to_json(l) FROM polis_coordinator_leases l;").stdout.strip()
        assert transition(db,source='generated',dest='legacy',ident='rollback').stdout.startswith('legacy_reticked|')
        sql(db,"DELETE FROM polis_coordinator_leases; INSERT INTO polis_coordinator_leases SELECT * FROM json_populate_record(NULL::polis_coordinator_leases,'"+lease+"'); DELETE FROM polis_coordinator_operations;")
        q="SELECT pc_admit('generated',990001,'owner-a',1,'op-a',repeat('a',64),2097152);"
        user='p027_m21_python_control'
        r=sql(db,q,False,user)
        assert r.returncode and 'WRITER_AUTHORITY_REQUIRED' in r.stderr
        definition=sql(db,"SELECT pg_get_functiondef('pc_admit(text,integer,text,bigint,text,text,bigint)'::regprocedure);").stdout
        needle=' PERFORM public.pc_assert_writer(p_env,p_zid);'
        assert definition.count(needle)==1
        sql(db,definition.replace(needle,''))
        try:assert sql(db,q,user=user).stdout.strip()=='admitted'
        finally:sql(db,definition)
    namespace_case('negative control: removing admission authority permits a restored dispatch to reserve new work',revoked_admit_mutation)

    def observer_adoption(db):
        sql(db,"CREATE ROLE polis_coordinator_observer NOLOGIN; ALTER ROLE polis_coordinator_observer SET statement_timeout='3s'; GRANT USAGE ON SCHEMA public TO polis_coordinator_observer WITH GRANT OPTION;")
        before,roles=dump(db),role_state()
        apply(db);apply(db);down(db)
        assert dump(db)==before and role_state()==roles
        assert down(db,ok=False).returncode
    case('adopted observer grant option and settings survive apply replay and down exactly',observer_adoption)

    def unsafe_observer(db):
        sql(db,'CREATE ROLE polis_coordinator_observer LOGIN;')
        before,roles=dump(db),role_state()
        r=apply(db,ok=False)
        assert r.returncode and 'unsafe coordinator role attributes' in r.stderr
        assert dump(db)==before and role_state()==roles
    case('unsafe preexisting observer refuses atomically',unsafe_observer)

    def observer_membership(db):
        apply(db);sql(db,'GRANT polis_coordinator_observer TO postgres;')
        refuses_both(db,'refusing to drop role')
    case('created observer with later membership refuses both down modes',observer_membership)

    for table in ("math_main", "math_ticks", "math_bidtopid", "math_ptptstats"):
        def observer_math(db, table=table):
            arm(db); seed_legacy(db)
            login = 'p027_m21_observer'
            sql(db, f'CREATE ROLE {login} LOGIN IN ROLE polis_coordinator_observer;')
            try:
                assert sql(db, f"SELECT zid,math_env,math_tick FROM {table};", user=login).stdout.strip() == '990001|legacy|100'
                assert sql(db, "SELECT rolcanlogin FROM pg_roles WHERE rolname='polis_coordinator_observer';").stdout.strip() == 'f'
                assert sql(db, f"SELECT relrowsecurity OR relforcerowsecurity FROM pg_class WHERE oid='{table}'::regclass;").stdout.strip() == 'f'
                for statement in (f'INSERT INTO {table} DEFAULT VALUES;', f'UPDATE {table} SET math_tick=0;', f'DELETE FROM {table};', f'TRUNCATE {table};'):
                    result = sql(db, statement, False, login)
                    assert result.returncode and 'permission denied' in result.stderr, result.stderr
                for privilege in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'):
                    assert sql(db, f"SELECT has_table_privilege(current_user,'{table}','{privilege}');", user=login).stdout.strip() == 'f'
                assert sql(db, "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pc_') AND has_function_privilege(current_user,oid,'EXECUTE');", user=login).stdout.strip() == '0'
                for statement in ("SELECT pc_namespace_allowed('legacy');", "SELECT pc_writer_allowed('legacy',990001);"):
                    result = sql(db, statement, False, login)
                    assert result.returncode and 'permission denied' in result.stderr, result.stderr
            finally:
                sql(db, f'DROP ROLE {login};')
        namespace_case(f'actual observer login reads populated {table}; no writes, function execution, LOGIN capability or RLS added', observer_math)
        case(f'observer {table} SELECT revoked: both downs and replay refuse',
             drift_case(f'REVOKE SELECT ON {table} FROM polis_coordinator_observer;'))
        case(f'observer {table} added grant option: both downs and replay refuse',
             drift_case(f'GRANT SELECT ON {table} TO polis_coordinator_observer WITH GRANT OPTION;'))

    summary = {"schema": "polis-coordinator-migration-test/1", "passed": len(RESULTS) - len(FAILURES), "failed": len(FAILURES), "failures": FAILURES,
               "skipped": 0, "cases": RESULTS, "migration_count_before_000021": len(migrations),
               "source_sha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in [UP, DOWN, Path(__file__), ROOT / 'down/test_000021_down.sh', ROOT / 'down/test_000021.compose.yml', ROOT / 'down/000021-files.sha256']},
               "baseline_sha256": hashlib.sha256(baseline.encode()).hexdigest()}
    (WORK / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: summary[k] for k in ("passed", "failed", "skipped")}))
    if FAILURES:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
