"""One-shot cold rebuild of listed conversations under a non-served label.

The vote-sign un-flip rehearsal (P-078 PR-H) compares the engine's math for a
sample of conversations on a temporary database copy before and after the
storage flip. It needs the engine to recompute exactly those conversations
from the copy's votes and write the results under a label nothing serves.
This module is that command; the engine image installs it as
``/opt/polis-unflip/engine-rebuild``::

    engine-rebuild --label probe --zids-file zids.json [--dsn URL] [--dry]
    engine-rebuild --label probe --zids 12,34 --dsn postgresql://...

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
  ``math_main.data::text`` as Postgres renders the jsonb, the same definition
  the rehearsal's ``engine_rows`` query uses. Logs go to stderr.

Refusals (exit 3), all before anything is written: a served label (``prod``,
``python``) or a label outside ``[a-z][a-z0-9_-]{0,31}``; a ``MATH_ENV`` that
names a different label; an engine without the convention source; zids that
are not conversations on the database; and, when writing, another process
holding the label's single-writer lock (the poller's own advisory lock).
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
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger("polismath.tools.engine_rebuild")

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_REFUSED = 3
EXIT_FAILED = 4

#: Labels a reader serves or a live poller owns. Never written by this tool.
SERVED_LABELS = frozenset({"prod", "python"})
LABEL_PATTERN = re.compile(r"[a-z][a-z0-9_-]{0,31}")
#: The poller's single-writer advisory lock key prefix (scripts/math_poller.py).
LOCK_KEY_PREFIX = "polis-math-python:"

DIGEST_OF_JSON_SQL = (
    "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to("
    "cast(:data AS jsonb)::text, 'UTF8')), 'hex') AS digest")
PUBLISHED_SQL = (
    "SELECT m.math_tick, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to("
    "m.data::text, 'UTF8')), 'hex') AS digest "
    "FROM public.math_main m WHERE m.zid = :zid AND m.math_env = :label")


class Refusal(Exception):
    """A precondition that makes the run unsafe or meaningless; exit 3."""


class UsageError(Exception):
    """Bad arguments; exit 2."""


def check_label(label: str, environ: Dict[str, str]) -> str:
    if label in SERVED_LABELS or label.strip().lower() in SERVED_LABELS:
        raise Refusal(f"label {label!r} is served; this tool writes only a non-served label")
    if not LABEL_PATTERN.fullmatch(label):
        raise Refusal(f"label {label!r} is not [a-z][a-z0-9_-]{{0,31}}")
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


def run(args: argparse.Namespace, environ: Dict[str, str], out) -> int:
    label = check_label(args.label, environ)
    zids = parse_zids(args.zids, args.zids_file)
    uri = database_uri(args.dsn, environ)
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
