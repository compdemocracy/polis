"""Served-math capture: the optional extraction of what Clojure actually SERVED.

P-052 section 4.5. The fixture bundle already captures a conversation's
*inputs* (votes with millisecond timestamps, comments, moderation state,
participants). It did not capture the *output* the production engine published
— the ``math_main`` row per ``math_env`` (blob, ``last_vote_timestamp``,
``math_tick``, ``caching_tick``, ``modified``) and the ``math_ticks`` row — and
without that there is nothing for an off-policy fidelity comparison to be
scored against.

This module covers the extraction change, which is READ ONLY: two additional
``SELECT``s against tables that already exist. No migration, no new column, no
trigger.

EVERYTHING here is synthetic. The votes, comments, participants, blobs and
tick counters below were invented for this file; no production identifier,
conversation or blob appears anywhere in it.

THE BYTE-IDENTITY PROOF. The feature is OFF by default and the shipped
selection config does not carry the block at all, so:

* ``certify_datasets.json`` keeps the exact bytes it had before this feature
  existed — pinned as :data:`SHIPPED_CONFIG_SHA256`, which is the value every
  existing manifest recorded in ``commits.config_sha256``;
* an extraction with the option off writes exactly the five files it wrote
  before, with exactly the bytes it wrote before — pinned as
  :data:`BASELINE_FILE_SHA256`, computed by running the pre-change extractor on
  the synthetic conversation below;
* the manifest built from such an extraction is byte-for-byte the manifest the
  pre-change code built — pinned as :data:`BASELINE_MANIFEST_SHA256`.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Sequence

import pytest

from polismath.replay import fixture_config as fc
from polismath.replay import fixture_extract as fx
from polismath.replay import real_data as rd

# ---------------------------------------------------------------------------
# Synthetic conversation.
# ---------------------------------------------------------------------------

BASE_MS = 1_600_000_000_000

#: (pid, tid, vote, weight_x_32767, created), in the frozen extract order the
#: real query would return them in. Raw STORAGE signs (-1 = agree).
SYNTH_VOTES: list[dict[str, Any]] = [
    {"pid": 1, "tid": 0, "vote": -1, "weight_x_32767": 0, "created": BASE_MS + 100},
    {"pid": 2, "tid": 0, "vote": 1, "weight_x_32767": 0, "created": BASE_MS + 200},
    {"pid": 1, "tid": 1, "vote": 0, "weight_x_32767": 0, "created": BASE_MS + 300},
    {"pid": 2, "tid": 1, "vote": -1, "weight_x_32767": 0, "created": BASE_MS + 400},
    # a revote on an already-voted cell — the history production kept
    {"pid": 1, "tid": 0, "vote": 1, "weight_x_32767": 0, "created": BASE_MS + 500},
    {"pid": 3, "tid": 2, "vote": -1, "weight_x_32767": 0, "created": BASE_MS + 600},
]

SYNTH_COMMENTS: list[dict[str, Any]] = [
    {"tid": 0, "pid": 1, "created": BASE_MS, "modified": BASE_MS,
     "mod": 0, "is_meta": False},
    {"tid": 1, "pid": 2, "created": BASE_MS + 1, "modified": BASE_MS + 1,
     "mod": 0, "is_meta": False},
    {"tid": 2, "pid": 3, "created": BASE_MS + 2, "modified": BASE_MS + 2,
     "mod": -1, "is_meta": True},
]

SYNTH_PARTICIPANTS: list[dict[str, Any]] = [
    {"pid": 1, "mod": 0, "created": BASE_MS},
    {"pid": 2, "mod": 0, "created": BASE_MS + 1},
    {"pid": 3, "mod": -1, "created": BASE_MS + 2},
]

#: The served blob, as ``data::text`` would hand it back: a jsonb rendering
#: with Postgres' own key order and spacing, NOT a Python re-serialisation.
#: The watermark is the FOURTH vote's timestamp, so two later votes arrived
#: after the last publish — the ordinary production situation.
SERVED_BLOB_PROD_TEXT = (
    '{"n": 3, "pca": {"center": [0.1, -0.2], "comps": [[1.0, 0.0], [0.0, 1.0]]}, '
    '"tids": [0, 1, 2], "zid": 424242, "n-cmts": 3, '
    '"lastVoteTimestamp": 1600000000400, "comment-priorities": {"0": 49, "1": 49}}'
)

#: A second environment, one publish behind, to prove every ``math_env``
#: present is captured rather than an arbitrary one.
SERVED_BLOB_PREPROD_TEXT = (
    '{"n": 2, "tids": [0, 1], "zid": 424242, "n-cmts": 2, '
    '"lastVoteTimestamp": 1600000000200}'
)

SYNTH_MATH_MAIN: list[dict[str, Any]] = [
    {"math_env": "preprod", "data_text": SERVED_BLOB_PREPROD_TEXT,
     "last_vote_timestamp": BASE_MS + 200, "caching_tick": 3, "math_tick": 4,
     "modified": BASE_MS + 250},
    {"math_env": "prod", "data_text": SERVED_BLOB_PROD_TEXT,
     "last_vote_timestamp": BASE_MS + 400, "caching_tick": 11, "math_tick": 7,
     "modified": BASE_MS + 450},
]

SYNTH_MATH_TICKS: list[dict[str, Any]] = [
    {"math_env": "preprod", "math_tick": 4, "caching_tick": 3,
     "modified": BASE_MS + 250},
    {"math_env": "prod", "math_tick": 7, "caching_tick": 11,
     "modified": BASE_MS + 450},
]

TIE_KEY: dict[str, Any] = {
    "available": False,
    "columns": [],
    "method": "physical-ctid",
    "order_by": "created ASC, ctid ASC",
    "guarantee": "frozen-extract-order",
    "note": "synthetic fixture: votes has no portable event identity, so the "
            "extract order is frozen into the bundle bytes.",
}

DIR_NAME = "0123456789abcdef-pc-v1-synthetic"


# ---------------------------------------------------------------------------
# A fake connection that dispatches on the SQL, not on call order.
# ---------------------------------------------------------------------------


class _FakeCursor:
    """Answers whichever table the executed statement selects FROM.

    Dispatching on the SQL rather than on a fixed result queue keeps the fake
    honest when the extractor runs three queries (capture off) or five
    (capture on), and makes an unexpected statement a loud failure instead of
    a silently mismatched result set.
    """

    _TABLES = ("votes", "comments", "participants", "math_main", "math_ticks")

    def __init__(self, rows_by_table: dict[str, list[dict[str, Any]]]) -> None:
        self._rows_by_table = rows_by_table
        self.statements: list[str] = []
        self.params: list[Any] = []
        self._current: list[dict[str, Any]] = []
        self.description: list[tuple[str]] | None = None

    def execute(self, sql: str, params: Any = None) -> None:
        self.statements.append(sql)
        self.params.append(params)
        table = next(
            (t for t in self._TABLES if f"FROM {t}\n" in sql or sql.rstrip().endswith(f"FROM {t}")),
            None,
        )
        if table is None:
            raise AssertionError(f"fake cursor got an unexpected statement:\n{sql}")
        self._current = self._rows_by_table.get(table, [])
        columns = _selected_columns(sql)
        self.description = [(c,) for c in columns]
        self._current = [
            {c: row[c] for c in columns} for row in self._current
        ]

    def fetchall(self) -> list[tuple[Any, ...]]:
        assert self.description is not None
        return [tuple(row[c[0]] for c in self.description) for row in self._current]

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def _selected_columns(sql: str) -> list[str]:
    """The column names the extractor's own SELECT list asks for.

    The fake returns exactly those, in that order, so a test cannot pass by
    accident on a column the production query does not select.
    """
    select = sql[sql.index("SELECT") + len("SELECT"):sql.index("FROM")]
    names: list[str] = []
    for part in select.split(","):
        token = part.strip().split()[-1]
        names.append(token)
    return names


class _FakeConn:
    def __init__(self, *, math_main: Sequence[dict[str, Any]] | None = None,
                 math_ticks: Sequence[dict[str, Any]] | None = None) -> None:
        self.cursors: list[_FakeCursor] = []
        self._rows = {
            "votes": [dict(r) for r in SYNTH_VOTES],
            "comments": [dict(r) for r in SYNTH_COMMENTS],
            "participants": [dict(r) for r in SYNTH_PARTICIPANTS],
            "math_main": [dict(r) for r in (SYNTH_MATH_MAIN if math_main is None
                                            else math_main)],
            "math_ticks": [dict(r) for r in (SYNTH_MATH_TICKS if math_ticks is None
                                             else math_ticks)],
        }

    def cursor(self) -> _FakeCursor:
        cur = _FakeCursor(self._rows)
        self.cursors.append(cur)
        return cur


# ---------------------------------------------------------------------------
# Extraction helper.
# ---------------------------------------------------------------------------


def _extract(tmp_path: Path, **kwargs: Any) -> tuple[Path, dict[str, Any], _FakeConn]:
    """Run ``extract_conversation`` into a guarded ``.local`` payload root."""
    root = tmp_path / "real_data"
    payload = root / ".local" / "payload"
    payload.mkdir(parents=True)
    conn = _FakeConn(math_main=kwargs.pop("math_main", None),
                     math_ticks=kwargs.pop("math_ticks", None))
    summary = fx.extract_conversation(
        conn, zid=424242, slug="pc-v1-synthetic", role="synthetic-role",
        payload_root=payload, guard_root=root, dir_name=DIR_NAME,
        tie_key=TIE_KEY, **kwargs,
    )
    return payload / DIR_NAME, summary, conn


def _file_digests(directory: Path) -> dict[str, str]:
    return {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(directory.rglob("*")) if p.is_file()
    }


# ---------------------------------------------------------------------------
# Baseline pins — the bytes the PRE-CHANGE extractor produced.
# ---------------------------------------------------------------------------

#: SHA-256 of ``delphi/scripts/certify_datasets.json``. Served-math capture is
#: declared by an OPTIONAL block that the shipped config does not carry, so
#: this digest — which every published manifest records as
#: ``commits.config_sha256`` — is unchanged by the feature. Adding the block to
#: the shipped config is a reviewed edit that mints a new bundle version, which
#: is exactly the intended cost.
SHIPPED_CONFIG_SHA256 = (
    "37a637e3d273990265f990259f4306dc78d41e23e02742584acd0274e81db396")

#: The five payload files an extraction wrote before served-math capture
#: existed, and their exact bytes, for the synthetic conversation above.
BASELINE_FILE_SHA256: dict[str, str] = {
    "0123456789abcdef-pc-v1-synthetic-comments.csv":
        "2aa2fc4757f2e6beb2f2e4df138d76745eba3263b0f5d05f082bf563b38d5b79",
    "0123456789abcdef-pc-v1-synthetic-votes.csv":
        "20c7b05940afd15440be109c785194b8dca1e4c32a05f6ff06dfcd85f4702917",
    "events.jsonl":
        "d3b936b7ddcde200493fab3c0f376390310fe7ff27524bf3391255af2d9c2fe1",
    "events.meta.json":
        "02372a06ebe67c81360cc13a26e79152ec789755556c032e340cea62d337ede3",
    "participants.csv":
        "f164d7404eba122bdf9b44b4ffe4d0c089b70c8feded352e5d8657abe49c411e",
}

#: ``root_digest`` over those five files, and the sha256 of the canonical
#: manifest built from the resulting role summary with ``created_at`` (a
#: wall-clock stamp, and the only non-deterministic field) removed.
BASELINE_ROOT_DIGEST = (
    "f79b6ef07a79155cd974f84dc4874d61aca96b8b23a8858a4cdc2b187611892b")
BASELINE_MANIFEST_SHA256 = (
    "00cbfb2829bcbe5f71198455f1cdb1541e7821effa949aa1d9173a8b88153491")

#: A minimal, self-contained selection config for the manifest pins. The
#: shipped config selects on production scale and would need a production-scale
#: seed; what is under test here is the manifest bytes, not the rule set.
BASELINE_CONFIG: dict[str, Any] = {
    "schema_version": "certify-datasets/1",
    "config_version": "synthetic-v1",
    "metrics": {"V": {"definition": "vote events"}, "zid": {"definition": "id"}},
    "roles": [{
        "slug": "pc-v1-synthetic", "role": "synthetic-role", "group": "replacement",
        "rank": 1, "on_missing": "fail",
        "exercise": "the served-math capture, on a synthetic conversation",
        "predicates": [{"metric": "V", "op": "ge", "value": 1}],
        "order_by": [{"metric": "V", "direction": "desc"},
                     {"metric": "zid", "direction": "asc"}],
    }],
    "workloads": [],
    "generated": {
        "generator_id": "gen-v1", "generator_version": "1", "seed": 7,
        "cases": [{"id": "gen-v1-empty", "boundary": "no votes at all",
                   "participants": 0, "comments": 0, "shape": "empty"}],
    },
}


def _role_entry(summary: dict[str, Any]) -> dict[str, Any]:
    """The role summary as ``extract_from_config`` would hand it to the
    manifest builder, minus the wall-clock extraction stamp."""
    entry = dict(summary)
    entry.update({"group": "replacement", "rank": 1, "source": "production",
                  "n_candidates": 1, "overlaps_with": [],
                  "measured_metrics": {"V": 6}})
    entry.pop("extracted_at", None)
    return entry


def _build_manifest(payload_root: Path, summary: dict[str, Any]) -> dict[str, Any]:
    from polismath.replay import fixture_bundle as fb

    return fb.build_manifest(
        bundle_id="synthetic-0001", payload_root=payload_root,
        config=BASELINE_CONFIG, config_bytes=fb.canonical_json(BASELINE_CONFIG),
        selections=[_role_entry(summary)], generated_summaries=[],
        snapshot={"identifier": "snap", "created_at": "2026-01-01T00:00:00Z",
                  "schema_migration_version": "000018"},
        transaction_guarantee={"isolation_level": "repeatable read",
                               "access_mode": "read only",
                               "single_transaction": True},
        tie_key=TIE_KEY,
        schedules=[{"path": "s.json", "schedule_id": "s", "sha256": "0" * 64,
                    "n_cuts": 2, "expected_checkpoints": 2,
                    "cuts_resolvable_without_dataset": True}],
        owner="polis-certification", extraction_commit="1" * 40,
        source_commit="1" * 40, coverage_report={},
    )


def _manifest_fingerprint(manifest: dict[str, Any]) -> str:
    """SHA-256 of the canonical manifest with ``created_at`` removed — the one
    field that is a wall clock and cannot be pinned."""
    from polismath.replay import fixture_bundle as fb

    return hashlib.sha256(fb.canonical_json(
        {k: v for k, v in manifest.items() if k != "created_at"})).hexdigest()


# ---------------------------------------------------------------------------
# The option is off by default, and off means byte-identical.
# ---------------------------------------------------------------------------


def test_the_shipped_config_does_not_declare_the_capture():
    """The block is OPTIONAL and absent. That absence is what keeps
    ``certify_datasets.json`` byte-identical, and therefore keeps
    ``commits.config_sha256`` unchanged in every manifest ever published."""
    raw = fc.DEFAULT_CONFIG_PATH.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == SHIPPED_CONFIG_SHA256
    assert "served_math" not in json.loads(raw)
    assert fc.served_math_options(fc.load_config()) == fc.SERVED_MATH_OFF
    assert fc.SERVED_MATH_OFF.capture is False


def test_an_absent_block_and_an_explicit_false_both_mean_off():
    assert fc.served_math_options({}).capture is False
    assert fc.served_math_options({"served_math": {"capture": False}}).capture is False
    opts = fc.served_math_options({"served_math": {"capture": True}})
    assert opts.capture is True and opts.math_envs is None
    opts = fc.served_math_options(
        {"served_math": {"capture": True, "math_envs": ["prod"]}})
    assert opts.math_envs == ("prod",)


def test_extraction_with_the_capture_off_writes_the_pre_change_bytes(tmp_path):
    """THE BYTE-IDENTITY PROOF, file by file.

    The digests on the right were produced by running the extractor as it stood
    BEFORE served-math capture existed, on the synthetic conversation above. An
    extraction with the option off must reproduce them exactly: same file set,
    same bytes, same ``root_digest``.
    """
    from polismath.replay import fixture_bundle as fb

    directory, summary, conn = _extract(tmp_path)
    assert _file_digests(directory) == BASELINE_FILE_SHA256
    assert fb.root_digest(fb.scan_files(directory.parent)) == BASELINE_ROOT_DIGEST
    # No served_math key at all: an absent key and a `captured: false` block are
    # different claims, and only the absent key leaves the manifest untouched.
    assert "served_math" not in summary
    # And the two extra SELECTs were never issued.
    statements = [s for cur in conn.cursors for s in cur.statements]
    assert not [s for s in statements if "math_main" in s or "math_ticks" in s]


def test_the_manifest_built_from_a_capture_off_extraction_is_unchanged(tmp_path):
    directory, summary, _ = _extract(tmp_path)
    manifest = _build_manifest(directory.parent, summary)
    assert _manifest_fingerprint(manifest) == BASELINE_MANIFEST_SHA256
    assert manifest["root_digest"] == BASELINE_ROOT_DIGEST
    assert len(manifest["redactions"]) == 5
    assert not any("served" in line for line in manifest["redactions"])


# ---------------------------------------------------------------------------
# The capture itself.
# ---------------------------------------------------------------------------


@pytest.fixture()
def captured(tmp_path):
    return _extract(tmp_path, capture_served_math=True)


def test_the_queries_read_only_and_never_select_a_zid(captured):
    """An extraction change, not a schema change: two SELECTs, no writes, and
    no zid column in either of them."""
    _, _, conn = captured
    statements = [s for cur in conn.cursors for s in cur.statements]
    served = [s for s in statements if "math_main" in s or "math_ticks" in s]
    assert len(served) == 2
    for sql in served:
        assert sql.strip().upper().startswith("SELECT")
        for forbidden in ("INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP"):
            assert forbidden not in sql.upper(), sql
        select_list = sql[sql.index("SELECT"):sql.index("FROM")]
        assert "zid" not in select_list
        # The zid is the bound parameter, never interpolated.
        assert "WHERE zid = %s" in sql
    assert fx.sql_math_main_rows().count("data::text") == 1, (
        "the blob must be selected as text so it is captured verbatim")


def test_every_math_env_present_is_captured(captured):
    directory, summary, _ = captured
    meta = json.loads((directory / "served_math.json").read_text())
    assert meta["schema_version"] == fx.SERVED_MATH_SCHEMA_VERSION
    assert meta["captured"] is True
    assert meta["math_envs_present"] == ["preprod", "prod"]
    assert meta["math_envs_captured"] == ["preprod", "prod"]
    assert meta["requested_math_envs"] is None
    assert [t["math_env"] for t in meta["math_ticks"]] == ["preprod", "prod"]
    assert summary["served_math"]["math_envs"] == ["preprod", "prod"]
    assert summary["served_math"]["math_main_rows"] == 2
    assert summary["served_math"]["math_ticks_rows"] == 2


def test_the_row_scalars_are_carried_verbatim(captured):
    directory, _, _ = captured
    meta = json.loads((directory / "served_math.json").read_text())
    prod = next(e for e in meta["math_main"] if e["math_env"] == "prod")
    assert prod["last_vote_timestamp"] == BASE_MS + 400
    assert prod["math_tick"] == 7
    assert prod["caching_tick"] == 11
    assert prod["modified"] == BASE_MS + 450
    ticks = next(t for t in meta["math_ticks"] if t["math_env"] == "prod")
    assert ticks == {"math_env": "prod", "math_tick": 7, "caching_tick": 11,
                     "modified": BASE_MS + 450}
    # No zid anywhere in the metadata document.
    assert "zid" not in json.dumps(meta["math_main"] + meta["math_ticks"])


def test_the_blob_file_is_the_served_bytes_and_nothing_else(captured):
    directory, summary, _ = captured
    meta = json.loads((directory / "served_math.json").read_text())
    prod = next(e for e in meta["math_main"] if e["math_env"] == "prod")
    raw = (directory / prod["blob_file"]).read_bytes()
    # Verbatim: the exact `data::text` string, no trailing newline, no
    # re-indentation, no key reordering by a Python json round-trip.
    assert raw == SERVED_BLOB_PROD_TEXT.encode("utf-8")
    assert not raw.endswith(b"\n")
    assert hashlib.sha256(raw).hexdigest() == prod["blob_sha256"]
    assert len(raw) == prod["blob_bytes"]
    blob_entry = next(b for b in summary["served_math"]["blobs"]
                      if b["math_env"] == "prod")
    assert blob_entry["sha256"] == prod["blob_sha256"]
    assert blob_entry["file"] == prod["blob_file"] == "served-math-001.blob.json"


def test_blob_files_are_named_by_index_never_by_math_env(tmp_path):
    """``math_env`` is a free VARCHAR(999) in the production schema, so a value
    carrying a separator would otherwise choose the path."""
    hostile = [dict(SYNTH_MATH_MAIN[1], math_env="../../escape")]
    directory, summary, _ = _extract(
        tmp_path, capture_served_math=True, math_main=hostile, math_ticks=[])
    files = {p.name for p in directory.iterdir()}
    assert "served-math-000.blob.json" in files
    assert not any(".." in name for name in files)
    assert summary["served_math"]["math_envs"] == ["../../escape"]


def test_the_watermark_diagnostic_locates_the_prefix_the_blob_saw(captured):
    """``prod`` published at the fourth vote, so the last two votes arrived
    after it — the ordinary production case, reported and never failed."""
    directory, _, _ = captured
    consistency = json.loads(
        (directory / "served_math.json").read_text())["consistency"]
    assert consistency["gate"] is False and consistency["kind"] == "diagnostic"
    assert consistency["vote_events"] == 6
    assert consistency["max_vote_created_ms"] == BASE_MS + 600
    prod = next(e for e in consistency["per_math_env"] if e["math_env"] == "prod")
    assert prod["verdict"] == "votes-arrived-after-the-served-watermark"
    assert prod["votes_at_or_before_watermark"] == 4
    assert prod["votes_after_watermark"] == 2
    assert prod["watermark_minus_max_vote_ms"] == -200
    assert prod["watermark_is_a_vote_timestamp"] is True
    # The column and the blob's own lastVoteTimestamp agree, as production
    # writes the column FROM the blob.
    assert prod["column_matches_blob"] is True
    assert prod["blob_last_vote_timestamp"] == BASE_MS + 400


def test_a_watermark_matching_the_last_vote_reads_consistent(tmp_path):
    rows = [dict(SYNTH_MATH_MAIN[1], last_vote_timestamp=BASE_MS + 600,
                 data_text='{"lastVoteTimestamp": 1600000000600}')]
    directory, _, _ = _extract(tmp_path, capture_served_math=True,
                               math_main=rows, math_ticks=[])
    consistency = json.loads(
        (directory / "served_math.json").read_text())["consistency"]
    entry = consistency["per_math_env"][0]
    assert entry["verdict"] == "consistent"
    assert entry["votes_after_watermark"] == 0
    assert entry["watermark_minus_max_vote_ms"] == 0


def test_a_watermark_past_every_extracted_vote_is_called_out(tmp_path):
    """The one shape that means the served row and the extracted votes came
    from different states. Still a diagnostic — but a named one."""
    rows = [dict(SYNTH_MATH_MAIN[1], last_vote_timestamp=BASE_MS + 9_000,
                 data_text='{"lastVoteTimestamp": 1600000009000}')]
    directory, _, _ = _extract(tmp_path, capture_served_math=True,
                               math_main=rows, math_ticks=[])
    consistency = json.loads(
        (directory / "served_math.json").read_text())["consistency"]
    entry = consistency["per_math_env"][0]
    assert entry["verdict"] == "watermark-ahead-of-every-extracted-vote"
    assert entry["votes_after_watermark"] == 0
    assert entry["watermark_minus_max_vote_ms"] == 8_400
    assert entry["watermark_is_a_vote_timestamp"] is False
    assert consistency["gate"] is False


def test_a_column_and_blob_watermark_disagreement_is_reported(tmp_path):
    rows = [dict(SYNTH_MATH_MAIN[1], last_vote_timestamp=BASE_MS + 300,
                 data_text='{"lastVoteTimestamp": 1600000000400}')]
    directory, _, _ = _extract(tmp_path, capture_served_math=True,
                               math_main=rows, math_ticks=[])
    entry = json.loads((directory / "served_math.json").read_text())[
        "consistency"]["per_math_env"][0]
    assert entry["column_matches_blob"] is False


def test_an_unreadable_blob_watermark_says_why_and_does_not_fail(tmp_path):
    rows = [
        dict(SYNTH_MATH_MAIN[1], data_text='{"n": 1}'),
        dict(SYNTH_MATH_MAIN[0], math_env="broken", data_text="not json at all"),
    ]
    directory, _, _ = _extract(tmp_path, capture_served_math=True,
                               math_main=rows, math_ticks=[])
    meta = json.loads((directory / "served_math.json").read_text())
    reasons = {e["math_env"]: e["blob_watermark_absent_because"]
               for e in meta["math_main"]}
    assert "carries no 'lastVoteTimestamp' key" in reasons["prod"]
    assert "not parseable JSON" in reasons["broken"]
    # Both blobs are still captured verbatim; only the derived scalar is absent.
    assert (directory / "served-math-001.blob.json").read_bytes() == b"not json at all"


def test_a_conversation_with_no_served_row_captures_an_empty_document(tmp_path):
    directory, summary, _ = _extract(tmp_path, capture_served_math=True,
                                     math_main=[], math_ticks=[])
    meta = json.loads((directory / "served_math.json").read_text())
    assert meta["math_envs_captured"] == [] and meta["math_main"] == []
    assert meta["consistency"]["per_math_env"] == []
    assert summary["served_math"]["math_main_rows"] == 0
    assert not list(directory.glob("served-math-*.blob.json"))


def test_a_requested_math_env_restricts_the_capture_and_says_what_it_skipped(
        tmp_path):
    directory, summary, _ = _extract(
        tmp_path, capture_served_math=True, served_math_envs=("prod",))
    meta = json.loads((directory / "served_math.json").read_text())
    assert meta["requested_math_envs"] == ["prod"]
    assert meta["math_envs_captured"] == ["prod"]
    # What the database HELD is still recorded, so a partial capture cannot be
    # mistaken for a conversation that only ever had one environment.
    assert meta["math_envs_present"] == ["preprod", "prod"]
    assert summary["served_math"]["math_main_rows"] == 1


def test_the_logical_digest_moves_with_a_changed_blob_but_not_with_prose(
        captured, tmp_path):
    directory, summary, _ = captured
    meta = json.loads((directory / "served_math.json").read_text())
    assert fx.served_math_logical_digest(meta) == meta["logical_digest_sha256"]
    assert summary["served_math"]["logical_digest_sha256"] == \
        meta["logical_digest_sha256"]

    reworded = dict(meta, blob_handling="different prose entirely",
                    disclosures=["shorter"])
    assert fx.served_math_logical_digest(reworded) == meta["logical_digest_sha256"]

    changed = json.loads(json.dumps(meta))
    changed["math_main"][0]["blob_sha256"] = "0" * 64
    assert fx.served_math_logical_digest(changed) != meta["logical_digest_sha256"]


def test_a_parsed_blob_object_is_refused_at_the_boundary():
    """``data`` must be selected as ``::text``. Handing this a parsed object
    would make a Python re-serialisation the recorded fact."""
    with pytest.raises(TypeError, match="::text"):
        fx.build_served_math(
            math_main_rows=[{"math_env": "prod", "data_text": {"n": 1},
                             "last_vote_timestamp": 1, "math_tick": 1,
                             "caching_tick": 1, "modified": 1}],
            math_ticks_rows=[], vote_created_ms=[])


# ---------------------------------------------------------------------------
# Manifest + admission.
# ---------------------------------------------------------------------------


def test_the_manifest_records_the_capture_with_digests_and_no_identity(
        captured, tmp_path):
    from polismath.replay import fixture_bundle as fb

    directory, summary, _ = captured
    manifest = _build_manifest(directory.parent, summary)
    inventory = {f["path"]: f["sha256"] for f in manifest["files"]}
    block = manifest["roles"][0]["served_math"]
    assert inventory[f"{DIR_NAME}/served_math.json"] == block["meta_sha256"]
    for blob in block["blobs"]:
        assert inventory[f"{DIR_NAME}/{blob['file']}"] == blob["sha256"]
    # The blob is verbatim and carries the conversation's own zid key; the
    # MANIFEST must not, and the redaction list must say so out loud.
    assert "424242" not in json.dumps(manifest)
    assert any("VERBATIM" in line and "zid" in line
               for line in manifest["redactions"])
    fb.verify(directory.parent, manifest)


def test_a_captured_bundle_is_admissible(captured, tmp_path):
    from polismath.replay import fixture_bundle as fb

    directory, summary, _ = captured
    manifest = _build_manifest(directory.parent, summary)
    fb.admit_manifest(manifest, config=BASELINE_CONFIG,
                      config_bytes=fb.canonical_json(BASELINE_CONFIG))


def test_admission_restates_the_extractor_constants_it_must_not_import():
    from polismath.replay import fixture_bundle as fb

    assert fb.REQUIRED_SERVED_MATH_SCHEMA_VERSION == fx.SERVED_MATH_SCHEMA_VERSION
    assert fb.REQUIRED_SERVED_MATH_META_FILENAME == fx.SERVED_MATH_META_FILENAME


@pytest.mark.parametrize("mutate,expected", [
    (lambda b: b.update(schema_version="certify-served-math/99"),
     "served_math.schema_version"),
    (lambda b: b.update(captured=False), "served_math.captured"),
    (lambda b: b.update(meta_sha256="0" * 64), "claims digest"),
    (lambda b: b["blobs"][0].update(sha256="0" * 64), "claims digest"),
    (lambda b: b["blobs"][0].update(file="not-in-the-bundle.json"),
     "not in the file inventory"),
    (lambda b: b.update(math_main_rows=99), "blob(s): every served row"),
    (lambda b: b.update(math_envs=["prod", "prod"]), "repeats a math_env"),
    (lambda b: b.update(surprise=1), "unknown field 'surprise'"),
    (lambda b: b.pop("consistency"), "missing 'consistency'"),
    (lambda b: b["consistency"].update(gate=True), "DIAGNOSTIC and must never"),
    (lambda b: b["blobs"][0].update(bytes=0), "empty blob"),
])
def test_admission_rejects_a_served_block_that_does_not_bind(
        captured, mutate, expected):
    from polismath.replay import fixture_bundle as fb

    directory, summary, _ = captured
    manifest = _build_manifest(directory.parent, summary)
    mutate(manifest["roles"][0]["served_math"])
    with pytest.raises(fb.AdmissionError, match=re.escape(expected)):
        fb.admit_manifest(manifest, config=BASELINE_CONFIG,
                          config_bytes=fb.canonical_json(BASELINE_CONFIG))


def test_admission_still_accepts_a_bundle_that_captured_nothing(tmp_path):
    """An absent block is a complete statement — this bundle did not capture
    what the engine served — and must not become a new required field."""
    from polismath.replay import fixture_bundle as fb

    directory, summary, _ = _extract(tmp_path)
    manifest = _build_manifest(directory.parent, summary)
    assert "served_math" not in manifest["roles"][0]
    fb.admit_manifest(manifest, config=BASELINE_CONFIG,
                      config_bytes=fb.canonical_json(BASELINE_CONFIG))


# ---------------------------------------------------------------------------
# Loading the served rows back.
# ---------------------------------------------------------------------------


def test_the_loader_round_trips_the_served_rows(captured):
    directory, _, _ = captured
    served = rd.read_served_math(directory)
    assert served is not None
    assert served.schema_version == fx.SERVED_MATH_SCHEMA_VERSION
    assert served.math_envs_captured == ("preprod", "prod")
    prod = served.row("prod")
    assert prod is not None
    assert prod.blob_text == SERVED_BLOB_PROD_TEXT
    assert prod.last_vote_timestamp == BASE_MS + 400
    assert prod.math_tick == 7 and prod.caching_tick == 11
    assert prod.blob()["lastVoteTimestamp"] == BASE_MS + 400
    assert prod.blob()["comment-priorities"] == {"0": 49, "1": 49}
    tick = served.tick("prod")
    assert tick is not None and tick.math_tick == 7
    assert served.row("no-such-env") is None


def test_the_loader_returns_none_when_nothing_was_captured(tmp_path):
    directory, _, _ = _extract(tmp_path)
    assert rd.read_served_math(directory) is None


def test_the_loader_refuses_a_tampered_blob(captured):
    directory, _, _ = captured
    victim = directory / "served-math-001.blob.json"
    victim.write_bytes(victim.read_bytes().replace(b'"n": 3', b'"n": 9'))
    with pytest.raises(rd.ServedMathError, match="hashes to"):
        rd.read_served_math(directory)
    # ...and can still be read for diagnosis when that is what is wanted.
    assert rd.read_served_math(directory, verify_digests=False) is not None


def test_the_loader_refuses_a_missing_blob(captured):
    directory, _, _ = captured
    (directory / "served-math-001.blob.json").unlink()
    with pytest.raises(rd.ServedMathError, match="which is missing"):
        rd.read_served_math(directory)


def test_the_diagnostic_can_be_re_derived_from_a_loaded_dataset(captured):
    """The capture computed its diagnostic against the private millisecond
    stream; a replay is often driven from the second-resolution compatibility
    CSV. Re-deriving it from whatever was actually loaded makes that difference
    visible instead of assumed away."""
    directory, _, _ = captured
    served = rd.read_served_math(directory)
    assert served is not None
    dataset = rd.load_votes_csv(directory / f"{DIR_NAME}-votes.csv")
    result = rd.check_served_math_against_dataset(served, dataset)
    assert result["gate"] is False and result["kind"] == "diagnostic"
    assert result["vote_events"] == len(dataset.votes) == 6
    assert result["capture_recorded"] == served.consistency
    prod = next(e for e in result["per_math_env"] if e["math_env"] == "prod")
    # Second-resolution CSV timestamps: every vote in this synthetic
    # conversation truncates to the same second, so the whole stream lands at
    # or before the millisecond watermark. That is precisely the ingress fact
    # this re-derivation exists to expose.
    assert prod["votes_at_or_before_watermark"] == 6
    assert prod["votes_after_watermark"] == 0
    assert served.consistency["per_math_env"][1]["votes_after_watermark"] == 2
