"""Read-only inventory using the deployed Delphi connection and instance profile.

This module never admits work or calls the apply path. Output contains private
conversation metadata and belongs on the operator's box, not in CI artifacts.
"""
from contextlib import closing
import json
import os
import sqlite3

from . import codec


def connect_existing():
    import psycopg2
    from psycopg2.extensions import parse_dsn
    dsn = os.environ.get("DATABASE_URL", "")
    settings = parse_dsn(dsn) if dsn else {
        key: os.environ[name] for key, name in (
            ("host", "DATABASE_HOST"), ("port", "DATABASE_PORT"),
            ("dbname", "DATABASE_NAME"), ("user", "DATABASE_USER"),
            ("password", "DATABASE_PASSWORD")) if os.environ.get(name)
    }
    if not settings.get("host") or not settings.get("dbname") or not settings.get("user"):
        raise ValueError("existing database connection required")
    # Retain the deployed connection's transport settings; do not require a new
    # login or silently downgrade TLS. Explicit DSN settings take precedence.
    if "sslmode" not in settings:
        settings["sslmode"] = os.environ.get("DATABASE_SSL_MODE") or "require"
    # Enforce read-only at startup, including autocommit; discard inherited
    # session options (which could override this setting/search_path).
    settings.update(options="-c default_transaction_read_only=on -c search_path=public,pg_catalog",
                    connect_timeout=10, application_name="polis-import-dry-run")
    conn = psycopg2.connect(**settings)
    conn.set_session(readonly=True, isolation_level="REPEATABLE READ")
    return conn


def metadata(connection, zids):
    """Read display fields only for conversations actually found in the census."""
    with connection, connection.cursor() as cur:
        cur.execute("""SELECT c.zid, c.topic, left(c.description,120), c.participant_count,
            ARRAY(SELECT z.zinvite FROM zinvites z WHERE z.zid=c.zid ORDER BY z.created,z.zinvite)
            FROM conversations c WHERE c.zid = ANY(%s) ORDER BY c.zid""", (list(zids),))
        return {zid: dict(zid=zid, conversation_id=ids[0] if ids else None,
                         conversation_ids=ids, topic=topic, description=description,
                         participant_count=count) for zid, topic, description, count, ids in cur}


def counts(source=0, imported=0, archived=0, quarantined=0):
    return dict(source=source, would_import=imported, archive=archived, quarantine=quarantined)


def report(database, details, summary):
    with closing(sqlite3.connect(database)) as db:
        grouped = {}
        for zid, family, disposition, count in db.execute(
                "SELECT zid,family,disposition,count(*) FROM rows GROUP BY zid,family,disposition ORDER BY zid,family,disposition"):
            families = grouped.setdefault(zid, {f: counts() for f in sorted(codec.FAMILIES)})
            entry = families[family]
            entry[dict(imported="would_import", archived="archive", quarantined="quarantine")[disposition]] += count
            entry["source"] += count
        rows = []
        for zid, families in grouped.items():
            # Unbound/ambiguous identities are never guessed. Their bucket is
            # part of the conservation equation, including global controls.
            identity = dict(details[zid]) if zid is not None else dict(zid=None, conversation_id=None,
                conversation_ids=[], topic=None, description=None, participant_count=None)
            rows.append(dict(type="conversation" if zid is not None else "unmapped", **identity, families=families))
        grand = {family: counts(**value) for family, value in summary["counts"].items()}
        totals = {key: sum(value[key] for value in grand.values()) for key in counts()}
        for family, expected in grand.items():
            if any(sum(row["families"][family][key] for row in rows) != value for key, value in expected.items()):
                raise ValueError("report conservation failure")
        rows.append(dict(type="grand_totals", schema="polis-import-dry-run/1", mode="dry-run",
            source_sha256=summary["source_sha256"], missing_tables=summary["missing"],
            conversations=sum(row["type"] == "conversation" for row in rows),
            participant_count_source="conversations.participant_count (stored count)",
            families=grand, totals=totals))
        return rows


def encode(rows):
    # JSON lines escape control characters from user-supplied titles/descriptions.
    return "".join(json.dumps(row, sort_keys=True, ensure_ascii=True) + "\n" for row in rows).encode()
