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
   and is never retried here.

Only the participants' comment rule (``participant_visible/1``) is named in
this version: a namer with any other selection is refused before the run
starts, so no comment a moderator removed is ever sent.

The program, its file shapes and its exit status are described in
``queue-rs/polis-topic-names``. This module holds no state between runs:
``hierarchy.json`` and ``names.json`` live in a directory of this attempt,
removed when the run ends.
"""

import json
import os
import shutil
import subprocess
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

# The file this attempt's naming leaves for run_delphi.py's manifest.
RECORD_FILE = "naming.json"
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
    except (OSError, ValueError) as e:
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
    """Scratch-file failures keep the keyword labels just like program failures."""
    try:
        return _run_namer(namer, hierarchy, work_dir, timeout)
    except OSError as e:
        return _result(namer, NAMER_FAILED, f"scratch_unavailable ({type(e).__name__})")


def _run_namer(namer: Dict[str, str], hierarchy: Dict[str, Any], work_dir: str,
               timeout: float = WAIT_SECONDS) -> Dict[str, Any]:
    """Write ``hierarchy.json`` into ``work_dir``, run the program, and read
    what it wrote. Never raises for anything the program does: every outcome
    is a result (``named``, the program's word, or ``namer_failed``)."""
    if not hierarchy["topics"]:
        # The program refuses an empty hierarchy; there is nothing to send.
        return _result(namer, NAMER_FAILED, "no_topics")
    binary = os.environ.get(BINARY) or shutil.which(PROGRAM)
    if not binary:
        return _result(namer, NAMER_FAILED, "not_installed")
    os.makedirs(work_dir, exist_ok=True)
    hierarchy_path = os.path.join(work_dir, "hierarchy.json")
    names_path = os.path.join(work_dir, "names.json")
    if os.path.exists(names_path):
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


def write_record(path: str, result: Dict[str, Any]) -> None:
    """The naming's result for the run's manifest (read by run_delphi.py):
    the outcome, the namer and the token counts, never a name or a comment."""
    keep = {k: v for k, v in result.items() if k != "names"}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(keep, f, ensure_ascii=False)


def read_record(path: str) -> Optional[Dict[str, Any]]:
    """The record ``write_record`` wrote, or None when there is none."""
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and doc.get("schema") == RECORD_SCHEMA else None
