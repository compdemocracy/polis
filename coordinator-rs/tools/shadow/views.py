"""Read-only keeper for one common database view used by both private readers.

The keeper proves visible publication bytes, never historical consumed inputs.
Legacy history custody is a separate admission requirement. No writer login or
publication operation is accepted here, and a lost keeper invalidates the pair.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit

import daily

TABLES = ("math_main", "math_bidtopid", "math_ptptstats", "math_ticks")
SNAPSHOT = re.compile(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+")


def private_bytes(path, limit=daily.MAX_BODY):
    p = Path(path)
    if not p.is_absolute():
        raise ValueError("SHADOW_PRIVATE_FILE")
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > limit):
            raise ValueError("SHADOW_PRIVATE_FILE")
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("SHADOW_PRIVATE_FILE")
        return raw


def connect(profile):
    """Production connection requires explicit verified CA and password file."""
    daily.closed(profile, ("url", "host", "password_file", "ca_file"))
    url = urlsplit(profile["url"])
    if (url.scheme not in ("postgres", "postgresql") or url.password or url.query
            or url.fragment or not url.username or url.hostname != profile["host"]):
        raise ValueError("SHADOW_DATABASE")
    import psycopg2
    password = private_bytes(profile["password_file"]).decode().rstrip("\r\n")
    if not password or "\x00" in password:
        raise ValueError("SHADOW_DATABASE")
    ca = Path(profile["ca_file"])
    if not ca.is_absolute() or ca.is_symlink() or not ca.is_file():
        raise ValueError("SHADOW_DATABASE")
    return psycopg2.connect(profile["url"], password=password, sslmode="verify-full",
                            sslrootcert=str(ca), connect_timeout=10,
                            application_name="shadow-readonly-keeper")


class Keeper:
    def __init__(self, connection):
        self.connection = connection
        self.snapshot = None

    def __enter__(self):
        try:
            self.connection.set_session(isolation_level="REPEATABLE READ", readonly=True,
                                        autocommit=False)
            with self.connection.cursor() as cursor:
                cursor.execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='500ms'")
                cursor.execute("""SELECT current_setting('transaction_read_only') = 'on',
                    r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
                    OR r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user""")
                if cursor.fetchone() != (True, False):
                    raise ValueError("SHADOW_DATABASE_ROLE")
                cursor.execute("""SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND
                    (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
                    OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE'))""")
                if cursor.fetchone() != (0,):
                    raise ValueError("SHADOW_DATABASE_WRITE_AUTHORITY")
                cursor.execute("""SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND starts_with(p.proname,'pc_')
                    AND has_function_privilege(current_user,p.oid,'EXECUTE')""")
                if cursor.fetchone() != (0,):
                    raise ValueError("SHADOW_DATABASE_WRITE_AUTHORITY")
                cursor.execute("SELECT pg_export_snapshot()")
                self.snapshot = cursor.fetchone()[0]
                if not isinstance(self.snapshot, str) or not SNAPSHOT.fullmatch(self.snapshot):
                    raise ValueError("SHADOW_SNAPSHOT")
            return self
        except BaseException:
            self.close()
            raise

    def visible(self, namespace, zid):
        """Hash each full row's database spelling, including all tick metadata.

        This digest is a private custody binding, not the comparison predicate.
        The original Node application reads and serializes actual database rows.
        """
        if (not self.snapshot or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", namespace)
                or type(zid) is not int or not 0 < zid < 2**31):
            raise ValueError("SHADOW_VIEW")
        result = {}
        with self.connection.cursor() as cursor:
            for table in TABLES:
                # Table identifiers come only from this constant tuple.
                cursor.execute(f"SELECT row_to_json(t)::text FROM {table} t WHERE math_env=%s AND zid=%s",
                               (namespace, zid))
                rows = cursor.fetchmany(2)
                if len(rows) != 1 or not isinstance(rows[0][0], str):
                    raise ValueError("SHADOW_VIEW_MISSING")
                raw = rows[0][0].encode()
                if len(raw) > daily.MAX_BODY:
                    raise ValueError("SHADOW_VIEW_LIMIT")
                result[table] = hashlib.sha256(raw).hexdigest()
        return result

    def admit(self, namespace, zid, expected):
        daily.closed(expected, TABLES)
        if any(not isinstance(v, str) or not daily.SHA.fullmatch(v) for v in expected.values()):
            raise ValueError("SHADOW_VIEW")
        if self.visible(namespace, zid) != expected:
            raise ValueError("SHADOW_VIEW_CHANGED")

    def admit_python(self, result):
        """The current view must still name the actual retained bridge result."""
        bundle = json.loads(result["bundle_bytes"])
        with self.connection.cursor() as cursor:
            for kind, table in zip(("main", "bidtopid", "ptptstats"), TABLES):
                cursor.execute(f"SELECT data,math_tick FROM {table} WHERE math_env=%s AND zid=%s",
                               (result["namespace"], result["zid"]))
                rows = cursor.fetchmany(2)
                if rows != [(bundle["payloads"][kind], bundle["math_tick"])]:
                    raise ValueError("SHADOW_VIEW_CHANGED")
            cursor.execute("""SELECT m.caching_tick,g.input_checkpoint,g.publisher_epoch,g.operation_id
                FROM math_main m JOIN math_ticks t ON t.math_env=m.math_env AND t.zid=m.zid
                JOIN polis_coordinator_generations g ON g.math_env=t.math_env AND g.zid=t.zid
                  AND g.math_tick=t.math_tick
                WHERE m.math_env=%s AND m.zid=%s AND m.math_tick=t.math_tick""",
                (result["namespace"], result["zid"]))
            if cursor.fetchmany(2) != [(bundle["caching_tick"], bundle["checkpoint"],
                                      bundle["publisher_epoch"], bundle["operation_id"])]:
                raise ValueError("SHADOW_VIEW_CHANGED")

    def alive(self):
        if not self.snapshot or self.connection.closed:
            raise ValueError("SHADOW_SNAPSHOT_LOST")
        with self.connection.cursor() as cursor:
            cursor.execute("SELECT current_setting('transaction_read_only') = 'on'")
            if cursor.fetchone() != (True,):
                raise ValueError("SHADOW_SNAPSHOT_LOST")

    def close(self):
        self.snapshot = None
        try:
            self.connection.rollback()
        finally:
            self.connection.close()

    def __exit__(self, *_):
        self.close()
