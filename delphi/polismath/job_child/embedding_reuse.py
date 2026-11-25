"""The stored comment embeddings polis-jobs hands a full-pipeline child
(``delphi-embedding-reuse/1``; ``queue-rs/src/jobs/reuse.rs``).

With ``POLIS_JOBS_EMBEDDINGS_REUSE=1`` (beside ``DELPHI_EMBEDDINGS_TABLE=1`` and
``POLIS_JOBS_INPUT_BUNDLE=1``) the daemon reads, on the input bundle's own
connection before the child starts, every stored vector of the conversation
under the run's model, and writes them as ``inputs/embeddings.spool`` in the
embeddings spool layout (``polismath/delphi_storage/embedding_spool.py``): per
row a comment id, the SHA-256 of the text that was embedded, and the vector.
The frame names it under ``inputs.embeddings`` with ten keys; with no file, the
file keys are null and ``reason`` is one word.

A comment's vector is a function of its text and the computation. So a stored
vector is used for a comment only when the file's model is, as an exact string,
the model this run stores under, that name pins the computation (``pinned``:
``repo@revision:dims``, a full commit id), and the comment's id is in the file
with the SHA-256 of this run's text. Every other comment is encoded as before.

Any doubt means encode: this module never raises. ``offer`` returns None when
the frame names no reuse (the run is what it was), else an ``Offer`` that holds
the verified rows or, with none, the one word that says why. The child opens
no database connection here: it reads two files in its own attempt directory.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from typing import Any, Dict, Mapping, NamedTuple, Optional, Tuple

SCHEMA = "delphi-embedding-reuse/1"
FILE = "inputs/embeddings.spool"
FRAME_ENV = "DELPHI_FRAME"
KEYS = frozenset(("schema", "file", "sha256", "rows", "model", "model_id", "dims", "env", "zid", "reason"))
# The contract's bound on the file (``embedding_spool.MAX_SPOOL_BYTES``); a larger
# file is not read at all.
MAX_FILE_BYTES = 268_435_456

# THE RULE: a stored model name may be reused only when it pins the computation
# that produced its vectors, by its form alone: ``<repo>@<revision>:<dims>``, with
# ``<repo>`` non-empty and holding no ``@``, ``<revision>`` a full commit id
# (exactly 40 lowercase hex digits), ``<dims>`` a positive width with no leading
# zero. A bare repository name (all-MiniLM-L6-v2's stored name today) names
# whatever bytes a directory or hub held, so it is never reused. The daemon
# states the same rule (``queue-rs/src/jobs/reuse.rs``, ``pinned``).
_PINNED = re.compile(r"[^@]+@[0-9a-f]{40}:[1-9][0-9]{0,4}")


def pinned(name: Any) -> bool:
    """True when a stored model name pins the computation (the rule above)."""
    return isinstance(name, str) and _PINNED.fullmatch(name) is not None


class Offer(NamedTuple):
    """What the frame offered: ``rows`` maps a comment id to (text SHA-256, vector),
    empty when ``reason`` (one word) says why nothing can be reused."""
    rows: Dict[int, Tuple[bytes, Tuple[float, ...]]]
    reason: Optional[str]

    def vector_for(self, tid: Any, text: str) -> Optional[Tuple[float, ...]]:
        """The stored vector of this comment, when its stored text is this text."""
        row = self.rows.get(int(tid))
        if row is None or row[0] != text_sha(text):
            return None
        return row[1]

    def text_changed(self, tid: Any, text: str) -> bool:
        """True when this comment is stored under another text: its new vector
        cannot be stored under the same id (``pd_embedding_put`` refuses)."""
        row = self.rows.get(int(tid))
        return row is not None and row[0] != text_sha(text)


def text_sha(text: str) -> bytes:
    """The SHA-256 a stored row carries: of the comment's UTF-8 text."""
    return hashlib.sha256(text.encode("utf-8")).digest()


def _nothing(reason: str) -> Offer:
    return Offer({}, reason)


def _is_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def from_frame(frame: Any, frame_path: str, model: Optional[str], dims: int) -> Optional[Offer]:
    """The reuse the frame offers, verified against the run's stored model name
    (``model``; None when the run's model has no stored name) and width. None
    when the frame has no ``inputs.embeddings`` key."""
    inputs = frame.get("inputs") if isinstance(frame, dict) else None
    if not isinstance(inputs, dict) or "embeddings" not in inputs:
        return None
    ref = inputs["embeddings"]
    if not isinstance(ref, dict) or set(ref) != KEYS or ref["schema"] != SCHEMA:
        return _nothing("frame")
    if ref["reason"] is not None:
        word = ref["reason"]
        return _nothing(word if isinstance(word, str) and word.isalpha() and len(word) <= 32 else "frame")
    if str(ref["zid"]) != str(frame.get("zid")) or not isinstance(ref["env"], str) \
            or ref["env"] != frame.get("env"):
        return _nothing("frame")
    if model is None or ref["model"] != model:
        return _nothing("model")
    if not pinned(model):
        return _nothing("unpinned")
    if ref["dims"] != dims:
        return _nothing("dims")
    if ref["file"] != FILE or not isinstance(ref["sha256"], str) or not _is_count(ref["rows"]):
        return _nothing("frame")
    path = os.path.join(os.path.dirname(os.path.abspath(frame_path)), FILE)
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
            return _nothing("file")
        with open(path, "rb") as f:
            data = f.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            return _nothing("file")
    except OSError:
        return _nothing("file")
    if hashlib.sha256(data).hexdigest() != ref["sha256"]:
        return _nothing("file")
    from polismath.delphi_storage.embedding_spool import read_spool
    try:
        spool_model, spool_dims, rows = read_spool(data)
    except Exception:  # any layout error: magic, bounds, width, truncation, trailing bytes
        return _nothing("file")
    if spool_model != model:
        return _nothing("model")
    if spool_dims != dims:
        return _nothing("dims")
    if len(rows) != ref["rows"]:
        return _nothing("file")
    held: Dict[int, Tuple[bytes, Tuple[float, ...]]] = {}
    for row in rows:
        vector = tuple(row["vector"])
        if len(vector) != dims or not all(math.isfinite(v) for v in vector):
            return _nothing("vector")
        if row["tid"] in held:
            return _nothing("file")
        held[row["tid"]] = (bytes(row["text_sha"]), vector)
    return Offer(held, None)


_offered: Dict[Tuple[str, Optional[str], int], Optional[Offer]] = {}


def offer(model: Optional[str], dims: int, environ: Optional[Mapping[str, str]] = None) -> Optional[Offer]:
    """The reuse this process's frame (``DELPHI_FRAME``) offers, read once per
    process. None outside the daemon or when the frame names no reuse. Never
    raises: a frame that cannot be read is an Offer with reason ``frame``."""
    environ = os.environ if environ is None else environ
    frame_path = environ.get(FRAME_ENV, "").strip()
    if not frame_path:
        return None
    key = (frame_path, model, dims)
    if key not in _offered:
        try:
            with open(frame_path, "rb") as f:
                frame = json.loads(f.read().decode("utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            # No frame file: no reuse offered, the run is what it was.
            _offered[key] = _nothing("frame") if os.path.exists(frame_path) else None
        else:
            try:
                _offered[key] = from_frame(frame, frame_path, model, dims)
            except Exception:  # a reuse problem never fails a run
                _offered[key] = _nothing("failed")
    return _offered[key]
