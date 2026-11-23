"""The topic map step: a Delphi run stores its own topic map with its results.

Off unless ``DELPHI_TOPIC_MAP_DOCUMENT`` is exactly ``1``. Off, nothing here
runs, prints or writes, and a run stores exactly the families it always did.

On, at the end of a full pipeline run (``umap_narrative/run_pipeline.py``,
after the topic names are written and before the daemon seals the run's
result batch), the step hands the generator (``polis-topic-map store``, the
Rust binary built into the Delphi image) the codec files of the three families
the run has just written to its attempt's scratch: the UMAP positions, the
clusters at every layer and the topic names. The generator returns the codec
file of one more family, ``Delphi_TopicMapDocument``; the step reads it with
the frozen codec (which refuses any byte that is not canonical) and writes its
rows to the same scratch through the same writer, so the daemon stores them in
the run's own batch with the rest: the map publishes with the run or not at
all. A generator that fails does not fail the run: the step logs an error
and stores, in place of the map, one ``no_map`` row whose reason is
``generator_failed`` and whose ``failure`` is one of ``DRAW_FAILURES`` (never
the generator's message), and the run's other results publish as they would
without the step.

The family holds either a map (its ``document``, ``document.gz`` and
``sha256`` rows) or one typed ``no_map`` row (``too_large``, ``no_positions``,
``no_topics``, ``too_few_comments``, ``generator_failed``), and beside a map
or any ``no_map`` row the generator wrote, an ``execution`` row:
the run's own record of its steps (``execution_record``), kept in memory by
polismath.step_log while the run ran. ``polis-topic-map/src/stored.rs`` says
each row's attributes. The document carries no comment text: no per-comment
text, and of the topic names it keeps a name the run recorded as its model's
as written, and otherwise only generic names and the keyword fallback's
keywords, never its example comment. Its provenance names the run (env, job,
run, batch), its publication scope and comment rule, its models (as the run's
output manifest names them), how its names were taken, the three families it
was drawn from and the execution record. Nothing is kept on the box: the generator's files live in
the attempt's own scratch directory and are removed when the step ends.

Only a run with the Postgres result writer (the jobs daemon's
``DELPHI_RESULT_BACKEND=postgres``) can store the family; on any other run the
step logs that it stored nothing and the run goes on as before.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from .codec import decode_family, to_python
from .postgres import TOPIC_MAP_FAMILY

SWITCH = "DELPHI_TOPIC_MAP_DOCUMENT"
# The generator binary; the image installs it on PATH.
BINARY = "DELPHI_TOPIC_MAP_BIN"
INPUTS = (
    ("positions", "Delphi_UMAPGraph"),
    ("assignments", "Delphi_CommentHierarchicalClusterAssignments"),
    ("names", "Delphi_CommentClustersLLMTopicNames"),
)
# Far above what the generator takes (well under a second for 4,000 comments).
TIMEOUT_SECONDS = 600

logger = logging.getLogger(__name__)


class TopicMapError(RuntimeError):
    """The run's writer cannot hold its map (another conversation's frame, or
    no result scope); the run fails."""


# Why the generator did not draw the run's map: the ``failure`` of a
# ``generator_failed`` row (``DRAW_FAILURES`` in polis-topic-map's stored.rs).
DRAW_FAILURES = ("not_installed", "did_not_run", "timed_out", "refused", "wrong_output")


class _DrawFailed(Exception):
    def __init__(self, failure: str, detail: str):
        assert failure in DRAW_FAILURES
        super().__init__(detail)
        self.failure = failure


def enabled() -> bool:
    return os.environ.get(SWITCH, "").strip() == "1"


def _writer():
    if os.environ.get("DELPHI_RESULT_BACKEND") != "postgres" or not os.environ.get("DELPHI_OUTPUT_MANIFEST", "").strip():
        return None
    from .writer import WriterResource
    return WriterResource()


EXECUTION_SCHEMA = "delphi-run-execution/1"
# What the run's child process cannot know, said instead of guessed.
UNAVAILABLE = {
    "code_version": "not passed to the run's process; the run record's code_version names the code it was admitted with",
    "image": "not known to the run's process; the deploy records the image it ran",
}


def execution_record(entries, selection: Optional[str]) -> Dict[str, Any]:
    """The run's record of its steps (``delphi-run-execution/1``), from the
    entries polismath.step_log kept while the run ran: each step in order with
    its status, seconds and facts (counts and closed labels, never text); the
    algorithms' parameters as the steps noted them (UMAP's read back from
    UMAP itself); the comment selection and its counts; what the run could not
    know."""
    steps = [dict(e) for e in entries if "step" in e]
    algorithms: Dict[str, Any] = {}
    for e in entries:
        if "note" not in e:
            continue
        facts = {k: v for k, v in e.items() if k != "note"}
        if e["note"] == "topic_names":
            algorithms.setdefault("topic_names", []).append(facts)
        else:
            algorithms[e["note"]] = facts
    inputs = next((s for s in steps if s["step"] == "inputs"), {})
    chosen = {
        "rule": selection,
        "strict_moderation": inputs.get("strict_moderation"),
        "comments_read": inputs.get("comments_read"),
        "comments_embedded": inputs.get("comments_embedded"),
        "comments_selected": inputs.get("comments_selected", inputs.get("comments_used")),
        "left_out": {k[len("left_out_"):]: v for k, v in inputs.items() if k.startswith("left_out_")},
    }
    return {"schema": EXECUTION_SCHEMA, "available": True, "selection": chosen, "steps": steps,
            "algorithms": algorithms, "unavailable": UNAVAILABLE}


def store_run_map(zid: Any, selection: Optional[str], models: Dict[str, Any], writer=None,
                  execution: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Store the run's map in its result batch. Returns what was stored
    (``outcome``, and the sizes or the reason), or None when the step is off or
    the run has no Postgres result writer. When the generator fails, logs an
    error and stores one ``generator_failed`` row instead; the run goes on."""
    if not enabled():
        return None
    writer = writer if writer is not None else _writer()
    if writer is None:
        logger.info("Topic map document: not stored (the run has no Postgres result writer)")
        return None
    frame = writer.frame
    if str(frame["zid"]) != str(zid):
        raise TopicMapError("the writer's frame is another conversation's")
    scope = frame.get("config", {}).get("result_scope") or os.environ.get("DELPHI_RESULT_SCOPE")
    if not scope:
        raise TopicMapError("the run names no result scope")
    table = writer.Table(TOPIC_MAP_FAMILY)
    try:
        wire, result = _draw(writer, frame, scope, selection, models, execution, table)
    except _DrawFailed as e:
        logger.error(f"Topic map document: the generator did not draw the run's map ({e.failure}): {e}")
        _clear(table)
        table.put_item(Item={"conversation_id": str(frame["zid"]), "part": "no_map", "job_id": str(frame["job_id"]),
                             "reason": "generator_failed", "failure": e.failure})
        result = {"outcome": "no_map", "reason": "generator_failed", "failure": e.failure,
                  "family_bytes": len(writer.family_wire(TOPIC_MAP_FAMILY))}
        logger.info(f"Topic map document stored: {result}")
        return result
    result["family_bytes"] = len(wire)
    logger.info(f"Topic map document stored: {result}")
    return result


def _outcome(items) -> Dict[str, Any]:
    """What the generator's family holds, read from the parts and attributes
    the step reports. Raises _DrawFailed (``wrong_output``) when one of them is
    missing or malformed: a family the codec reads that is not a whole map."""
    try:
        parts = {item["part"]["S"]: item for item in items}
        if "no_map" in parts:
            result = {"outcome": "no_map", "reason": parts["no_map"]["reason"]["S"]}
            if "bytes" in parts["no_map"]:
                result["document_bytes"] = int(parts["no_map"]["bytes"]["N"])
        else:
            result = {"outcome": "map", "document_bytes": int(parts["document"]["bytes"]["N"]),
                      "gzip_bytes": int(parts["document.gz"]["bytes"]["N"])}
    except (KeyError, TypeError, ValueError) as e:
        raise _DrawFailed("wrong_output", f"polis-topic-map wrote an incomplete family ({type(e).__name__}: {e})") from e
    return result


def _clear(table) -> None:
    for existing in table.scan()["Items"]:
        table.delete_item(Key={"conversation_id": existing["conversation_id"], "part": existing["part"]})


def _draw(writer, frame, scope, selection, models, execution, table):
    """Run the generator on the run's families and store what it wrote, as it
    wrote it. Raises _DrawFailed when it did not draw the map."""
    binary = os.environ.get(BINARY) or shutil.which("polis-topic-map")
    if not binary:
        raise _DrawFailed("not_installed", "polis-topic-map is not installed")
    work = Path(tempfile.mkdtemp(prefix="topic-map-", dir=writer.directory))
    try:
        paths = {}
        for name, family in INPUTS:
            paths[name] = work / f"{family}.jsonl"
            paths[name].write_bytes(writer.family_wire(family))
        (work / "models.json").write_text(json.dumps(models, sort_keys=True))
        if execution is None:
            execution = {"schema": EXECUTION_SCHEMA, "available": False,
                         "reason": "the run did not record its steps"}
        (work / "execution.json").write_text(json.dumps(execution, sort_keys=True))
        out = work / f"{TOPIC_MAP_FAMILY}.jsonl"
        command = [
            binary, "store",
            "--env", str(frame["env"]), "--job", str(frame["job_id"]), "--run", str(frame["run_id"]),
            "--batch", str(frame["attempt_id"]), "--conversation", str(int(frame["zid"])), "--scope", str(scope),
            "--models", str(work / "models.json"), "--execution", str(work / "execution.json"),
            "--positions", str(paths["positions"]), "--assignments", str(paths["assignments"]),
            "--names", str(paths["names"]), "--out", str(out),
        ]
        if selection is not None:
            command += ["--selection", str(selection)]
        try:
            # Bytes, not text: the generator's diagnostics are decoded below
            # for the log only, so no byte it writes can raise here.
            done = subprocess.run(command, capture_output=True, timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as e:
            raise _DrawFailed("timed_out", f"polis-topic-map did not finish: {e}") from e
        except OSError as e:
            raise _DrawFailed("did_not_run", f"polis-topic-map did not run: {e}") from e
        if done.returncode != 0:
            stderr = done.stderr.decode("utf-8", errors="replace")
            last = (stderr.strip().splitlines() or ["no message"])[-1]
            raise _DrawFailed("refused", f"polis-topic-map refused the run's families: {last}")
        try:
            wire = out.read_bytes()
            family, items = decode_family(wire)
        except Exception as e:
            raise _DrawFailed("wrong_output", f"polis-topic-map wrote no readable family: {e}") from e
        if family != TOPIC_MAP_FAMILY or not items:
            raise _DrawFailed("wrong_output", "polis-topic-map wrote another family")
        # Read before anything is stored, so an incomplete family is never put.
        result = _outcome(items)
        _clear(table)
        for item in items:
            table.put_item(Item={k: to_python(v) for k, v in item.items()})
        if writer.family_wire(TOPIC_MAP_FAMILY) != wire:
            raise _DrawFailed("wrong_output", "the stored family is not the generator's bytes")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return wire, result
