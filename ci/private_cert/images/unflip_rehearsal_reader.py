"""The un-flip rehearsal's reader: the step machine's phases against the restored copy.

The worker runs this container once per reader phase (pre, migrate, post,
restore-rule), naming the phase in /selection/phase.json. The box-local state
(/output/state.json) carries the recordings between phases; it never leaves
the box. Connections go through the worker's relay sockets (service `probe`,
and `probe_r2` for the second copy). The held migration and the queries are
this checkout's bound files; PR-A's DDL is the file the image recipe copies to
/opt/polis-unflip/convention.sql; all three are digest-checked against the job
before anything is written.

Served bytes and exports come from the polis/server this image is built on,
started on loopback only against the copy (no external integrations: the
image's server.env leaves their keys empty, as the two-convention gate's v0
leg does in CI). The server runs with MATH_ENV=probe, the engine rebuild's
label, and pca2 is collected after each rebuild (served-pre, served-post).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2] / 'probe_box'))
import unflip_rehearsal as u
import unflip_rehearsal_steps as steps

IMAGE_ROOT = Path('/opt/polis-unflip')
DDL_PATH = IMAGE_ROOT / 'convention.sql'
SERVER_ENV = IMAGE_ROOT / 'server.env'
SERVER_DIR = Path('/app')
SERVER_PORT = 5000
STATE = 'state.json'
PHASES = ('pre', 'served-pre', 'migrate', 'post', 'served-post', 'restore-rule')


def load_state(out: Path, phase: str):
    if phase == 'pre':
        return u.empty_state()
    return u.decode_state((out / STATE).read_bytes())


def save_state(out: Path, state):
    tmp = out / (STATE + '.tmp')
    tmp.write_bytes(u.encoded(state))
    tmp.replace(out / STATE)


def run_phase(phase, spec, out: Path, *, connect, connect_r2=None, collectors=None, ddl, migration, queries):
    """One reader phase; the state is read before and written after."""
    if phase not in PHASES:
        u.fail('UNFLIP_PHASE')
    spec = u.validate_run_spec(spec)
    q = u.parse_queries(queries)
    copy = steps.Copy(connect, q)
    state = load_state(out, phase)
    if phase == 'pre':
        steps.phase_pre(copy, state, spec, ddl=ddl, migration=migration, queries=queries, collectors=collectors)
    elif phase in ('served-pre', 'served-post'):
        steps.phase_served(copy, state, spec, phase.split('-')[1], collectors)
    elif phase == 'migrate':
        steps.phase_migrate(copy, state, spec, migration=migration)
    elif phase == 'post':
        steps.phase_post(copy, state, spec, collectors=collectors)
    else:
        steps.phase_restore_rule(steps.Copy(connect_r2, q) if connect_r2 else None, state, spec, ddl=ddl,
                                 migration=migration)
    save_state(out, state)
    return state


# ---------------------------------------------------------------------------
# Loopback collectors: the image's own polis/server against the copy.
# ---------------------------------------------------------------------------
def pgpass_entry(path=Path('/replica/pgpass')):
    """The first relay entry (host, port, db, user, password), unescaped."""
    line = path.read_text().splitlines()[0]
    fields, cur, escape = [], '', False
    for c in line:
        if escape:
            cur, escape = cur + c, False
        elif c == '\\':
            escape = True
        elif c == ':':
            fields.append(cur)
            cur = ''
        else:
            cur += c
    fields.append(cur)
    return fields


def server_env():
    env = {k: v for k, v in (line.split('=', 1) for line in SERVER_ENV.read_text().splitlines()
                             if line and not line.startswith('#'))}
    host, port, db, user, password = pgpass_entry()
    from urllib.parse import quote
    env.update(DATABASE_URL=f'postgresql://{quote(user)}:{quote(password)}@localhost/{quote(db)}?host={host}',
               PORT=str(SERVER_PORT), MATH_ENV=u.ENGINE_LABEL, HOME='/tmp', npm_config_cache='/tmp/npm', PATH=os.environ.get('PATH', ''))
    return env


class Server:
    def __enter__(self):
        self.p = subprocess.Popen(['node', 'dist/index.js'], cwd=SERVER_DIR, env=server_env(),
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.monotonic() + 180
        while time.monotonic() < end:
            try:
                socket.create_connection(('127.0.0.1', SERVER_PORT), timeout=1).close()
                return self
            except OSError:
                if self.p.poll() is not None:
                    break
                time.sleep(1)
        self.__exit__()
        raise steps.Refusal('COLLECTION_FAILED')

    def __exit__(self, *exc):
        self.p.terminate()
        try:
            self.p.wait(30)
        except subprocess.TimeoutExpired:
            self.p.kill()


# Served pca2 carries the column ticks (server/src/utils/pca.ts); they and the
# ETag derived from them are not semantic and are stripped before comparing.
PCA2_TICK_FIELDS = ('math_tick', 'caching_tick')


def pca2_digest(status, body: bytes, content_encoding=None):
    """Status and the pca2 body as canonical JSON without the tick fields; no ETag."""
    import gzip
    if content_encoding == 'gzip':
        body = gzip.decompress(body)
    doc = json.loads(body)
    if isinstance(doc, dict):
        doc = {k: v for k, v in doc.items() if k not in PCA2_TICK_FIELDS}
    return hashlib.sha256(f'{status}\n'.encode() + u.encoded(doc)).hexdigest()


def fetch_pca2(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{SERVER_PORT}{path}', timeout=120) as r:
        return pca2_digest(r.status, r.read(), r.headers.get('Content-Encoding'))


def fetch(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{SERVER_PORT}{path}', timeout=120) as r:
        body = r.read()
        return hashlib.sha256(f'{r.status}\n{r.headers.get("ETag", "")}\n'.encode() + body).hexdigest()


def loopback_collectors(connect, queries):
    """served: pca2 per certification conversation; exports: votes.csv of its report."""
    q = u.parse_queries(queries)

    def handles(zids):
        conn = connect()
        try:
            with conn.cursor() as cur:
                cur.execute(q['certification_handles'][0], {'zids': zids})
                rows = cur.fetchall()
        finally:
            conn.close()
        if len(rows) != len(zids) or any(r[2] is None for r in rows):
            raise steps.Refusal('CERTIFICATION_MISSING')
        return rows

    def served(phase, zids):
        with Server():
            return {str(i): fetch_pca2('/api/v3/math/pca2?conversation_id=' + zinvite)
                    for i, (_, zinvite, _) in enumerate(handles(zids))}

    def exports(phase, zids):
        with Server():
            return {str(i): fetch(f'/api/v3/reportExport/{report}/votes.csv')
                    for i, (_, _, report) in enumerate(handles(zids))}
    return {'served': served, 'exports': exports}


def main():
    if sys.argv[1:] != ['read']:
        u.fail('UNFLIP_ACTION')
    # The worker's sandbox sets it too; psycopg2 needs it to find `probe`.
    os.environ.setdefault('PGSERVICEFILE', '/replica/service.conf')
    import psycopg2
    context = json.loads(Path('/selection/context.json').read_bytes())
    phase = json.loads(Path('/selection/phase.json').read_bytes())['phase']
    queries = u.QUERIES_PATH.read_bytes()

    def connect():
        return psycopg2.connect(service='probe', connect_timeout=10)

    def connect_r2():
        return psycopg2.connect(service='probe_r2', connect_timeout=10)
    run_phase(phase, context['run_spec'], Path('/output'), connect=connect,
              connect_r2=connect_r2 if Path('/replica-r2/.s.PGSQL.5432').exists() else None,
              collectors=loopback_collectors(connect, queries), ddl=DDL_PATH.read_bytes(),
              migration=u.MIGRATION_PATH.read_bytes(), queries=queries)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('UNFLIP_READER_FAILED') from None
