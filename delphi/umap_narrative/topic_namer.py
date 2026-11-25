"""
Topic names written by a model, for a run whose job names a namer.

A run is given a namer (``run_delphi.py --namer=<json>``, which the job child
passes only when the job's configuration names one) as a JSON object::

    {"model": "claude-haiku-5-5", "prompt": "polis-topic-names/1", "thinking": "default"}

With it, the naming step does not use the older per-topic provider path
(``topic_naming.generate_cluster_topic_labels``). Instead it:

1. builds ``hierarchy.json``: every non-noise topic of every layer, with its
   id (``<layer>_<cluster>``), layer, size, parent (the topic one layer up
   holding most of its non-noise comments), first five keywords and the three
   comments nearest its centre in the 2D map. Comment text and keywords only:
   no author, participant, vote, time, comment id or conversation name;
2. runs ``polis-topic-names name --in hierarchy.json --out names.json
   --namer <json>`` (a Rust program built into the Delphi image), which makes
   the one model call and checks the reply;
3. reads ``names.json``. On outcome ``named`` the model's names are the
   layer labels, each recorded as written by the model; on any other outcome
   the keyword labels are kept, each recorded as a fallback, with the outcome
   and its reason in the run's record. A naming failure never fails the run
   and is never retried here. A failure to create, write, read or remove the
   step's own files is such a failure (``scratch_unavailable``).

Only the participants' comment rule (``participant_visible/1``) is named in
this version: a namer with any other selection is refused before the run
starts, so no comment a moderator removed is ever sent.

The program, its file shapes and its exit status are described in
``queue-rs/polis-topic-names``. This module holds no state between runs:
``hierarchy.json`` and ``names.json`` live in a directory of this attempt
(a new name each run), removed by the step once read and again by
run_delphi.py when the run ends. Exactly when that directory is removed:

- the run ends, a naming fails, or a scratch file cannot be made, written,
  read or removed: yes;
- the naming's program runs past ``WAIT_SECONDS``: it is stopped and waited
  for, then the files are removed;
- run_delphi.py is sent SIGTERM (by hand, or the daemon stopping its process
  group): it stops the pipeline (SIGTERM, then SIGKILL after
  ``step_log.STOP_SECONDS``), the pipeline stops and waits for the program
  (``exit_on_sigterm``), then the directory is removed. Only a pipeline that
  must be sent SIGKILL can leave a program running, and that program can only
  write into the removed directory's path;
- under the job daemon the directory is inside the attempt directory, which
  the daemon removes once it has reaped the process group after a normal end,
  a timeout, a fence or SIGKILL;
- NOT removed: a hand-started run sent SIGKILL (no code of it runs), and,
  under the daemon, an attempt whose exit the daemon confirms only after a
  failed terminal call or after its own restart (that recovery path keeps
  the attempt directory). The directory then stays where it is until the
  box's temporary files or work directories are cleared.

That is safe because nothing a later step or run needs is kept there: no
run looks for another run's directory, and the run's record of the naming
(its outcome and token counts, for the manifest) reaches run_delphi.py over
a Unix socket pair (``send_record``, ``RecordExchange``), never through a
file. What can be left is the hierarchy (the participants' own comments
that the conversation shows, and keywords) and at most the program's names.

The record is the only account of the naming, and the model's names are
stored only once run_delphi.py has said it holds the record whole: the
pipeline sends the record, run_delphi.py's ``RecordExchange`` reads it while
the pipeline runs and answers ``ACK``, and only after reading that answer
(``await_ack``) does the pipeline write the model's names. With no answer
(the record could not be sent or read, the answer was lost or did not come
within ``ACK_SECONDS``) the pipeline writes the keyword labels and, if the
rest of the run succeeds, exits ``UNACKNOWLEDGED_EXIT``; run_delphi.py then
records the naming as keywords with its reason, whatever record it holds,
and the run completes. The exit status is the last word because, unlike a
message, the parent always receives it. A run whose record never reached
run_delphi.py keeps the call's token counts in the pipeline's own log line
(``topic_names_call``). Nothing of the exchange outlives the two processes.
"""

import json
import os
import select
import shutil
import socket
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

# The one comment rule version 1 names.
NAMER_SELECTION = "participant_visible/1"
MODELS = ("claude-haiku-5-5", "claude-sonnet-5-5")
PROMPTS = ("polis-topic-names/1",)
THINKING = ("default", "off")
NAMER_KEYS = ("model", "prompt", "thinking")

HIERARCHY_SCHEMA = "polis-topic-names.hierarchy/1"
NAMES_SCHEMA = "polis-topic-names.names/1"
RECORD_SCHEMA = "polis-topic-names.run-record/1"

# The program; the image installs it on PATH.
BINARY = "DELPHI_TOPIC_NAMES_BIN"
PROGRAM = "polis-topic-names"
# The program's own bound is a 300 s read timeout and at most one retry after
# at most 60 s; past this the program is stopped and the run keeps keywords.
WAIT_SECONDS = 900

KEYWORDS = 5
SAMPLES = 3
NAME_MAX = 50
REASON_MAX = 200

# The step's two scratch files, in its directory.
HIERARCHY_FILE = "hierarchy.json"
NAMES_FILE = "names.json"
# The reason a failure of those files is recorded with (and the class of the error).
SCRATCH_UNAVAILABLE = "scratch_unavailable"
# The most of a record run_delphi.py reads from the pipe.
RECORD_MAX_BYTES = 1 << 20
# What a run's record names as the writer of keyword labels (never the model
# that was asked and did not name them).
KEYWORD_TOPIC_MODEL = "keywords"

NAMED = "named"
# The word for anything wrong with the program itself (not found, crashed,
# stopped, or a file that is not its contract); the program never writes it.
NAMER_FAILED = "namer_failed"
# The outcome words the program writes (plan of record: no key, over the
# per-run cap, too large, an HTTP status, a timeout, a refusal, a truncated
# reply, and the reply checks).
PROGRAM_OUTCOMES = frozenset({
    NAMED, "no_key", "over_run_cap", "too_large", "timeout", "connect_error", "refused", "truncated",
    "bad_json", "bad_cover", "repeated_names", "bad_length", "wrong_language",
})


class NamerRefused(ValueError):
    """A namer this version does not name, or one given with another comment rule."""


def parse_namer(text: str) -> Dict[str, str]:
    """The namer a run was given, checked: exactly ``model``, ``prompt`` and
    ``thinking``, each one this version knows. Raises NamerRefused otherwise."""
    try:
        namer = json.loads(text)
    except (TypeError, ValueError):
        raise NamerRefused("the namer is not JSON") from None
    if not isinstance(namer, dict) or set(namer) != set(NAMER_KEYS):
        raise NamerRefused(f"the namer must be an object of exactly {', '.join(NAMER_KEYS)}")
    for key, known in (("model", MODELS), ("prompt", PROMPTS), ("thinking", THINKING)):
        if namer[key] not in known:
            raise NamerRefused(f"unknown namer {key}: {namer[key]!r}")
    return {key: namer[key] for key in NAMER_KEYS}


def namer_argument(namer: Dict[str, str]) -> str:
    """The namer as one compact JSON argument, keys in a fixed order."""
    return json.dumps({key: namer[key] for key in NAMER_KEYS}, separators=(",", ":"))


def exit_on_sigterm() -> None:
    """For the pipeline of a run given a namer: SIGTERM (run_delphi.py stopping
    it) exits through Python, so the naming's program, if running, is stopped
    and waited for on the way out (subprocess.run does both) and nothing of
    the run writes into the scratch directory after it is removed."""
    import signal

    def _exit(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _exit)


def check_selection(namer: Optional[Dict[str, str]], selection: Optional[str]) -> None:
    """Refuse a namer under any comment rule but the participants' own."""
    if namer is not None and selection != NAMER_SELECTION:
        raise NamerRefused(f"a namer is named only for the selection {NAMER_SELECTION}, not {selection!r}")


def build_hierarchy(layer_data, cluster_layers, comment_texts: Sequence[str], document_map) -> Dict[str, Any]:
    """``hierarchy.json``: every non-noise topic of every layer (layer 0 the
    finest), in layer then cluster order.

    - parent: the topic of the next layer up holding the most of this topic's
      comments that are not noise there, ties to the lower cluster id; None at
      the top layer or when every comment is noise one layer up;
    - keywords: the first five of the layer's ``top_words``;
    - samples3: ``select_representative_comments(limit=3)``, the pipeline's own
      choice (nearest the centroid in the 2D map when a topic has more than
      three comments, else its first three)."""
    from umap_narrative.topic_naming import select_representative_comments

    arrays = [np.asarray(layer) for layer in cluster_layers]
    topics: Dict[str, Any] = {}
    for layer_idx, layer in enumerate(arrays):
        characteristics = (layer_data.get(layer_idx) or {}).get("characteristics") or {}
        for cluster in sorted(int(c) for c in np.unique(layer[layer >= 0])):
            members = np.where(layer == cluster)[0]
            parent = None
            if layer_idx + 1 < len(arrays):
                above = arrays[layer_idx + 1][members]
                above = above[above >= 0]
                if above.size:
                    values, counts = np.unique(above, return_counts=True)
                    parent = f"{layer_idx + 1}_{int(values[int(np.argmax(counts))])}"
            facts = characteristics.get(cluster) or characteristics.get(str(cluster)) or {}
            samples = select_representative_comments(cluster, layer, comment_texts, document_map, limit=SAMPLES)
            tid = f"{layer_idx}_{cluster}"
            topics[tid] = {
                "id": tid,
                "layer": layer_idx,
                "cluster": cluster,
                "size": int(members.size),
                "keywords": [str(w) for w in list(facts.get("top_words", []))[:KEYWORDS]],
                "parent": parent,
                "samples3": [str(s) for s in samples],
            }
    return {"schema": HIERARCHY_SCHEMA, "layers": list(range(len(arrays))), "topics": topics}


def _short(text: Any) -> str:
    return " ".join(str(text).split())[:REASON_MAX]


def _result(namer, outcome, reason=None, names=None, record=None) -> Dict[str, Any]:
    record = record or {}
    tokens_in, tokens_out, dollars = (record.get(k) for k in ("tokens_in", "tokens_out", "dollars"))
    return {
        "schema": RECORD_SCHEMA,
        "namer": dict(namer),
        "outcome": outcome,
        "reason": None if outcome == NAMED else _short(reason or outcome),
        "names": dict(names or {}) if outcome == NAMED else {},
        "tokens_in": tokens_in if isinstance(tokens_in, int) and not isinstance(tokens_in, bool) else None,
        "tokens_out": tokens_out if isinstance(tokens_out, int) and not isinstance(tokens_out, bool) else None,
        "dollars": dollars if isinstance(dollars, (int, float)) and not isinstance(dollars, bool) else None,
    }


def _outcome_word(word: Any) -> bool:
    return isinstance(word, str) and (word in PROGRAM_OUTCOMES or (
        word.startswith("http_") and word[5:].isdigit() and len(word) == 8))


def read_names(path: str, hierarchy: Dict[str, Any], namer: Dict[str, str]) -> Dict[str, Any]:
    """The program's ``names.json``, believed only as far as its contract:
    the schema, a known outcome word, and when named, a name for exactly the
    hierarchy's ids, each a non-empty string of at most 50 characters."""
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except OSError as e:
        return _result(namer, NAMER_FAILED, f"{SCRATCH_UNAVAILABLE} ({type(e).__name__})")
    except ValueError as e:
        return _result(namer, NAMER_FAILED, f"names.json is unreadable ({type(e).__name__})")
    if not isinstance(doc, dict) or doc.get("schema") != NAMES_SCHEMA:
        return _result(namer, NAMER_FAILED, "names.json is not polis-topic-names.names/1")
    outcome = doc.get("outcome")
    if not _outcome_word(outcome):
        return _result(namer, NAMER_FAILED, "names.json names an unknown outcome")
    record = doc.get("record") if isinstance(doc.get("record"), dict) else {}
    if outcome != NAMED:
        return _result(namer, outcome, doc.get("reason"), record=record)
    names = doc.get("names")
    if not isinstance(names, dict) or set(names) != set(hierarchy["topics"]):
        return _result(namer, NAMER_FAILED, "names.json does not name exactly the hierarchy's topics",
                       record=record)
    for name in names.values():
        if not isinstance(name, str) or not name.strip() or len(name) > NAME_MAX:
            return _result(namer, NAMER_FAILED, "names.json holds a name that is empty or too long",
                           record=record)
    return _result(namer, NAMED, names=names, record=record)


def run_namer(namer: Dict[str, str], hierarchy: Dict[str, Any], work_dir: str,
              timeout: float = WAIT_SECONDS) -> Dict[str, Any]:
    """Write ``hierarchy.json`` into ``work_dir``, run the program, read what
    it wrote and remove both files. Never raises for anything the program or
    the scratch files do: every outcome is a result (``named``, the program's
    word, or ``namer_failed``). Scratch-file failures keep the keyword labels
    just like program failures, with the token counts of a call that was made."""
    try:
        result = _run_namer(namer, hierarchy, work_dir, timeout)
    except OSError as e:
        _discard_scratch(work_dir)
        return _result(namer, NAMER_FAILED, f"{SCRATCH_UNAVAILABLE} ({type(e).__name__})")
    try:
        remove_scratch(work_dir)
    except OSError as e:
        _discard_scratch(work_dir)
        return keep_keywords(result, f"{SCRATCH_UNAVAILABLE} ({type(e).__name__})")
    return result


def remove_scratch(work_dir: str) -> None:
    """Remove the step's two files (the hierarchy holds comment text)."""
    for name in (HIERARCHY_FILE, NAMES_FILE):
        path = os.path.join(work_dir, name)
        if os.path.lexists(path):
            os.remove(path)


def _discard_scratch(work_dir: str) -> None:
    try:
        remove_scratch(work_dir)
    except OSError:
        pass


def keep_keywords(result: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """``result`` with the keyword labels kept for ``reason``: a named result
    becomes ``namer_failed``; any other keeps its outcome and adds the reason.
    The token counts of a call that was made are kept either way."""
    if result["outcome"] == NAMED:
        return _result(result["namer"], NAMER_FAILED, reason, record=result)
    return _result(result["namer"], result["outcome"], f"{result['reason']}; {reason}", record=result)


def _run_namer(namer: Dict[str, str], hierarchy: Dict[str, Any], work_dir: str,
               timeout: float = WAIT_SECONDS) -> Dict[str, Any]:
    if not hierarchy["topics"]:
        # The program refuses an empty hierarchy; there is nothing to send.
        return _result(namer, NAMER_FAILED, "no_topics")
    binary = os.environ.get(BINARY) or shutil.which(PROGRAM)
    if not binary:
        return _result(namer, NAMER_FAILED, "not_installed")
    os.makedirs(work_dir, mode=0o700, exist_ok=True)
    hierarchy_path = os.path.join(work_dir, HIERARCHY_FILE)
    names_path = os.path.join(work_dir, NAMES_FILE)
    if os.path.lexists(names_path):
        os.remove(names_path)
    with open(hierarchy_path, "w", encoding="utf-8") as f:
        json.dump(hierarchy, f, ensure_ascii=False)
    command = [binary, "name", "--in", hierarchy_path, "--out", names_path, "--namer", namer_argument(namer)]
    try:
        done = subprocess.run(command, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return _result(namer, NAMER_FAILED, "timeout_waiting_for_program")
    except OSError as e:
        return _result(namer, NAMER_FAILED, f"did_not_run ({type(e).__name__})")
    if done.returncode != 0:
        return _result(namer, NAMER_FAILED, f"exit_{done.returncode}")
    return read_names(names_path, hierarchy, namer)


def layer_names(result: Dict[str, Any], layer_idx: int, clusters: List[int]) -> Dict[int, str]:
    """The model's names for one layer's clusters, as the pipeline's labels
    (``<layer>_<cluster>: <name>``)."""
    from umap_narrative.topic_naming import _prefixed

    return {c: _prefixed(layer_idx, c, result["names"][f"{layer_idx}_{c}"].strip()) for c in clusters}


def step_facts(result: Dict[str, Any]) -> Dict[str, Any]:
    """What the run's step log records of the naming (closed words and
    counts; the reason is the program's own short line, never comment text)."""
    namer = result["namer"]
    return {
        "provider": PROGRAM,
        "model": namer["model"],
        "namer": namer_argument(namer),
        "prompt": namer["prompt"],
        "thinking": namer["thinking"],
        "outcome": result["outcome"],
        "reason": result["reason"],
    }


def record_of(result: Dict[str, Any]) -> Dict[str, Any]:
    """The naming's record: the outcome, the namer and the token counts,
    never a name or a comment."""
    return {k: v for k, v in result.items() if k != "names"}


def send_record(fd: int, result: Dict[str, Any]) -> None:
    """Send the naming's record to run_delphi.py over the pipe it gave the
    pipeline (``--naming-record-fd``): one JSON line, on a line of its own
    even after a write that failed part way. Raises OSError."""
    text = json.dumps(record_of(result), ensure_ascii=False, separators=(",", ":"))
    line = memoryview(("\n" + text + "\n").encode())
    while line:
        line = line[os.write(fd, line):]


def _drain(fd: int) -> bytes:
    """What the pipe or socket holds now, without waiting on any process that
    still holds its other end. Raises OSError when it cannot be read."""
    os.set_blocking(fd, False)
    data = b""
    while len(data) < RECORD_MAX_BYTES:
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            break
        if not chunk:
            break
        data += chunk
    return data


def _last_whole_record(data: bytes) -> Optional[Dict[str, Any]]:
    """The last whole record in ``data`` (a line ending in its newline)."""
    for line in reversed(data.split(b"\n")[:-1]):
        try:
            doc = json.loads(line)
        except ValueError:
            continue
        if isinstance(doc, dict) and doc.get("schema") == RECORD_SCHEMA:
            return doc
    return None


def receive_record(fd: int) -> Optional[Dict[str, Any]]:
    """The last whole record sent on the pipe (a line ending in its newline),
    read once the pipeline has exited (without waiting on any process that
    still holds the pipe), or None when there is none. Raises OSError when
    the pipe cannot be read: that is not the same as no record."""
    return _last_whole_record(_drain(fd))


# run_delphi.py's answer once it holds the record whole, how long the
# pipeline waits for it, and the pipeline's exit status when it kept the
# keyword labels because the answer did not come (the rest of the run
# having succeeded; 75 is EX_TEMPFAIL, which nothing else in it exits with).
ACK = b"held\n"
ACK_SECONDS = 60
UNACKNOWLEDGED_EXIT = 75
_unacknowledged = False


def await_ack(fd: int, seconds: Optional[float] = None) -> Optional[str]:
    """None once run_delphi.py has answered ``ACK`` on ``fd``; otherwise why
    not, in a word: ``timeout``, ``closed`` (its end is gone), ``garbled``, or
    the error reading."""
    deadline = time.monotonic() + (ACK_SECONDS if seconds is None else seconds)
    data = b""
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([fd], [], [], left)[0]:
                return "timeout"
            chunk = os.read(fd, len(ACK) - len(data))
            if not chunk:
                return "closed"
            data += chunk
            if not ACK.startswith(data):
                return "garbled"
            if data == ACK:
                return None
    except (OSError, ValueError) as e:
        return type(e).__name__


def set_acknowledged(acknowledged: bool) -> None:
    """How this pipeline's naming ended its exchange (``exit_status``)."""
    global _unacknowledged
    _unacknowledged = not acknowledged


def exit_status() -> int:
    """A named run's exit status once everything else succeeded: 0, or
    ``UNACKNOWLEDGED_EXIT`` when its names are keyword labels kept because
    run_delphi.py did not acknowledge the record."""
    return UNACKNOWLEDGED_EXIT if _unacknowledged else 0


class RecordExchange:
    """run_delphi.py's end of the naming's exchange with its pipeline: a Unix
    socket pair whose other end (``child_fd``) the pipeline is given as
    ``--naming-record-fd``. A thread reads the record while the pipeline
    runs and, holding a whole one, answers ``ACK``. ``finish``, once the
    pipeline has exited, returns what is held. Nothing is kept anywhere else."""

    POLL_SECONDS = 0.1

    def __init__(self):
        self._mine, self._theirs = socket.socketpair()
        self.child_fd = self._theirs.fileno()
        self._data = b""
        self._record = None
        self._reason = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._receive, name="naming-record", daemon=True)
        self._thread.start()

    def _receive(self) -> None:
        fd = self._mine.fileno()
        try:
            while not self._stop.is_set() and len(self._data) < RECORD_MAX_BYTES:
                if not select.select([fd], [], [], self.POLL_SECONDS)[0]:
                    continue
                chunk = os.read(fd, 65536)
                if not chunk:
                    return
                self._data += chunk
                record = _last_whole_record(self._data)
                if record is not None:
                    self._record = record
                    try:
                        os.write(fd, ACK)
                    except OSError as e:
                        self._reason = f"ack_unsent ({type(e).__name__})"
                    return
        except (OSError, ValueError) as e:
            self._reason = f"record_unreadable ({type(e).__name__})"

    def finish(self):
        """``(record, None)``, or ``(record or None, why)``: ``record_missing``
        (no whole record), ``record_unreadable (<error>)``, ``ack_unsent
        (<error>)``. A record sent but not yet read when the pipeline exited
        is read here; it was never acknowledged."""
        self._theirs.close()
        self._stop.set()
        self._thread.join()
        try:
            if self._record is None and self._reason is None:
                try:
                    self._record = _last_whole_record(self._data + _drain(self._mine.fileno()))
                except OSError as e:
                    self._reason = f"record_unreadable ({type(e).__name__})"
            if self._record is None and self._reason is None:
                self._reason = "record_missing"
            return self._record, self._reason
        finally:
            self._mine.close()
