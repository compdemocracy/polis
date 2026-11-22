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
all. A generator that fails fails the run.

The family holds either a map (its ``document``, ``document.gz`` and
``sha256`` rows) or one typed ``no_map`` row (``too_large``, ``no_positions``,
``no_topics``, ``too_few_comments``), and beside either an ``execution`` row:
the run's own record of its steps (``execution_record``), kept in memory by
polismath.step_log while the run ran. ``polis-topic-map/src/stored.rs`` says
each row's attributes. The document carries no comment text: no per-comment
text, and topic names keep a model's names and the keyword fallback's
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
    """The step could not store the run's map; the run fails."""


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
    the run has no Postgres result writer."""
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
    binary = os.environ.get(BINARY) or shutil.which("polis-topic-map")
    if not binary:
        raise TopicMapError("polis-topic-map is not installed")
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
            done = subprocess.run(command, capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise TopicMapError(f"polis-topic-map did not run: {e}") from e
        if done.returncode != 0:
            last = (done.stderr.strip().splitlines() or ["no message"])[-1]
            raise TopicMapError(f"polis-topic-map refused the run's families: {last}")
        wire = out.read_bytes()
        family, items = decode_family(wire)
        if family != TOPIC_MAP_FAMILY or not items:
            raise TopicMapError("polis-topic-map wrote another family")
        table = writer.Table(TOPIC_MAP_FAMILY)
        for existing in table.scan()["Items"]:
            table.delete_item(Key={"conversation_id": existing["conversation_id"], "part": existing["part"]})
        for item in items:
            table.put_item(Item={k: to_python(v) for k, v in item.items()})
        if writer.family_wire(TOPIC_MAP_FAMILY) != wire:
            raise TopicMapError("the stored family is not the generator's bytes")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    parts = {item["part"]["S"]: item for item in items}
    if "no_map" in parts:
        result = {"outcome": "no_map", "reason": parts["no_map"]["reason"]["S"]}
        if "bytes" in parts["no_map"]:
            result["document_bytes"] = int(parts["no_map"]["bytes"]["N"])
    else:
        result = {"outcome": "map", "document_bytes": int(parts["document"]["bytes"]["N"]),
                  "gzip_bytes": int(parts["document.gz"]["bytes"]["N"])}
    result["family_bytes"] = len(wire)
    logger.info(f"Topic map document stored: {result}")
    return result
