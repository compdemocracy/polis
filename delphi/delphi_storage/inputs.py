"""Per-run input snapshots — the capture side of P6 (design §4.2 entity 2,
§4.4).

Captures, once at job start, EXACTLY what the pipeline stages read from the
source PostgreSQL — most critically the votes as the RAW stream stage 1
consumes: ``ORDER BY created``, raw PG signs (the production math path never
flips; ``fetch_votes``'s flip is dead code), superseded votes included, order
preserved (the math KMeans init deliberately depends on vote-encounter order).
The SQL constants here are imported by ``polismath/run_math_pipeline.py`` so
capture and stage 1 can never diverge.

Snapshots are stored as ``run_inputs`` items (pk = job_id, sk = kind) using
the codec envelopes; each returns a fingerprint (sha256 of the canonical
uncompressed payload + row counts + max vote ``created``) for the P7 manifest.
"""

import base64
import hashlib
import os
from decimal import Decimal
from typing import Any, Optional

from delphi_storage.codec import canonical_json_dumps, encode_payload, decode_payload
from delphi_storage.interface import DelphiStore, Invalid, NotFound
from delphi_storage.models import StoreItem

SNAPSHOT_KINDS = (
    "votes",
    "comments",
    "participants",
    "conversation_meta",
    "report_comment_selections",
    "clojure_math_main",
)

#: Stage 1's exact vote reads (polismath/run_math_pipeline.py imports these).
VOTES_COUNT_SQL = "SELECT COUNT(*) FROM votes WHERE zid = %s"
VOTES_BATCH_SQL = (
    "SELECT v.created, v.tid, v.pid, v.vote FROM votes v "
    "WHERE v.zid = %s ORDER BY v.created LIMIT %s OFFSET %s"
)

_TABLE_QUERIES = {
    "comments": "SELECT * FROM comments WHERE zid = %s ORDER BY tid",
    "participants": "SELECT * FROM participants WHERE zid = %s ORDER BY pid",
    "conversation_meta": "SELECT * FROM conversations WHERE zid = %s",
    "report_comment_selections": (
        "SELECT * FROM report_comment_selections WHERE zid = %s ORDER BY rid, tid"
    ),
    "clojure_math_main": "SELECT * FROM math_main WHERE zid = %s ORDER BY math_env",
}


def _connect(pg_url: Optional[str]):
    """Same source-PG resolution as stage 1 (run_math_pipeline.connect_to_db)."""
    import psycopg2

    timeout = int(os.environ.get("POSTGRES_CONNECT_TIMEOUT", "30"))
    url = pg_url or os.environ.get("DATABASE_URL")
    if url:
        return psycopg2.connect(url, connect_timeout=timeout)
    return psycopg2.connect(
        host=os.environ.get("DATABASE_HOST", "localhost"),
        port=os.environ.get("DATABASE_PORT", "5432"),
        dbname=os.environ.get("DATABASE_NAME", "polis-dev"),
        user=os.environ.get("DATABASE_USER", "postgres"),
        password=os.environ.get("DATABASE_PASSWORD", ""),
        connect_timeout=timeout,
    )


def _json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        as_int = int(value)
        return as_int if value == as_int else float(value)
    if isinstance(value, (bytes, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if hasattr(value, "isoformat"):  # date/datetime columns
        return value.isoformat()
    return value


def _snapshot_payload(columns: list, rows: list) -> dict:
    return {
        "columns": columns,
        "rows": [[_json_safe(value) for value in row] for row in rows],
    }


def _write_snapshot(
    store: DelphiStore,
    job_id: str,
    kind: str,
    payload: dict,
    force: Optional[str] = None,
    extra: Optional[dict] = None,
    context: Optional[dict] = None,
) -> dict:
    sha256 = hashlib.sha256(canonical_json_dumps(payload).encode("utf-8")).hexdigest()
    encoded = encode_payload(payload, force=force)
    fingerprint = {"sha256": sha256, "row_count": len(payload["rows"])}
    if extra:
        fingerprint.update(extra)
    attributes = {**encoded.meta, "kind": kind, **fingerprint}
    if context:
        attributes.update(context)
    store.put(
        "run_inputs",
        StoreItem(pk=job_id, sk=kind, attributes=attributes, blob=encoded.blob),
    )
    return fingerprint


def capture_run_inputs(
    store: DelphiStore,
    job_id: str,
    zid: int,
    rid: Optional[int] = None,
    *,
    pg_url: Optional[str] = None,
    batch_size: int = 50000,
) -> dict:
    """Snapshot all input kinds for a run; returns per-kind fingerprints.

    ``zid`` and ``rid`` are stamped on every snapshot item's attributes for
    provenance; selections are captured for the whole conversation (what
    stage 2 reads), never filtered by ``rid``.
    """
    context = {"zid": zid, "rid": rid}
    fingerprints: dict = {}
    conn = _connect(pg_url)
    try:
        cursor = conn.cursor()
        cursor.execute(VOTES_COUNT_SQL, (zid,))
        total_votes = cursor.fetchone()[0]
        cursor.close()

        vote_rows: list = []
        for offset in range(0, max(total_votes, 1), batch_size):
            cursor = conn.cursor()
            cursor.execute(VOTES_BATCH_SQL, (zid, batch_size, offset))
            vote_rows.extend(cursor.fetchall())
            cursor.close()
        payload = _snapshot_payload(["created", "tid", "pid", "vote"], vote_rows)
        max_created = max((row[0] for row in payload["rows"]), default=None)
        fingerprints["votes"] = _write_snapshot(
            store, job_id, "votes", payload,
            force="json+zstd", extra={"max_created": max_created}, context=context,
        )

        for kind, query in _TABLE_QUERIES.items():
            cursor = conn.cursor()
            cursor.execute(query, (zid,))
            columns = [description[0] for description in cursor.description]
            rows = cursor.fetchall()
            cursor.close()
            fingerprints[kind] = _write_snapshot(
                store, job_id, kind, _snapshot_payload(columns, rows), context=context
            )
    finally:
        conn.close()
    return fingerprints


def load_run_input(store: DelphiStore, job_id: str, kind: str) -> Any:
    """Decode a snapshot payload; the read side of the P6b --input-source seam."""
    if kind not in SNAPSHOT_KINDS:
        raise Invalid(f"unknown snapshot kind {kind!r}")
    item = store.get("run_inputs", job_id, kind)
    if item is None:
        raise NotFound(f"run {job_id!r} has no {kind!r} snapshot")
    return decode_payload(item.attributes, item.blob)


INPUT_SOURCE_PREFIX = "store://"


def parse_input_source(value: str) -> str:
    """Parse an --input-source value; only ``store://<job_id>`` is supported
    (the seam the replay CLI, P12, drives)."""
    if (
        not isinstance(value, str)
        or not value.startswith(INPUT_SOURCE_PREFIX)
        or not value[len(INPUT_SOURCE_PREFIX):]
    ):
        raise Invalid(f"input source must be {INPUT_SOURCE_PREFIX}<job_id>, got {value!r}")
    return value[len(INPUT_SOURCE_PREFIX):]


class SnapshotReader:
    """Read-side twin of capture_run_inputs: stage-shaped accessors over a
    recorded snapshot. Ordering notes (all deliberate, see the P6b tests):

    - vote rows keep the captured stream order — bit-identical to what the
      live batch loop feeds stage 1;
    - stage-1 comment rows are sorted by created (stable over the snapshot's
      tid order; live SQL is ORDER BY created with NULLs last and arbitrary
      tie order — deterministic here, tie-divergent only for equal created);
    - unordered live reads (moderation rows, votes_latest_unique) get a
      deterministic tid/pid order here; their consumers are order-insensitive.
    """

    def __init__(self, store: DelphiStore, job_id: str) -> None:
        self._store = store
        self.job_id = job_id
        self._payloads: dict = {}

    def _payload(self, kind: str) -> dict:
        if kind not in self._payloads:
            self._payloads[kind] = load_run_input(self._store, self.job_id, kind)
        return self._payloads[kind]

    def zid(self) -> int:
        item = self._store.get("run_inputs", self.job_id, "votes")
        if item is None:
            raise NotFound(f"run {self.job_id!r} has no 'votes' snapshot")
        return int(item.attributes["zid"])

    def rows_as_dicts(self, kind: str) -> list:
        payload = self._payload(kind)
        return [dict(zip(payload["columns"], row)) for row in payload["rows"]]

    # ---- stage 1 (polismath/run_math_pipeline.py) ----

    def votes_rows(self) -> list:
        return [tuple(row) for row in self._payload("votes")["rows"]]

    def vote_count(self) -> int:
        return len(self._payload("votes")["rows"])

    def vote_batch(self, offset: int, limit: int) -> list:
        return self.votes_rows()[offset : offset + limit]

    def stage1_comment_rows(self) -> list:
        """Rows shaped like stage 1's DictCursor comments query (aliased
        keys), in ORDER BY created (NULLs last), values raw — so the SAME
        transformation code reproduces production behavior quirk-for-quirk."""
        rows = [
            {
                "timestamp": c.get("created"),
                "comment_id": c.get("tid"),
                "author_id": c.get("pid"),
                "moderated": c.get("mod"),
                "comment_body": c.get("txt"),
                "is_seed": c.get("is_seed"),
            }
            for c in self.rows_as_dicts("comments")
        ]
        return sorted(rows, key=lambda r: (r["timestamp"] is None, r["timestamp"] or 0))

    def stage1_moderation_rows(self) -> tuple:
        """(mod_comments rows, mod_ptpts rows) shaped like stage 1's
        moderation queries. The participants filter is applied here with the
        int comparison the live SQL does server-side (mod = '-1' coerced)."""
        mod_comments = [
            {"tid": c.get("tid"), "mod": c.get("mod"), "is_meta": c.get("is_meta")}
            for c in self.rows_as_dicts("comments")
        ]
        mod_ptpts = [
            {"pid": p.get("pid")}
            for p in self.rows_as_dicts("participants")
            if p.get("mod") == -1
        ]
        return mod_comments, mod_ptpts

    # ---- 501/801 (clojure math_main) ----

    def math_main_data(self, math_env: Optional[str] = None):
        """The Clojure math_main blob: env-less latest (501/group_data
        semantics) or filtered by math_env (801 semantics); None when absent
        — callers keep their existing no-data fallbacks."""
        import json as _json

        rows = self.rows_as_dicts("clojure_math_main")
        if math_env is not None:
            rows = [row for row in rows if row.get("math_env") == math_env]
        if not rows:
            return None
        latest = max(rows, key=lambda row: row.get("modified") or 0)
        data = latest.get("data")
        return _json.loads(data) if isinstance(data, str) else data


class SnapshotPostgresClient:
    """Duck-typed, read-only stand-in for the umap PostgresClient
    (umap_narrative/polismath_commentgraph/utils/storage.py) backed by a
    snapshot — the run_pipeline/501/801 code paths run UNCHANGED against it,
    which is what makes snapshot-vs-live parity hold by construction.
    Only the read methods those stages use are implemented."""

    def __init__(self, store: DelphiStore, job_id: str) -> None:
        self._reader = SnapshotReader(store, job_id)

    def initialize(self) -> bool:
        return True

    def shutdown(self) -> None:
        return None

    def _check_zid(self, zid) -> None:
        expected = self._reader.zid()
        if int(zid) != expected:
            raise Invalid(
                f"snapshot {self._reader.job_id!r} is for zid {expected}, "
                f"but zid {zid} was requested"
            )

    def get_conversation_by_id(self, zid):
        self._check_zid(zid)
        rows = self._reader.rows_as_dicts("conversation_meta")
        return rows[0] if rows else None

    def get_comments_by_conversation(self, zid) -> list:
        self._check_zid(zid)
        keys = ("tid", "zid", "pid", "txt", "created", "mod", "active")
        rows = [
            {key: c.get(key) for key in keys} for c in self._reader.rows_as_dicts("comments")
        ]
        return sorted(rows, key=lambda r: r["tid"])

    def get_report_comment_selections(self, zid, rid=None) -> list:
        self._check_zid(zid)
        keys = ("rid", "tid", "selection", "zid", "modified")
        rows = [
            {key: s.get(key) for key in keys}
            for s in self._reader.rows_as_dicts("report_comment_selections")
        ]
        if rid is not None:
            rows = [row for row in rows if row["rid"] == rid]
        return rows

    def get_votes_by_conversation(self, zid) -> list:
        """votes_latest_unique equivalent, derived from the raw stream, with
        the same PG-boundary sign flip the live client applies (AGREE is -1
        raw, +1 in Delphi convention: vote * -1)."""
        self._check_zid(zid)
        derived = derive_votes_latest_unique(self._payload_rows())
        return [
            {
                "zid": int(zid),
                "pid": pid,
                "tid": tid,
                "vote": (vote * -1) if vote is not None else None,
            }
            for (pid, tid), vote in sorted(derived.items())
        ]

    def _payload_rows(self) -> list:
        return self._reader.votes_rows()


def derive_votes_latest_unique(vote_rows: list) -> dict:
    """Derive the latest vote per (pid, tid) from the snapshot stream: the
    last occurrence in stream order wins.

    Faithfulness caveat (documented, not hidden): PG's RULE-maintained
    votes_latest_unique picks winners by INSERTION order, while the snapshot
    stream is ``ORDER BY created`` with no tiebreaker (the votes table has no
    serial/PK column, so none is possible without changing stage 1's read —
    which golden invariance forbids). For two votes on the same (pid, tid)
    with EQUAL ``created`` (same-millisecond double-submit), the RULE's
    winner and this derivation's winner may differ. The derivation is always
    deterministic with respect to the snapshot itself, which is what replay
    requires; the tie divergence risk is pinned by a test."""
    latest: dict = {}
    for _created, tid, pid, vote in vote_rows:
        latest[(pid, tid)] = vote
    return latest
