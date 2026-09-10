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
ROLES = ("polis_coordinator_control", "polis_coordinator_owner", "polis_coordinator_publication_owner", "polis_coordinator_publisher")
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
        sql(db, "INSERT INTO conversations(zid,topic) VALUES (990001,'synthetic 000021'); INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES ('synthetic',990001,'owner-a',1,clock_timestamp()+interval '1 minute');")
        p = down(db, ok=False)
        assert p.returncode and "contains data" in p.stderr
        assert sql(db, "SELECT count(*) FROM polis_coordinator_leases;").stdout.strip() == "1"
        down(db, True)
        assert sql(db, "SELECT topic FROM conversations WHERE zid=990001;").stdout.strip() == "synthetic 000021"
        assert dump(db) == baseline
    case("live data refuses normally; force preserves source conversation", live)

    def sequence(db):
        sql(db, "INSERT INTO conversations(zid) VALUES (990001); INSERT INTO math_main(zid,math_env,caching_tick,data,last_vote_timestamp) VALUES(990001,'synthetic',734,'{}',0);")
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
        ("RLS", "ALTER TABLE polis_coordinator_leases ENABLE ROW LEVEL SECURITY;"),
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
        sql(db, "INSERT INTO conversations(zid) VALUES(990001); INSERT INTO polis_coordinator_generations(math_env,zid,math_tick,caching_tick,owner_id,publisher_epoch,operation_id,capability_sha256,expected_tick,input_checkpoint) VALUES('synthetic',990001,0,1,'owner-a',1,'op-a',repeat('a',64),NULL,'{}');")
        p = sql(db, "INSERT INTO polis_coordinator_payloads VALUES('synthetic',990001,0,'main',convert_to('{}','UTF8'),repeat('0',64),repeat('a',64));", ok=False)
        assert p.returncode and "check constraint" in p.stderr
        sql(db, "INSERT INTO polis_coordinator_payloads VALUES('synthetic',990001,0,'main',convert_to('{}','UTF8'),encode(sha256(convert_to('{}','UTF8')),'hex'),repeat('a',64));")
        assert sql(db, "INSERT INTO polis_coordinator_generations(math_env,zid,math_tick,caching_tick,owner_id,publisher_epoch,operation_id,capability_sha256,expected_tick,input_checkpoint) VALUES('synthetic',990001,1,2,'owner-a',1,'op-a',repeat('a',64),0,'{}');", ok=False).returncode
        assert sql(db, "INSERT INTO polis_coordinator_payloads SELECT math_env,zid,9,payload_kind,original_bytes,original_sha256,storage_sha256 FROM polis_coordinator_payloads;", ok=False).returncode
        down(db, True)
    case("original byte integrity, operation uniqueness and generation FK controls", originals)

    def writer_race(db):
        apply(db)
        sql(db, "INSERT INTO conversations(zid) VALUES(990001);")
        proc = subprocess.Popen(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        proc.stdin.write("BEGIN; INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('synthetic',990001,'owner-a',1,clock_timestamp()+interval '1 minute'); SELECT pg_sleep(2); COMMIT;\n")
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
        sql(db, "INSERT INTO conversations(zid) VALUES(990001); INSERT INTO polis_coordinator_leases(math_env,zid,owner_id,owner_epoch,expires_at) VALUES('synthetic',990001,'owner-a',1,clock_timestamp()+interval '1 minute');")
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
        VALUES('synthetic',990001,'{owner}',{epoch},clock_timestamp()+{duration},'{operation}',
         encode(sha256(decode(repeat('ab',32),'hex')),'hex'),encode(sha256(convert_to('{{}}'::jsonb::text,'UTF8')),'hex'),{expected},{margin})
        ON CONFLICT(math_env,zid) DO UPDATE SET owner_id=excluded.owner_id,owner_epoch=excluded.owner_epoch,
         expires_at=excluded.expires_at,dispatch_operation_id=excluded.dispatch_operation_id,
         dispatch_capability_sha256=excluded.dispatch_capability_sha256,dispatch_checkpoint_sha256=excluded.dispatch_checkpoint_sha256,
         dispatch_expected_tick=excluded.dispatch_expected_tick,dispatch_margin_ms=excluded.dispatch_margin_ms;""")

    def call(db, operation="op-a", epoch=1, owner="owner-a", expected="NULL", capability="ab", checkpoint="{}", ok=True):
        return sql(db, f"""SELECT * FROM pc_publish('synthetic',990001,'{owner}',{epoch},'{operation}',
         decode(repeat('{capability}',32),'hex'),{expected},'{checkpoint}',
         convert_to('{{"zid":990001,"lastVoteTimestamp":0,"value":1.0}}','UTF8'),
         convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'),
         convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'));""",ok=ok,user="p027_m21_publisher")

    def publication_case(name, body):
        def wrapped(db):
            apply(db)
            sql(db, "CREATE ROLE p027_m21_publisher LOGIN IN ROLE polis_coordinator_publisher;")
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
        assert sql(db, "SET ROLE polis_coordinator_control; SELECT * FROM pc_publish('synthetic',990001,'owner-a',1,'op-a',decode(repeat('ab',32),'hex'),NULL,'{}','{}','{}','{}');",ok=False).returncode
    publication_case("real restricted publisher commits coherent rows/receipts and retries idempotently; direct writes denied", published)

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
        sql(db,"INSERT INTO math_ticks(zid,math_env,math_tick) VALUES(990001,'synthetic',7);")
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
            p=sql(db,f"""SELECT * FROM pc_publish('synthetic',990001,'owner-a',1,'op-a',decode(repeat('ab',32),'hex'),NULL,'{{}}',
              convert_to('{raw}','UTF8'),convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'),convert_to('{{"zid":990001,"lastVoteTimestamp":0}}','UTF8'));""",ok=False,user='p027_m21_publisher')
            assert p.returncode and ('INVALID_ORIGINAL_JSON' in p.stderr or 'FOREIGN_OR_INCONSISTENT_PAYLOAD' in p.stderr),p.stderr
        assert sql(db,"SELECT count(*) FROM math_main;").stdout.strip()=="0"
    publication_case("duplicate/nonfinite/foreign original payloads refused before writes",malformed_json)

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
