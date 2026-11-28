"""The source of a run that names another run's topics (the frame's ``names_of``).

A named run takes the layout and the clusters of a finished keyword run of the
same conversation and comment rule and only names them. Before the child
starts, polis-jobs reads the source run's two families from its stored
results in Postgres (``queue-rs/src/jobs/names_of.rs``), checks each against
the batch and digest the source's run record names, and writes their codec
files into the attempt directory; the frame names them::

    "names_of": {"schema": "polis-jobs.names-of/1", "job_id": ..., "run_id": ...,
                 "batch_id": ..., "families": {"Delphi_UMAPGraph": {"file": ..., "sha256": ...},
                                               "Delphi_CommentHierarchicalClusterAssignments": {...}}}

This module reads them back: the source's rows, to be copied into the named
run's own batch unchanged, and the layout they hold (comment ids, 2D positions,
cluster labels per layer), from which the named run recomputes keywords and
sample comments. Nothing here reads a file an earlier run left on a box: the
files are this attempt's, written from Postgres. Outside the daemon, or with a
frame that names no source, :func:`load` is None and nothing changes.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from polismath.delphi_storage.codec import decode_family, to_python

SCHEMA = "polis-jobs.names-of/1"
FRAME_ENV = "DELPHI_FRAME"
POSITIONS = "Delphi_UMAPGraph"
ASSIGNMENTS = "Delphi_CommentHierarchicalClusterAssignments"
FAMILIES = (POSITIONS, ASSIGNMENTS)


class SourceError(ValueError):
    """The frame names a source whose files are not what it says."""


@dataclass
class Source:
    job_id: str
    run_id: str
    batch_id: str
    # family -> the source's rows, as boto3-resource values (codec.to_python)
    rows: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    comment_ids: List[int] = field(default_factory=list)
    document_map: Any = None
    cluster_layers: List[Any] = field(default_factory=list)


def _native(tagged: Dict[str, Any]) -> Dict[str, Any]:
    return {name: to_python(av) for name, av in tagged.items()}


def layout(positions: List[Dict[str, Any]], assignments: List[Dict[str, Any]]):
    """(comment ids ascending, positions N x 2, cluster labels per layer) from
    the two families' native rows. A node is the edge from a comment to itself;
    every other edge is skipped. A layer is kept up to the last one any comment
    is assigned in; an unassigned comment at a kept layer is -1 (noise)."""
    nodes = {}
    for row in positions:
        source, target = row.get("source_id"), row.get("target_id")
        if source is None or int(source) != int(target):
            continue
        p = row.get("position") or {}
        if int(source) in nodes or "x" not in p or "y" not in p:
            raise SourceError(f"{POSITIONS}: an unreadable node for comment {source}")
        nodes[int(source)] = (float(p["x"]), float(p["y"]))
    clusters = {}
    for row in assignments:
        tid = int(row["comment_id"])
        if tid in clusters:
            raise SourceError(f"{ASSIGNMENTS}: two rows for comment {tid}")
        layers = {}
        for name, value in row.items():
            if name.startswith("layer") and name.endswith("_cluster_id") and value is not None:
                layers[int(name[len("layer"):-len("_cluster_id")])] = int(value)
        clusters[tid] = layers
    if not nodes or set(nodes) != set(clusters):
        raise SourceError("the source's positions and assignments are not of the same comments")
    comment_ids = sorted(nodes)
    count = 1 + max((layer for ls in clusters.values() for layer, c in ls.items() if c >= 0),
                    default=-1)
    if count < 1:
        raise SourceError("the source assigns no comment to any topic")
    document_map = np.array([nodes[t] for t in comment_ids], dtype=float)
    cluster_layers = [np.array([clusters[t].get(layer, -1) for t in comment_ids], dtype=int)
                      for layer in range(count)]
    return comment_ids, document_map, cluster_layers


def from_frame(frame: Dict[str, Any], frame_path: str) -> Optional[Source]:
    entry = frame.get("names_of")
    if entry is None:
        return None
    if not isinstance(entry, dict) or entry.get("schema") != SCHEMA:
        raise SourceError("the frame's names_of is not polis-jobs.names-of/1")
    base = Path(frame_path).parent
    source = Source(job_id=str(entry.get("job_id")), run_id=str(entry.get("run_id")),
                    batch_id=str(entry.get("batch_id")))
    for name in FAMILIES:
        f = (entry.get("families") or {}).get(name) or {}
        try:
            data = (base / str(f.get("file"))).read_bytes()
        except OSError as e:
            raise SourceError(f"{name}: the source's file is unreadable: {e}") from e
        if hashlib.sha256(data).hexdigest() != f.get("sha256"):
            raise SourceError(f"{name}: the source's file is not the digest the frame names")
        family, items = decode_family(data)
        if family != name:
            raise SourceError(f"{name}: the file holds {family}")
        source.rows[name] = [_native(item) for item in items]
    source.comment_ids, source.document_map, source.cluster_layers = layout(
        source.rows[POSITIONS], source.rows[ASSIGNMENTS])
    return source


def load(environ: Optional[Dict[str, str]] = None) -> Optional[Source]:
    """The source this process's frame (``DELPHI_FRAME``) names; None outside
    the daemon or when the frame names none."""
    environ = os.environ if environ is None else environ
    frame_path = environ.get(FRAME_ENV, "").strip()
    if not frame_path:
        return None
    try:
        frame = json.loads(Path(frame_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SourceError(f"{FRAME_ENV} is unreadable: {e}") from e
    return from_frame(frame, frame_path)


def not_shown(source: Source, selected, texts: Dict[int, str]) -> List[int]:
    """The source's comments that the run's own selection no longer keeps, or
    that have no text: if any, no comment text of this layout may reach a model."""
    return [t for t in source.comment_ids if t not in selected or not (texts.get(t) or "").strip()]
