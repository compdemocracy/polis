"""The input bundle polis-jobs writes before a full-pipeline child starts
(``delphi-input-bundle/1``; ``queue-rs/schemas/delphi-input-bundle-v1.json``
and the three row schemas beside it).

With ``POLIS_JOBS_INPUT_BUNDLE=1`` the daemon reads, in one read-only
snapshot, the rows the stages read from Postgres (the conversation row, every
comment, every report comment selection, the vote high-water mark and the
math_main tick pair) and writes them as files into ``inputs/`` of the attempt
directory. The frame names the manifest under ``inputs.bundle``: its path,
relative to the attempt directory (the frame's directory), and its sha256.
With that key absent, ``load`` returns None and every stage reads Postgres as
before.

Every byte is checked before a row is used: the manifest against the frame's
sha256, each file against the manifest's sha256, byte length and row count,
and the comment-set digest the daemon computed against the one ``census.py``
computes here. A bundle that fails a check raises ``BundleError``; a stage
given a bundle never falls back to Postgres.

The rows have the keys and types the stages' own queries return
(``PostgresClient.get_comments_by_conversation``,
``get_report_comment_selections``; the conversation's topic, description,
created, modified and owner), so the code after the read is unchanged.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, List, Optional

SCHEMA = "delphi-input-bundle/1"
MANIFEST = "inputs/manifest.json"
FRAME_ENV = "DELPHI_FRAME"
# (role, file name, row schema), in the order the manifest lists them.
ROLES = (
    ("conversation", "conversation.json", "delphi-input-bundle.conversation/1"),
    ("comments", "comments.json", "delphi-input-bundle.comments/1"),
    ("report_comment_selections", "report_comment_selections.json",
     "delphi-input-bundle.report-comment-selections/1"),
)
INPUT_KEYS = ("math_env", "math_tick", "math_caching_tick", "comment_set_sha256", "vote_hwm")


class BundleError(Exception):
    """The frame names a bundle that cannot be used; no stage may read it."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_hex64(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


class InputBundle:
    """The verified rows of one bundle."""

    def __init__(self, zid: int, inputs: Dict[str, Any], rows: Dict[str, Any]):
        self.zid = zid
        self._inputs = inputs
        self._rows = rows

    @classmethod
    def from_frame(cls, frame: Dict[str, Any], frame_path: str) -> Optional["InputBundle"]:
        """The bundle the frame names, verified; None when the frame names none."""
        inputs = frame.get("inputs") if isinstance(frame, dict) else None
        ref = inputs.get("bundle") if isinstance(inputs, dict) else None
        if ref is None:
            return None
        if not isinstance(ref, dict) or set(ref) != {"manifest", "schema", "sha256"}:
            raise BundleError("frame inputs.bundle must be {manifest, schema, sha256}")
        if ref["schema"] != SCHEMA or ref["manifest"] != MANIFEST or not _is_hex64(ref["sha256"]):
            raise BundleError(f"frame inputs.bundle is not a {SCHEMA} reference")
        attempt_dir = os.path.dirname(os.path.abspath(frame_path))
        directory = os.path.dirname(os.path.join(attempt_dir, MANIFEST))
        raw = _read(os.path.join(attempt_dir, MANIFEST))
        if _sha256(raw) != ref["sha256"]:
            raise BundleError("the bundle manifest does not match the frame's sha256")
        manifest = _json(raw, MANIFEST)
        if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
            raise BundleError(f"the bundle manifest is not a {SCHEMA} document")
        zid = manifest.get("zid")
        if not isinstance(zid, int) or isinstance(zid, bool) or str(zid) != str(frame.get("zid")):
            raise BundleError(f"the bundle is for zid {zid!r}, the frame for {frame.get('zid')!r}")
        files = manifest.get("files")
        if not isinstance(files, list) or [f.get("role") if isinstance(f, dict) else None
                                           for f in files] != [r for r, _, _ in ROLES]:
            raise BundleError("the bundle manifest must list conversation, comments, report_comment_selections")
        rows: Dict[str, Any] = {}
        for entry, (role, name, row_schema) in zip(files, ROLES):
            if entry.get("path") != name or entry.get("schema") != row_schema:
                raise BundleError(f"the bundle's {role} entry must be {name} ({row_schema})")
            data = _read(os.path.join(directory, name))
            if len(data) != entry.get("bytes") or _sha256(data) != entry.get("sha256"):
                raise BundleError(f"{name} does not match the bundle manifest")
            value = _json(data, name)
            count = len(value) if isinstance(value, list) else 1
            if count != entry.get("rows") or (role == "conversation") != isinstance(value, dict):
                raise BundleError(f"{name} does not hold the rows the manifest names")
            rows[role] = value
        inputs_block = manifest.get("inputs")
        if not isinstance(inputs_block, dict) or set(inputs_block) != set(INPUT_KEYS):
            raise BundleError("the bundle manifest's inputs must be exactly " + ", ".join(INPUT_KEYS))
        return cls(zid, inputs_block, rows)

    def conversation(self) -> Dict[str, Any]:
        """The conversation row: zid, topic, description, created, modified, owner."""
        return dict(self._rows["conversation"])

    def comments(self) -> List[Dict[str, Any]]:
        """Every comment, ordered by tid, as ``get_comments_by_conversation`` returns them."""
        return [dict(c) for c in self._rows["comments"]]

    def report_comment_selections(self) -> List[Dict[str, Any]]:
        """Every report's selections, as ``get_report_comment_selections(zid)`` returns them."""
        return [dict(s) for s in self._rows["report_comment_selections"]]

    def inputs(self, math_env: str) -> Dict[str, Any]:
        """The manifest's inputs block, after the two checks the census can make
        here: the stages' math_env, and the comment-set digest recomputed by
        ``census.comment_set_sha256`` over the bundle's comments."""
        from polismath.job_child.census import comment_set_sha256

        if self._inputs["math_env"] != math_env:
            raise BundleError(f"the bundle was read for math_env {self._inputs['math_env']!r}, "
                              f"the stages read {math_env!r}")
        if comment_set_sha256(self._rows["comments"]) != self._inputs["comment_set_sha256"]:
            raise BundleError("the bundle's comment-set digest is not the census digest of its comments")
        return {k: self._inputs[k] for k in INPUT_KEYS}


def _read(path: str) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError as e:
        raise BundleError(f"cannot read {path}: {e}") from e


def _json(data: bytes, name: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise BundleError(f"{name} is not JSON: {e}") from e


_loaded: Dict[str, Optional[InputBundle]] = {}


def load(zid: Any = None, environ: Optional[Dict[str, str]] = None) -> Optional[InputBundle]:
    """The bundle of this process's frame (``DELPHI_FRAME``), verified once per
    process; None outside the daemon or when the frame names none. With ``zid``,
    a bundle for another conversation is refused."""
    environ = os.environ if environ is None else environ
    frame_path = environ.get(FRAME_ENV, "").strip()
    if not frame_path:
        return None
    if frame_path not in _loaded:
        try:
            with open(frame_path, "rb") as f:
                frame = json.loads(f.read().decode("utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as e:
            raise BundleError(f"{FRAME_ENV} is unreadable: {e}") from e
        _loaded[frame_path] = InputBundle.from_frame(frame, frame_path)
    bundle = _loaded[frame_path]
    if bundle is not None and zid is not None and str(bundle.zid) != str(zid):
        raise BundleError(f"the bundle is for zid {bundle.zid}, this stage runs zid {zid}")
    return bundle
