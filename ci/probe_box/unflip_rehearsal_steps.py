"""The un-flip rehearsal's step machine, run against a temporary restored copy.

    preflight -> PR-A DDL if absent -> PRE -> MIGRATE (dry: inside a ROLLBACK;
    flip: committed) -> RE-RUN (must refuse at the version guard) -> POST +
    VACUUM -> restore rule on a second copy -> state for the verifier

Every phase reads and returns a box-local state document
(polis-unflip-rehearsal-state/1). The state never leaves the box: it holds
per-case digests so a failed assertion can be named, and the verifier reduces
it to the closed receipt (unflip_rehearsal.build_receipt). A phase that meets
a refusal records its closed name and every later phase does nothing, so the
verifier still writes a REFUSE receipt.

The machine needs a DB-API `connect()` (psycopg2 in the reader image and the
tests) and touches nothing else. Served pca2 bytes, exports and the engine's
cold rebuilds come from collectors the caller passes in: the reader image
supplies loopback-server collectors, the producer image the engine, and the
tests generated-fixture collectors. Every query is a named block of the bound
queries file; the migration is the bound held file.
"""
from __future__ import annotations

import hashlib
import threading
import time

from unflip_rehearsal import (ENGINE_LABEL, GUARD_SQLSTATE, SERVER_MAJOR, WALL_BUDGET_SECONDS, digest, empty_state,
                              encoded, migration_body, parse_queries, restore_shape, validate_run_spec)

# The monitor's sampling cadence during the migration (pg_locks waiters).
SAMPLE_SECONDS = 1.0
GIB = 1024 ** 3


class Refusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def sqlstate(error):
    return getattr(error, 'pgcode', None)


class Copy:
    """One restored copy: a connect() and the bound query texts."""

    def __init__(self, connect, queries):
        self.connect, self.q = connect, queries

    def run(self, cur, name, params=None):
        sql, _ = self.q[name]
        if params is None:
            cur.execute(sql)
        else:
            cur.execute(sql, params)

    def one(self, cur, name, params=None):
        self.run(cur, name, params)
        return cur.fetchone()

    def all(self, cur, name, params=None):
        self.run(cur, name, params)
        return cur.fetchall()

    def autocommit(self):
        conn = self.connect()
        conn.autocommit = True
        return conn


def refuse(state, code):
    if code not in state['refusals']:
        state['refusals'].append(code)
    state['refusals'].sort()
    return state


def stopped(state):
    return bool(state['refusals'])


# ---------------------------------------------------------------------------
# Preflight and the convention DDL.
# ---------------------------------------------------------------------------
def bind_files(spec, *, ddl, migration, queries):
    """The refusals for any input that is not the bound bytes."""
    found = []
    if digest(migration) != spec['migration_sql_sha256']:
        found.append('MIGRATION_DIGEST')
    if digest(ddl) != spec['convention_ddl_sha256']:
        found.append('DDL_DIGEST')
    if digest(queries) != spec['queries_sha256']:
        found.append('QUERIES_DIGEST')
    return found


def convention_state(copy, cur):
    present = copy.one(cur, 'objects')
    if not present[0]:
        return None
    version, agree = copy.one(cur, 'convention')
    (unflip_rows,) = copy.one(cur, 'unflip_ledger') if present[1] else (0,)
    return int(version), int(agree), int(unflip_rows)


def preflight(copy, state, spec, *, ddl, migration, queries):
    """Refuse before any write: digests, server, session, snapshot age, restore
    shape and storage headroom. Then apply PR-A's DDL when the copy predates it,
    and require the convention at version 0 / -1 with no un-flip ledger row."""
    state['preflight'] = pf = {'server_version_num': None, 'snapshot_age_s': None, 'free_storage_gb': None,
                               'convention_ddl_applied': False}
    for code in bind_files(spec, ddl=ddl, migration=migration, queries=queries):
        refuse(state, code)
    class_ok, storage_ok = restore_shape(spec)
    if not (class_ok and storage_ok):
        refuse(state, 'RESTORE_SHAPE')
    conn = copy.autocommit()
    try:
        with conn.cursor() as cur:
            version_num, superuser, now_ms = copy.one(cur, 'session')
            pf['server_version_num'] = int(version_num)
            if int(version_num) // 10000 != SERVER_MAJOR:
                refuse(state, 'SERVER_VERSION')
            if superuser != 'off':
                # RDS never hands out a superuser; the master role is rds_superuser.
                refuse(state, 'SUPERUSER_SESSION')
            pf['snapshot_age_s'] = round(max(0, int(now_ms) - spec['snapshot_created_ms']) / 1000, 3)
            if pf['snapshot_age_s'] > spec['max_snapshot_age_seconds']:
                refuse(state, 'SNAPSHOT_STALE')
            (used,) = copy.one(cur, 'database_bytes')
            # The copy's observed allocation (restore step), never below zero.
            allocated = spec['restore_observed']['allocated_storage_gb']
            pf['free_storage_gb'] = round(max(0.0, allocated - int(used) / GIB), 3)
            if pf['free_storage_gb'] < spec['min_free_storage_gb']:
                refuse(state, 'STORAGE_HEADROOM')
            if stopped(state):
                return state
            current = convention_state(copy, cur)
            if current is None:
                cur.execute(ddl.decode('utf-8'))
                pf['convention_ddl_applied'] = True
                current = convention_state(copy, cur)
            if current != (0, -1, 0) or not copy.one(cur, 'objects')[2]:
                refuse(state, 'CONVENTION_STATE')
    finally:
        conn.close()
    return state


# ---------------------------------------------------------------------------
# PRE / POST recordings.
# ---------------------------------------------------------------------------
class Stream:
    """A running sha256 over canonical lines; nothing is kept but the digest and a count."""

    def __init__(self):
        self.h, self.n = hashlib.sha256(), 0

    def add(self, row):
        self.h.update(encoded(list(row)) + b'\n')
        self.n += 1


def order(row):
    return row[0], row[1] is None, row[1] if row[1] is not None else 0


def raw_counts(copy, cur):
    """[table, raw vote or None, count] rows in a fixed order (NULL last)."""
    return sorted(([t, None if v is None else int(v), int(n)] for t, v, n in copy.all(cur, 'raw_counts')), key=order)


def mirrored(pre, post):
    """Post counts are the pre counts with -1 and +1 exchanged; 0 and NULL unchanged."""
    def flip(v):
        return -v if v in (-1, 1) else v
    return sorted(([t, flip(v), n] for t, v, n in pre), key=order) == sorted(post, key=order)


def record_sql(copy, cur):
    """Totals, per-conversation semantic aggregates, per-participant hashes and
    raw counts, all inside the caller's one REPEATABLE READ snapshot."""
    (lsn,) = copy.one(cur, 'wal_lsn')
    votes, votes_latest, conversations = copy.one(cur, 'totals')
    agg = Stream()
    for row in copy.all(cur, 'aggregates_votes'):
        agg.add(['v', *map(int, row)])
    for row in copy.all(cur, 'aggregates_latest'):
        agg.add(['u', *map(int, row)])
    hashes = Stream()
    cur.itersize = 10000
    copy.run(cur, 'participant_hashes')
    for zid, pid, h in cur:
        hashes.add([int(zid), int(pid), h])
    return {'conversations': int(conversations), 'participants': hashes.n, 'votes': int(votes),
            'votes_latest': int(votes_latest), 'agg_sha256': agg.h.hexdigest(), 'hashes_sha256': hashes.h.hexdigest(),
            'lsn_before_sha256': digest(str(lsn).encode()), 'raw': raw_counts(copy, cur)}


def snapshot(copy, fn):
    conn = copy.connect()
    try:
        conn.set_session(isolation_level='REPEATABLE READ', readonly=True, autocommit=False)
        with conn.cursor() as cur:
            return fn(cur)
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()


def zid_key(zid):
    return digest(str(int(zid)).encode())


def select_zids(copy, spec):
    """The certification conversations (found by the sha256 of their public
    conversation id) and a deterministic sample ordered by sha256(zid)."""
    def read(cur):
        cert = [int(z) for (z,) in copy.all(cur, 'certification', {'digests': spec['certification_sha256']})]
        rest = [int(z) for (z,) in copy.all(cur, 'sample', {'exclude': cert or [-1],
                                                           'limit': spec['sample_conversations'] - len(cert)})]
        return cert, rest
    cert, rest = snapshot(copy, read)
    if len(cert) != spec['certification_conversations']:
        raise Refusal('CERTIFICATION_MISSING')
    return {'certification': cert, 'sample': cert + rest}


def collect(collectors, name, *args):
    fn = collectors.get(name) if collectors else None
    if fn is None:
        return {}
    try:
        out = fn(*args)
    except Exception:
        raise Refusal('COLLECTION_FAILED') from None
    if type(out) is not dict or any(type(k) is not str or type(v) is not str for k, v in out.items()):
        raise Refusal('COLLECTION_FAILED')
    return out


def phase_pre(copy, state, spec, *, ddl, migration, queries, collectors=None):
    """Preflight, the DDL and the PRE recording (served bytes and exports in flip mode)."""
    preflight(copy, state, spec, ddl=ddl, migration=migration, queries=queries)
    if stopped(state):
        return state
    try:
        if spec['mode'] == 'flip':
            state['zids'] = select_zids(copy, spec)
        state['pre'] = snapshot(copy, lambda cur: record_sql(copy, cur))
        if spec['mode'] == 'flip':
            cert = state['zids']['certification']
            state['pre_cases'] = {'pca2': collect(collectors, 'served', 'pre', cert),
                                  'exports': collect(collectors, 'exports', 'pre', cert)}
    except Refusal as r:
        refuse(state, r.code)
    return state


# ---------------------------------------------------------------------------
# The engine's cold rebuilds (the producer image; in-process in the tests).
# ---------------------------------------------------------------------------
def engine_digests(copy, zids):
    def read(cur):
        return {zid_key(z): h for z, h in copy.all(cur, 'engine_rows', {'label': ENGINE_LABEL, 'zids': zids})}
    return snapshot(copy, read)


def phase_engine(copy, state, which, rebuild):
    """Clear the probe label, rebuild the sample under it, record math_main digests.

    `rebuild(zids, label)` is the engine: it computes each conversation cold
    from the copy and publishes math_main under `label`, which nothing serves.
    Rebuild-to-rebuild: the post rebuild deletes the pre rows first."""
    if stopped(state) or state['zids'] is None or (which == 'post' and state['post'] is None):
        return state
    zids = state['zids']['sample']
    try:
        conn = copy.autocommit()
        try:
            with conn.cursor() as cur:
                copy.run(cur, 'engine_clear', {'label': ENGINE_LABEL})
        finally:
            conn.close()
        rebuild(list(zids), ENGINE_LABEL)
        got = engine_digests(copy, zids)
    except Refusal as r:
        refuse(state, r.code)
        return state
    except Exception:
        refuse(state, 'COLLECTION_FAILED')
        return state
    if len(got) != len(set(zids)):
        refuse(state, 'COLLECTION_FAILED')
        return state
    state[which + '_cases']['math'] = got
    return state


# ---------------------------------------------------------------------------
# MIGRATE and RE-RUN.
# ---------------------------------------------------------------------------
class Monitor(threading.Thread):
    """Samples lock waiters on its own connection; cancels the migration's
    backend once if the wall budget passes. Records maxima only."""

    def __init__(self, copy, pid, wall_budget_s, interval):
        super().__init__(daemon=True)
        self.copy, self.pid, self.budget, self.interval = copy, pid, wall_budget_s, interval
        self.stop = threading.Event()
        self.started_at = time.monotonic()
        self.max_waiters = self.max_wait_ms = 0
        self.cancelled = False
        self.failed = False

    def run(self):
        try:
            conn = self.copy.autocommit()
        except Exception:
            self.failed = True
            return
        try:
            with conn.cursor() as cur:
                while not self.stop.is_set():
                    waiters, longest = self.copy.one(cur, 'lock_sample')
                    self.max_waiters = max(self.max_waiters, int(waiters))
                    self.max_wait_ms = max(self.max_wait_ms, int(longest))
                    if not self.cancelled and time.monotonic() - self.started_at > self.budget:
                        self.copy.one(cur, 'cancel_backend', {'pid': self.pid})
                        self.cancelled = True
                    self.stop.wait(self.interval)
        except Exception:
            self.failed = True
        finally:
            conn.close()


def sizes(copy, cur):
    heap, indexes, dead = copy.one(cur, 'sizes')
    return int(heap), int(indexes), int(dead)


def phase_migrate(copy, state, spec, *, migration, wall_budget_s=WALL_BUDGET_SECONDS, interval=SAMPLE_SECONDS):
    """Run the held file (flip: committed; dry: its body inside a transaction
    that is rolled back) under the monitor, then the re-run."""
    if stopped(state) or state['pre'] is None:
        return state
    text = migration.decode('utf-8')
    body = migration_body(migration)
    conn = copy.autocommit()
    measured = {}
    try:
        with conn.cursor() as cur:
            (pid,) = copy.one(cur, 'backend')
            (lsn,) = copy.one(cur, 'wal_lsn')
            heap0, index0, _ = sizes(copy, cur)
            monitor = Monitor(copy, int(pid), wall_budget_s, interval)
            monitor.start()
            started = time.monotonic()
            error = None
            in_transaction = None
            try:
                if spec['mode'] == 'flip':
                    cur.execute(text)
                else:
                    cur.execute('BEGIN')
                    cur.execute(body)
            except Exception as e:
                error = e
            wall = time.monotonic() - started
            monitor.stop.set()
            monitor.join()
            if error is not None:
                cur.execute('ROLLBACK')
            elif spec['mode'] == 'dry':
                # Measured inside the open transaction, before it is rolled back.
                in_transaction = raw_counts(copy, cur)
                (wal,) = copy.one(cur, 'wal_since', {'lsn': lsn})
                heap1, index1, dead1 = sizes(copy, cur)
                rerun = rerun_in_transaction(cur, body)
                cur.execute('ROLLBACK')
            if spec['mode'] == 'flip' or error is not None:
                (wal,) = copy.one(cur, 'wal_since', {'lsn': lsn})
                heap1, index1, dead1 = sizes(copy, cur)
            measured = {'wall_s': round(wall, 3), 'wal_bytes': max(0, int(wal)),
                        'max_lock_waiters': monitor.max_waiters, 'max_lock_wait_ms': monitor.max_wait_ms,
                        'heap_growth_bytes': heap1 - heap0, 'index_growth_bytes': index1 - index0,
                        'dead_tuples_after': dead1, 'counts_mirrored': False, 'vacuum_s': None}
            state['migrate'] = measured
            if monitor.failed:
                refuse(state, 'COLLECTION_FAILED')
            if monitor.max_wait_ms > spec['lock_wait_budget_ms'] or sqlstate(error) == '55P03':
                refuse(state, 'LOCK_BUDGET')
            if monitor.cancelled or wall > wall_budget_s or sqlstate(error) == '57014':
                refuse(state, 'WALL_BUDGET')
            if error is not None:
                refuse(state, 'MIGRATION_FAILED')
                return state
            if spec['mode'] == 'flip':
                after = snapshot(copy, lambda c: raw_counts(copy, c))
                measured['counts_mirrored'] = mirrored(state['pre']['raw'], after)
                rerun = rerun_file(cur, text)
            else:
                measured['counts_mirrored'] = mirrored(state['pre']['raw'], in_transaction)
            state['rerun'] = rerun
            if not rerun['refused']:
                refuse(state, 'RERUN_NOT_REFUSED')
    finally:
        conn.close()
    return state


def refusal_of(error):
    code = sqlstate(error) or ''
    return {'refused': code == GUARD_SQLSTATE, 'sqlstate_class': code[:2] if len(code) == 5 else 'NONE'}


def rerun_file(cur, text):
    """The committed flip run again: it must fail at the version guard."""
    try:
        cur.execute(text)
    except Exception as e:
        cur.execute('ROLLBACK')
        return refusal_of(e)
    return {'refused': False, 'sqlstate_class': 'NONE'}


def rerun_in_transaction(cur, body):
    """The dry run's re-run: the body again inside the same open transaction,
    behind a savepoint, where the convention already reads version 1."""
    cur.execute('SAVEPOINT unflip_rerun')
    try:
        cur.execute(body)
    except Exception as e:
        cur.execute('ROLLBACK TO SAVEPOINT unflip_rerun')
        return refusal_of(e)
    return {'refused': False, 'sqlstate_class': 'NONE'}


# ---------------------------------------------------------------------------
# POST.
# ---------------------------------------------------------------------------
def insert_roundtrip(copy):
    """One agree through vote_insert() lands as +1 and reads back as agree; rolled back."""
    conn = copy.connect()
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            target = copy.one(cur, 'insert_target')
            if target is None:
                return 'FAIL'
            zid, pid, tid = map(int, target)
            vote, created, version = copy.one(cur, 'insert_roundtrip', {'zid': zid, 'pid': pid, 'tid': tid})
            semantic, latest = copy.one(cur, 'insert_readback', {'zid': zid, 'pid': pid, 'tid': tid,
                                                                 'created': created})
            ok = (int(vote), int(version), semantic, latest) == (1, 1, 1, 1)
        return 'PASS' if ok else 'FAIL'
    except Exception:
        return 'FAIL'
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()


def phase_post(copy, state, spec, *, collectors=None):
    """Flip: VACUUM, the POST recording, the convention row and the insert round
    trip. Dry: the SQL recording again, proving the rollback left the copy as it was."""
    if stopped(state) or state['migrate'] is None:
        return state
    try:
        if spec['mode'] == 'flip':
            conn = copy.autocommit()
            try:
                with conn.cursor() as cur:
                    started = time.monotonic()
                    cur.execute('VACUUM (VERBOSE) public.votes, public.votes_latest_unique')
                    state['migrate']['vacuum_s'] = round(time.monotonic() - started, 3)
                    state['migrate']['dead_tuples_after'] = sizes(copy, cur)[2]
            finally:
                conn.close()
        state['post'] = snapshot(copy, lambda cur: record_sql(copy, cur))
        state['convention_after'] = snapshot(copy, lambda cur: list(map(int, copy.one(cur, 'convention'))))
        if spec['mode'] == 'flip':
            cert = state['zids']['certification']
            state['post_cases'] = {'pca2': collect(collectors, 'served', 'post', cert),
                                   'exports': collect(collectors, 'exports', 'post', cert)}
            state['insert_roundtrip'] = insert_roundtrip(copy)
    except Refusal as r:
        refuse(state, r.code)
    return state


# ---------------------------------------------------------------------------
# The restore rule (P-078 section 2c step 7) on a second, pre-flip copy.
# ---------------------------------------------------------------------------
def restore_rule(copy, *, ddl, migration):
    """Absent table -> PR-A's DDL (version 0) -> forward migration -> version 1.

    A copy at version 1 with the un-flip ledger row is post-flip and serves as
    is. Any other combination (version 0 with the row, version 1 without it)
    is corruption: REFUSE. Nothing is ever served from the copy."""
    conn = copy.autocommit()
    try:
        with conn.cursor() as cur:
            current = convention_state(copy, cur)
            if current is None:
                cur.execute(ddl.decode('utf-8'))
                current = convention_state(copy, cur)
            if current == (1, 1, 1):
                return 'PASS'
            if current != (0, -1, 0):
                return 'REFUSE'
            before = raw_counts(copy, cur)
            try:
                cur.execute(migration.decode('utf-8'))
            except Exception:
                cur.execute('ROLLBACK')
                return 'REFUSE'
            after = raw_counts(copy, cur)
            return 'PASS' if convention_state(copy, cur) == (1, 1, 1) and mirrored(before, after) else 'REFUSE'
    except Exception:
        return 'REFUSE'
    finally:
        conn.close()


def phase_restore_rule(copy_r2, state, spec, *, ddl, migration):
    if spec['mode'] != 'flip' or not spec['restore_rule'] or stopped(state) or state['post'] is None:
        return state
    state['restore_rule'] = restore_rule(copy_r2, ddl=ddl, migration=migration) if copy_r2 else 'REFUSE'
    return state


# ---------------------------------------------------------------------------
# The whole machine in one process (tests and local docker parity). On the box
# the worker runs the same phases across the reader and producer containers.
# ---------------------------------------------------------------------------
def rehearse(connect, spec, *, ddl, migration, queries, collectors=None, rebuild=None, connect_r2=None,
             wall_budget_s=WALL_BUDGET_SECONDS, interval=SAMPLE_SECONDS):
    spec = validate_run_spec(spec)
    q = parse_queries(queries)
    copy = Copy(connect, q)
    state = empty_state()
    phase_pre(copy, state, spec, ddl=ddl, migration=migration, queries=queries, collectors=collectors)
    if spec['mode'] == 'flip' and rebuild is not None:
        phase_engine(copy, state, 'pre', rebuild)
    phase_migrate(copy, state, spec, migration=migration, wall_budget_s=wall_budget_s, interval=interval)
    phase_post(copy, state, spec, collectors=collectors)
    if spec['mode'] == 'flip' and rebuild is not None:
        phase_engine(copy, state, 'post', rebuild)
    phase_restore_rule(Copy(connect_r2, q) if connect_r2 else None, state, spec, ddl=ddl, migration=migration)
    return state
