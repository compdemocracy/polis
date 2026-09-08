"""Real migrated PG, process launcher and pinned independent C assertion assets."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

import psycopg2
import pytest
import sqlalchemy as sa

ROOT = Path(__file__).resolve().parents[3]
BINARY = ROOT / "coordinator-rs/target/fault/debug/polis-coordinator"
REFERENCE = "aaaf7ca5c93f9a758b28e7a361c3b9544e24305a"
WRITER_REF = "b3262008f"
ARTIFACTS = ROOT / "coordinator-rs/artifacts"
ARTIFACTS.mkdir(exist_ok=True)


def asset(name):
    return subprocess.check_output(["git", "show", f"{REFERENCE}:delphi/tests/poller/recovery/{name}"], cwd=ROOT, text=True)


def oracle_module():
    import types
    mod = types.ModuleType("p026_independent_fold")
    sys.modules[mod.__name__] = mod
    exec(compile(asset("fold.py"), "pinned-fold.py", "exec"), mod.__dict__)
    return mod


FOLD = oracle_module()
_tree = ast.parse(asset("test_r09_partial_tables_readers.py"))
_mapping = next(n for n in _tree.body if isinstance(n, ast.FunctionDef) and n.name == "_mapping_problems")
_scope = {}
exec(compile(ast.Module(body=[_mapping], type_ignores=[]), "pinned-r09.py", "exec"), _scope)
MAPPING = _scope["_mapping_problems"]


def connect(url):
    c = psycopg2.connect(url)
    c.autocommit = True
    return c


@pytest.fixture(scope="session")
def template():
    base = os.environ["POLIS_TEST_POSTGRES_URL"]
    name = "p026_template_" + uuid.uuid4().hex[:10]
    admin = connect(base)
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    admin.close()
    url = base.rsplit("/", 1)[0] + "/" + name
    c = connect(url)
    try:
        with c.cursor() as cur:
            for path in sorted((ROOT / "server/postgres/migrations").glob("*.sql")):
                cur.execute(path.read_text())
            # Exercise the production drift named in CO04: ticks lacks this column.
            cur.execute("ALTER TABLE math_ticks DROP COLUMN caching_tick")
            cur.execute((ROOT / "coordinator-rs/migration.sql").read_text())
            cur.execute("CREATE TABLE p026_test_marker(namespace text primary key)")
        c.close()
        yield base, name
    finally:
        c.close()
        admin = connect(base)
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.close()


@pytest.fixture
def db(template):
    base, template_name = template
    name = "p026_case_" + uuid.uuid4().hex[:10]
    admin = connect(base)
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}" TEMPLATE "{template_name}"')
    url = base.rsplit("/", 1)[0] + "/" + name
    c = connect(url)
    with c.cursor() as cur:
        for env in ("rustproto", "python", "positive", "negative", "reader", "recovery"):
            cur.execute("INSERT INTO p026_test_marker VALUES(%s)", (env,))
    c.close()
    yield url
    with admin.cursor() as cur:
        cur.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
    admin.close()


def seed(url, zid=1, n_ptpts=6, n_cmts=4, votes=True):
    c = connect(url)
    with c.cursor() as cur:
        cur.execute("SET session_replication_role=replica")
        cur.execute("INSERT INTO conversations(zid,topic) VALUES(%s,'Synthetic P026')", (zid,))
        for pid in range(n_ptpts):
            cur.execute("INSERT INTO participants(zid,pid,uid,mod) VALUES(%s,%s,%s,0)", (zid,pid,100000*zid+pid))
        for tid in range(n_cmts):
            cur.execute("INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified) VALUES(%s,%s,0,100000,%s,0,false,1000,1000)", (zid,tid,f'Synthetic {tid}'))
        if votes:
            for pid in range(n_ptpts):
                for tid in range(n_cmts):
                    value = [-1,1,0][(pid+tid)%3]
                    cur.execute("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(%s,%s,%s,%s,%s)", (zid,pid,tid,value,1000+pid*n_cmts+tid))
    c.close()


def rows(url, zid=1, env="rustproto"):
    c = connect(url)
    with c.cursor() as cur:
        cur.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        result = {}
        for table in ("math_main","math_bidtopid","math_ptptstats","math_ticks"):
            cur.execute(f"SELECT * FROM {table} WHERE zid=%s AND math_env=%s", (zid,env))
            r = cur.fetchone()
            result[table] = dict(zip([d[0] for d in cur.description], r)) if r else None
        cur.execute("COMMIT")
    c.close()
    return result


def assert_coherent(url, zid=1, env="rustproto", fold=True):
    tables = rows(url,zid,env)
    assert all(tables.values()), tables
    assert len({r["math_tick"] for r in tables.values()}) == 1, tables
    main,bid,stats = [tables[k]["data"] for k in ("math_main","math_bidtopid","math_ptptstats")]
    assert MAPPING(main,bid,stats) == []
    if fold:
        c = connect(url)
        with c.cursor() as cur:
            cur.execute("SELECT pid,tid,vote,created FROM votes WHERE zid=%s ORDER BY created,tid,pid,vote", (zid,))
            events = [dict(zip(("pid","tid","vote","created"), r)) for r in cur]
        c.close()
        expected = FOLD.fold_votes(events)
        assert FOLD.check_published_against_fold(main, expected) == []
        assert tables["math_ticks"]["input_checkpoint"]["event_count"] == len(events)
    return tables


class Child:
    def __init__(self, url, mode="once", env="rustproto", stage=None, directory=None, extra=None, args=()):
        self.directory = Path(directory) if directory else None
        process_env = dict(os.environ, DATABASE_URL=url, MATH_ENV=env, P026_PYTHON=sys.executable,
            PYTHONPATH=str(ROOT/"delphi"), OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1",
            PYTHONDONTWRITEBYTECODE="1", P026_PAGE_SIZE="2", P026_WINDOW="1", P026_LEASE_SECONDS="120")
        process_env.pop("P026_FAULT_DIR",None)
        if extra:
            process_env.update(extra)
        if stage:
            self.directory.mkdir(parents=True,exist_ok=True)
            (self.directory/"arm.json").write_text(json.dumps({"protocol":"polis-fault-control/1",
                "stage":stage,"run_id":"synthetic-test","operation_id":uuid.uuid4().hex}))
            process_env["P026_FAULT_DIR"] = str(self.directory)
        self.proc = subprocess.Popen([str(BINARY),mode,*map(str,args)], env=process_env,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,cwd=ROOT/"delphi")

    def ack(self):
        deadline = time.monotonic()+150
        path = self.directory/"ack.json"
        while time.monotonic()<deadline:
            if path.exists():
                ack = json.loads(path.read_text())
                assert ack["pid"] == self.proc.pid and ack["state"] == "reached-and-blocked"
                assert self.proc.poll() is None
                return ack
            if self.proc.poll() is not None:
                out,err = self.proc.communicate()
                pytest.fail(f"child exited {self.proc.returncode} before marker: {out} {err}")
            time.sleep(.01)
        pytest.fail("required stage not reached")

    def release(self):
        (self.directory/"release").write_text("release")

    def done(self, code=0):
        out,err = self.proc.communicate(timeout=150)
        assert self.proc.returncode == code, (out,err)
        return out,err

    def kill(self):
        self.proc.kill()
        self.proc.communicate(timeout=10)
        assert self.proc.returncode == -signal.SIGKILL


@pytest.fixture
def launch():
    children = []
    def make(*args, **kwargs):
        child = Child(*args,**kwargs)
        children.append(child)
        return child
    yield make
    for child in children:
        if child.proc.poll() is None:
            child.kill()


def expire(url):
    c = connect(url)
    with c.cursor() as cur:
        cur.execute("UPDATE coordinator_leases SET expires_at=clock_timestamp()-interval '1 second'")
    c.close()
