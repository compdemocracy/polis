"""Real migrated PG, process launcher and pinned independent C assertion assets.

Collection safety. The Delphi CI job copies `delphi/tests` into the delphi image
at `/app/tests`, where neither `coordinator-rs/` nor a repository checkout
exists. The projection-gate CI uses `POLIS_CHECKOUT_DIR` for a partial scan
root; that is deliberately not the coordinator override. Everything here needs
both — the crate's built binary, the crate's migration, and a read-only `git show` of the pinned reference fold/mapping
assets — so this conftest locates the checkout by walking up for
`coordinator-rs/Cargo.toml` (override: `POLIS_COORDINATOR_CHECKOUT_DIR`) and,
when it cannot, ignores this whole directory with a clear reason instead of raising while
collecting. An explicit `POLIS_COORDINATOR_CHECKOUT_DIR` that does not resolve
is a hard error rather than a silent skip. When the checkout IS present nothing here is
weakened: every fixture and assertion behaves exactly as before.
"""
import ast
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

import psycopg2
import pytest
import sqlalchemy as sa

_HERE = Path(__file__).resolve()
_MARKER = "coordinator-rs/Cargo.toml"


def _locate_checkout():
    """Return (root, skip_reason, fatal_reason). Never raises, never exits."""
    override = os.environ.get("POLIS_COORDINATOR_CHECKOUT_DIR")
    if override:
        root = Path(override).expanduser()
        if (root / _MARKER).is_file():
            return root.resolve(), None, None
        return None, None, (
            f"POLIS_COORDINATOR_CHECKOUT_DIR={override!r} does not contain {_MARKER}; unset it "
            "or point it at a polis checkout"
        )
    for candidate in _HERE.parents:
        if (candidate / _MARKER).is_file():
            return candidate, None, None
    return None, (
        f"no polis checkout containing {_MARKER} above {_HERE.parent}: these tests need "
        "the coordinator-rs crate, its migration and the pinned git reference assets "
        "(set POLIS_COORDINATOR_CHECKOUT_DIR to run them from a copied test tree)"
    ), None


ROOT, _SKIP, _FATAL = _locate_checkout()
if ROOT is not None and _SKIP is None:
    # Either a Rust toolchain or an already-built fault binary. A missing
    # binary with cargo present is still a loud failure, not a skip.
    if (shutil.which("cargo") is None
            and not (ROOT / "coordinator-rs/target/fault/debug/polis-coordinator").exists()):
        _SKIP = ("neither cargo nor a built coordinator-rs fault binary is available, so the "
                 "process these tests launch cannot exist here")
    elif shutil.which("git") is None or not (ROOT / ".git").exists():
        _SKIP = (f"git or {ROOT}/.git is unavailable, so the pinned independent fold and "
                 "R09 mapping assets cannot be read")
_UNAVAILABLE = _SKIP or _FATAL
if _UNAVAILABLE:
    # Nothing in this directory is collected, so no test module imports the
    # names below and no assertion is silently weakened.
    collect_ignore_glob = ["*"]

    def pytest_report_collectionfinish(config):
        return f"coordinator tests not collected: {_UNAVAILABLE}"


def pytest_configure(config):
    # Neither import nor collection time: an unusable explicit override fails
    # the run cleanly instead of disappearing into a skip.
    if _FATAL:
        raise pytest.UsageError(_FATAL)


ROOT = ROOT if ROOT is not None else _HERE.parents[2]
BINARY = ROOT / "coordinator-rs/target/fault/debug/polis-coordinator"
REFERENCE = "aaaf7ca5c93f9a758b28e7a361c3b9544e24305a"
WRITER_REF = "b3262008f"
ARTIFACTS = Path(os.environ.get("P027_BRIDGE_ARTIFACTS", ROOT / "coordinator-rs/artifacts"))
if not _UNAVAILABLE:
    ARTIFACTS.mkdir(exist_ok=True)


def asset(name):
    return subprocess.check_output(["git", "show", f"{REFERENCE}:delphi/tests/poller/recovery/{name}"], cwd=ROOT, text=True)


def oracle_module():
    import types
    mod = types.ModuleType("p026_independent_fold")
    sys.modules[mod.__name__] = mod
    exec(compile(asset("fold.py"), "pinned-fold.py", "exec"), mod.__dict__)
    return mod


# Guarded only so that an uncollectable tree (see the module docstring) cannot
# raise from `git show` while pytest is still importing conftests.
FOLD = MAPPING = None
if not _UNAVAILABLE:
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
            # The production 000021 migration above supplies all ownership state;
            # the prototype ALTER-math migration is deliberately never applied.
            cur.execute("CREATE ROLE p027_bridge_control LOGIN; CREATE ROLE p027_bridge_publisher LOGIN")
            cur.execute("GRANT polis_coordinator_control TO p027_bridge_control; GRANT polis_coordinator_publisher TO p027_bridge_publisher")
            cur.execute("GRANT USAGE ON SCHEMA public TO p027_bridge_control,p027_bridge_publisher")
            cur.execute("GRANT SELECT ON conversations,participants,comments,votes,math_ticks,math_main,math_bidtopid,math_ptptstats TO p027_bridge_control")
            cur.execute("GRANT UPDATE(topic) ON conversations TO p027_bridge_control")
            cur.execute("CREATE TABLE p026_test_marker(namespace text primary key)")
            cur.execute("GRANT SELECT ON p026_test_marker TO p027_bridge_control,p027_bridge_publisher")
            cur.execute((ROOT / "delphi/tests/coordinator/bridge_faults.sql").read_text())
        c.close()
        yield base, name
    finally:
        c.close()
        admin = connect(base)
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
            cur.execute("DROP ROLE IF EXISTS p027_bridge_control,p027_bridge_publisher")
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
        # Compatibility projection for the original assertion suite: metadata
        # now comes from new tables, not added columns on the math tables.
        for table, row in result.items():
            if not row:
                continue
            if table == "math_ticks":
                cur.execute("SELECT publisher_epoch,input_checkpoint,operation_id FROM polis_coordinator_generations WHERE zid=%s AND math_env=%s AND math_tick=%s",(zid,env,row["math_tick"]))
                meta=cur.fetchone()
                row.update(dict(zip(("publisher_epoch","input_checkpoint","operation_id"),meta or (None,None,None))))
            else:
                cur.execute("SELECT original_bytes,original_sha256 FROM polis_coordinator_payloads WHERE zid=%s AND math_env=%s AND math_tick=%s AND payload_kind=%s",(zid,env,row["math_tick"],table.removeprefix("math_")))
                meta=cur.fetchone()
                row.update(dict(zip(("original_bytes","original_sha256"),meta or (None,None))))
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
        self.out = self.err = None
        from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
        parsed=urlsplit(url)
        def restricted(role):
            return urlunsplit(parsed._replace(netloc=role+"@"+parsed.netloc.split("@")[-1],query=urlencode(dict(parse_qsl(parsed.query),sslmode="disable"))))
        process_env = dict(os.environ, DATABASE_URL=restricted("p027_bridge_control"),
            COORDINATOR_PUBLISHER_DATABASE_URL=restricted("p027_bridge_publisher"), MATH_ENV=env, P026_PYTHON=sys.executable,
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
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,cwd=ROOT/"delphi",start_new_session=True)

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
        # Existing crash cases terminate the whole component. Dedicated bridge
        # cases kill only the parent to exercise a surviving stale Python child.
        os.killpg(self.proc.pid,signal.SIGKILL)
        self.out, self.err = self.proc.communicate(timeout=10)
        assert self.proc.returncode == -signal.SIGKILL
        return self.out, self.err


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


def lease(url, zid=1, env="rustproto"):
    """The durable lease row exactly as a competing process would observe it."""
    c = connect(url)
    with c.cursor() as cur:
        cur.execute("SELECT owner_id,owner_epoch,expires_at>clock_timestamp() FROM polis_coordinator_leases WHERE math_env=%s AND zid=%s", (env, zid))
        row = cur.fetchone()
    c.close()
    return dict(zip(("owner_id", "owner_epoch", "unexpired"), row)) if row else None


def wait(predicate, timeout=90, alive=None, why="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        if alive is not None:
            assert alive.proc.poll() is None, (why, alive.proc.poll())
        time.sleep(.05)
    pytest.fail(f"{why} not reached in {timeout}s")


def repair_after_unclean_death(launch, db, predicate, lease_seconds="2", timeout=90, why="repair"):
    """Restart after a SIGKILL without ever expiring the dead owner's lease.

    The restarted process must defer the conversation while the dead owner's
    lease is genuinely live and repair once it elapses in database time.
    """
    child = launch(db, "run", extra={"P026_LEASE_SECONDS": lease_seconds, "P026_POLL_MS": "50"})
    wait(predicate, timeout=timeout, alive=child, why=why)
    return child.kill()


def expire(url):
    c = connect(url)
    with c.cursor() as cur:
        cur.execute("UPDATE polis_coordinator_leases SET expires_at=clock_timestamp()-interval '1 second'")
    c.close()
