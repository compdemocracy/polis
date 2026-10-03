"""One-shot cold rebuild of listed conversations under a non-served label.

The vote-sign un-flip rehearsal (P-078 PR-H) compares the engine's math for a
sample of conversations on a temporary database copy before and after the
storage flip. It needs the engine to recompute exactly those conversations
from the copy's votes and write the results under a label nothing serves.
This module is that command; the engine image installs it as
``/opt/polis-unflip/engine-rebuild``::

    engine-rebuild --label probe --zids-file zids.json --i-am-a-copy [--dsn URL]
    engine-rebuild --label probe --zids 12,34 --dsn postgresql://... --dry

What it does, per conversation, in zid order:

* rebuilds the conversation cold through the poller's own first-touch path
  (``MathPollerService._load_or_init`` with the persisted row skipped, which
  is what the backfill's ``load_full_history(restore=False)`` does): the full
  vote history in engine order, the full moderation state, one recompute. No
  cache, nothing restored, no wall clock in the inputs, so the result is a
  function of the copy's rows alone;
* reads votes through the client's convention source (``PostgresClient``'s
  ``_vote_rows`` -> ``load_semantic_votes``): the storage sign comes from the
  database's own ``vote_convention`` row, read in the same statement as the
  votes, or version 0 / agree = -1 when the database has no row. A rebuild
  before the flip (raw -1, convention -1) and after it (raw +1, convention +1)
  therefore sees the same semantic votes and must publish the same blob;
* writes ``math_main``, ``math_bidtopid``, ``math_ptptstats`` and the
  ``math_ticks`` row under ``--label`` in ONE transaction, through the
  poller's ``MathWriter`` (``--dry`` computes and writes nothing);
* prints one JSON document on stdout: per zid the ``math_tick`` (``null`` when
  dry), the convention it read, and ``digest`` = sha256 of
  ``(math_main.data - 'math_tick')::text`` as Postgres renders the jsonb. The
  blob's own ``math_tick`` is wall-clock (see DIGEST_OF_JSON_SQL); the
  rehearsal's ``engine_rows`` query must use the same definition. Logs go to
  stderr.

Refusals (exit 3), all before anything is written:

* a label other than ``probe`` / ``probe-<suffix>``, and always a served one
  (``prod``, ``python``, ``python-large``, ``dev``, ``preprod``, and the values
  of ``MATH_PYTHON_ENV`` and ``MATH_CAPACITY_STAGED_LABEL``); a ``MATH_ENV``
  that names a different label;
* an engine without the convention source; zids that are not conversations
  on the database;
* when writing: no ``--i-am-a-copy`` acknowledgement; a target that is the
  database this engine is configured for (``DATABASE_URL``, else
  ``DATABASE_HOST``/``DATABASE_PORT``/``DATABASE_NAME``: on a Delphi host that
  is production); with ``--require-copy-marker``, a database whose
  ``COMMENT ON DATABASE`` is not ``polis-unflip-rehearsal-copy``; another
  process holding the label's single-writer lock (the poller's advisory lock).

``--dry`` needs none of the write guards: it only reads.
Usage errors exit 2; any failure while rebuilding or writing exits 4 after
the remaining zids have been tried (the summary says which failed).

The database: ``--dsn`` (a ``postgresql://`` URL, sslmode as the URL says),
else the libpq service named by ``PGSERVICE``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger("polismath.tools.engine_rebuild")

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_REFUSED = 3
EXIT_FAILED = 4

#: The only labels this tool writes: ``probe`` or ``probe-<suffix>``.
LABEL_PATTERN = re.compile(r"probe(-[a-z0-9_-]{1,26})?")
#: Labels a reader serves, a poller owns or a stage promotes from. Refused even
#: if the allowlist ever widens; the values of the environment variables in
#: SERVED_LABEL_ENVS are refused too.
SERVED_LABELS = frozenset({"prod", "python", "python-large", "dev", "preprod"})
SERVED_LABEL_ENVS = ("MATH_PYTHON_ENV", "MATH_CAPACITY_STAGED_LABEL")
#: ``COMMENT ON DATABASE`` text that marks a rehearsal copy (--require-copy-marker).
COPY_MARKER = "polis-unflip-rehearsal-copy"
#: The poller's single-writer advisory lock key prefix (scripts/math_poller.py).
LOCK_KEY_PREFIX = "polis-math-python:"

#: The digest leaves out the blob's top-level ``math_tick``: ``Conversation.to_dict``
#: sets it from the wall clock (25000 + time % 10000), and the server overwrites
#: it with the column (server/src/utils/pca.ts). Everything else in the blob is
#: a function of the database rows on the cold path.
DIGEST_OF_JSON_SQL = (
    "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to("
    "(cast(:data AS jsonb) - 'math_tick')::text, 'UTF8')), 'hex') AS digest")
PUBLISHED_SQL = (
    "SELECT m.math_tick, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to("
    "(m.data - 'math_tick')::text, 'UTF8')), 'hex') AS digest "
    "FROM public.math_main m WHERE m.zid = :zid AND m.math_env = :label")


class Refusal(Exception):
    """A precondition that makes the run unsafe or meaningless; exit 3."""


class UsageError(Exception):
    """Bad arguments; exit 2."""


def check_label(label: str, environ: Dict[str, str]) -> str:
    served = set(SERVED_LABELS)
    served.update(v.strip() for k in SERVED_LABEL_ENVS if (v := environ.get(k) or "").strip())
    if label in served or label.strip().lower() in served:
        raise Refusal(f"label {label!r} is served; this tool writes only a non-served label")
    if not LABEL_PATTERN.fullmatch(label):
        raise Refusal(f"label {label!r} is not 'probe' or 'probe-<suffix>'")
    env_label = environ.get("MATH_ENV")
    if env_label is not None and env_label != label:
        raise Refusal(f"MATH_ENV={env_label!r} names a different label than --label {label!r}")
    return label


def _parse_zid(token: Any) -> int:
    if isinstance(token, bool):
        raise UsageError(f"not a zid: {token!r}")
    if isinstance(token, int):
        zid = token
    elif isinstance(token, str) and re.fullmatch(r"[0-9]+", token.strip()):
        zid = int(token.strip())
    else:
        raise UsageError(f"not a zid: {token!r}")
    if zid <= 0:
        raise UsageError(f"not a zid: {token!r}")
    return zid


def parse_zids(lists: Sequence[str], files: Sequence[str]) -> List[int]:
    """Zids from ``--zids`` (comma or space separated) and ``--zids-file``
    (a JSON list, or whitespace/comma separated integers). Sorted, distinct."""
    tokens: List[Any] = []
    for item in lists:
        tokens.extend(t for t in re.split(r"[,\s]+", item) if t)
    for path in files:
        try:
            with open(path, encoding="utf-8") as f:
                body = f.read()
        except OSError as exc:
            raise UsageError(f"cannot read --zids-file {path!r}: {exc.strerror}") from None
        stripped = body.strip()
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except ValueError:
                raise UsageError(f"--zids-file {path!r} is not a JSON list") from None
            if not isinstance(parsed, list):
                raise UsageError(f"--zids-file {path!r} is not a JSON list")
            tokens.extend(parsed)
        else:
            tokens.extend(t for t in re.split(r"[,\s]+", stripped) if t)
    zids = sorted({_parse_zid(t) for t in tokens})
    if not zids:
        raise UsageError("no zids given (--zids or --zids-file)")
    return zids


def database_uri(dsn: Optional[str], environ: Dict[str, str]) -> str:
    if dsn:
        if dsn.startswith("postgres://"):
            dsn = "postgresql://" + dsn[len("postgres://"):]
        if not dsn.startswith("postgresql://"):
            raise UsageError("--dsn must be a postgresql:// URL")
        return dsn
    service = environ.get("PGSERVICE")
    if service:
        return "postgresql:///?service=" + service
    raise UsageError("no database: pass --dsn or set PGSERVICE")


def require_convention_source() -> None:
    """The rebuild is only meaningful when votes are read through the
    database's convention (P-078 PR-C). An engine without it reads every
    database at agree = -1 and would publish a different blob after the flip."""
    from polismath.utils import vote_convention

    if not hasattr(vote_convention, "load_semantic_votes"):
        raise Refusal("this engine predates the vote convention source (P-078 PR-C); "
                      "its rebuilds would not be comparable across the flip")


def _client(uri: str, label: str):
    from polismath.database.postgres import PostgresClient, PostgresConfig

    class _UriConfig(PostgresConfig):
        def get_uri(self) -> str:
            return uri

    config = _UriConfig(math_env=label, pool_size=2, max_overflow=0)
    config.math_env = label
    return PostgresClient(config)


def _service(pg: Any, label: str):
    from polismath.poller.admission import MemoryAdmission
    from polismath.poller.capacity import CapacityRouter, CapacitySettings
    from polismath.poller.service import MathPollerService, PollerConfig, _BackfillHost

    config = PollerConfig(math_env=label, worker_pool_size=1)
    admission = MemoryAdmission.from_config(config)
    svc = MathPollerService(pg, config, admission=admission,
                            capacity=CapacityRouter(admission, CapacitySettings()))
    return svc, _BackfillHost(svc)


class _Capture:
    """A publisher for the writer's dry path: keeps the three encoded blobs."""

    def __init__(self) -> None:
        self.main_json: Optional[str] = None

    def stage(self, _name: str) -> None:
        pass

    def publish(self, zid: int, main_json: str, bidtopid_json: str, ptptstats_json: str) -> int:
        self.main_json = main_json
        return -1


def _convention(pg: Any) -> Optional[Dict[str, Any]]:
    source = getattr(pg, "convention_source", None)
    if source is None:
        return None
    c = source.current()
    return {"version": c.version, "agree_value": c.agree_value, "origin": c.origin}


def rebuild_one(pg: Any, svc: Any, host: Any, zid: int, label: str, dry: bool) -> Dict[str, Any]:
    from polismath.poller.math_writer import MathWriter

    begin = getattr(pg, "begin_convention_cycle", None)
    if begin is not None:
        begin()
    conv = host.load_full_history(zid, restore=False)
    convention = _convention(pg)
    if dry:
        capture = _Capture()
        MathWriter(pg, publisher=capture).write_conv_updates(zid, conv)
        digest = pg.query(DIGEST_OF_JSON_SQL, {"data": capture.main_json})[0]["digest"]
        return {"zid": zid, "math_tick": None, "digest": digest, "convention": convention}
    tick = svc._writer.write_conv_updates(zid, conv)
    rows = pg.query(PUBLISHED_SQL, {"zid": zid, "label": label})
    if len(rows) != 1 or rows[0]["math_tick"] != tick:
        raise RuntimeError(f"zid {zid}: published row does not carry math_tick {tick}")
    return {"zid": zid, "math_tick": tick, "digest": rows[0]["digest"], "convention": convention}


def configured_database(environ: Dict[str, str]) -> Optional[Tuple[str, int, str]]:
    """(host, port, dbname) of the database this engine is configured for, if any."""
    from urllib.parse import urlparse

    url = environ.get("DATABASE_URL")
    if url:
        u = urlparse(url)
        if not u.hostname:
            return None
        return u.hostname.lower(), u.port or 5432, u.path.lstrip("/")
    host = environ.get("DATABASE_HOST")
    if not host:
        return None
    return (host.lower(), int(environ.get("DATABASE_PORT") or 5432),
            environ.get("DATABASE_NAME") or "polis")


def check_copy(lock_conn: Any, environ: Dict[str, str], require_marker: bool) -> None:
    """The write guards against a production database (see the module doc)."""
    info = lock_conn.connection.dbapi_connection.info
    target = ((info.host or "").lower(), int(info.port), info.dbname)
    configured = configured_database(environ)
    if configured is not None and configured == target:
        raise Refusal("the target is the database this engine is configured for "
                      "(DATABASE_URL / DATABASE_HOST); writes go only to a copy")
    if require_marker:
        from sqlalchemy import text

        marker = lock_conn.execute(text(
            "SELECT pg_catalog.shobj_description(d.oid, 'pg_database') FROM pg_catalog.pg_database d "
            "WHERE d.datname = pg_catalog.current_database()")).scalar()
        lock_conn.commit()
        if marker != COPY_MARKER:
            raise Refusal(f"the database does not carry the copy marker {COPY_MARKER!r}")


def run(args: argparse.Namespace, environ: Dict[str, str], out) -> int:
    label = check_label(args.label, environ)
    zids = parse_zids(args.zids, args.zids_file)
    uri = database_uri(args.dsn, environ)
    if not args.dry and not args.i_am_a_copy:
        raise Refusal("writing needs --i-am-a-copy (the target must be a rehearsal copy); "
                      "--dry needs nothing")
    require_convention_source()

    pg = _client(uri, label)
    lock_conn = None
    try:
        known = {r["zid"] for r in pg.query(
            "SELECT zid FROM public.conversations WHERE zid = ANY(:zids)", {"zids": zids})}
        missing = [z for z in zids if z not in known]
        if missing:
            raise Refusal(f"not conversations on this database: {missing}")
        if not args.dry:
            from sqlalchemy import text

            lock_conn = pg.engine.connect()
            check_copy(lock_conn, environ, args.require_copy_marker)
            got = lock_conn.execute(text("SELECT pg_try_advisory_lock(hashtext(:k))"),
                                    {"k": LOCK_KEY_PREFIX + label}).scalar()
            lock_conn.commit()
            if not got:
                raise Refusal(f"another process holds the single-writer lock for label {label!r}")
        svc, host = _service(pg, label)
        results: List[Dict[str, Any]] = []
        failed = 0
        for zid in zids:
            try:
                results.append(rebuild_one(pg, svc, host, zid, label, args.dry))
            except Exception as exc:  # noqa: BLE001 - reported, then exit 4
                logger.exception("rebuild failed for zid=%s", zid)
                failed += 1
                results.append({"zid": zid, "error": exc.__class__.__name__})
        summary = {"label": label, "dry": bool(args.dry), "ok": failed == 0,
                   "results": results}
        out.write(json.dumps(summary, sort_keys=True) + "\n")
        out.flush()
        return EXIT_OK if failed == 0 else EXIT_FAILED
    finally:
        if lock_conn is not None:
            lock_conn.close()
        pg.shutdown()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="engine-rebuild",
        description="Cold-rebuild listed conversations under a non-served math label.")
    p.add_argument("--zids", action="append", default=[],
                   help="zids, comma or space separated (repeatable)")
    p.add_argument("--zids-file", action="append", default=[],
                   help="file with a JSON list of zids, or whitespace-separated zids")
    p.add_argument("--label", required=True,
                   help="math_env label to write; never a served label (prod, python)")
    p.add_argument("--dsn", default=None,
                   help="postgresql:// URL of the database copy (default: PGSERVICE)")
    p.add_argument("--dry", action="store_true",
                   help="compute and print digests; write nothing")
    p.add_argument("--i-am-a-copy", action="store_true",
                   help="required to write: the target is a rehearsal copy, never production")
    p.add_argument("--require-copy-marker", action="store_true",
                   help=f"also require COMMENT ON DATABASE = {COPY_MARKER!r} before writing")
    return p


def main(argv: Optional[Sequence[str]] = None, environ: Optional[Dict[str, str]] = None,
         out=None) -> int:
    environ = dict(os.environ if environ is None else environ)
    out = out or sys.stdout
    logging.basicConfig(stream=sys.stderr,
                        level=environ.get("ENGINE_REBUILD_LOG_LEVEL", "WARNING").upper())
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return EXIT_OK if exc.code == 0 else EXIT_USAGE
    try:
        return run(args, environ, out)
    except UsageError as exc:
        sys.stderr.write(f"engine-rebuild: usage: {exc}\n")
        return EXIT_USAGE
    except Refusal as exc:
        sys.stderr.write(f"engine-rebuild: refused: {exc}\n")
        return EXIT_REFUSED
    except Exception as exc:  # noqa: BLE001 - any other failure is exit 4
        logger.exception("engine-rebuild failed")
        sys.stderr.write(f"engine-rebuild: failed: {exc.__class__.__name__}\n")
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
