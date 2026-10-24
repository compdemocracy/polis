"""Apply a historical harness migration without changing its SQL or inventory.

Header-marked files delegate to the deployment runner's concurrent-index parser
and verifier. The caller must commit earlier work and use an autocommit session;
otherwise a separate builder could wait on the caller's transaction forever.
"""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MARKER = "-- polis-migrate: concurrent-indexes"


def apply_migration(connection, path, *, ca_file=None):
    source = path.read_text()
    if not connection.autocommit or connection.get_transaction_status() != 0:
        raise ValueError("migration harness requires an idle autocommit connection")
    header = []
    for line in source.splitlines():
        if line.strip() and not line.lstrip().startswith("--"):
            break
        header.append(line.strip())
    if MARKER in header:
        from psycopg2.extensions import make_dsn
        # connection.dsn omits the password. Forward it only in the child
        # environment, preserving the transport of the admitted connection.
        dsn = make_dsn(connection.dsn, password=connection.info.password,
                       sslmode="require" if connection.info.ssl_in_use else "disable")
        environment = dict(os.environ, DATABASE_URL=dsn)
        if ca_file:
            environment["POLIS_MIGRATE_CA_FILE"] = str(ca_file)
        runner = os.environ.get("POLIS_MIGRATE_BIN")
        command = [runner] if runner else [
            "cargo", "run", "--quiet", "--locked", "-p", "polis-migrate", "--"]
        subprocess.run(command + ["prepare-indexes", "--file", str(path.resolve())],
                       cwd=None if runner else ROOT / "queue-rs", check=True,
                       env=environment)
    else:
        with connection.cursor() as cursor:
            cursor.execute(source)
