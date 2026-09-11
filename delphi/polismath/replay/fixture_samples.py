"""Box-local sampled payload admission and the frozen full-stream recipe.

The numeric selection report remains unchanged. Ordinals, directories, events
and resolved moderation belong only to the box-local manifest and plan.
"""
from collections import Counter
import csv
import json
from pathlib import Path

from polismath.replay import fixture_config, fixture_selection as selection

MANIFEST_VERSION = "certify-fixture-manifest/4"
BLOCK_VERSION = "certify-representative-payloads/1"
PLAN_VERSION = "polis-private-paired-plan/2"
SCHEDULE_ID = "representative-uniform6-clojure-legacy"
MAX_PAYLOAD_BYTES = 180 * 1024**3
MAX_PAYLOAD_FILES = 1_000_000


def payload_census(manifest):
    files = manifest["files"]
    if type(files) is not list or any(type(f.get("size")) is not int or f["size"] < 0 for f in files):
        raise selection.SelectionError("SAMPLE_PAYLOAD_CENSUS")
    size = sum(f["size"] for f in files)
    if len(files) > MAX_PAYLOAD_FILES or size > MAX_PAYLOAD_BYTES:
        raise selection.SelectionError("SAMPLE_PAYLOAD_CAPACITY")
    return dict(unique_payload_bytes=size, payload_files=len(files))


def slug(ordinal):
    if type(ordinal) is not int or not 1 <= ordinal <= selection.TARGET:
        raise selection.SelectionError("SAMPLE_ORDINAL")
    return f"sample-{ordinal:03d}"


def rule(ordinal):
    name = slug(ordinal)
    return dict(slug=name, role=name, group="representative", rank=None,
                predicates=[], on_missing="fail")


def block(config, report):
    seed = fixture_config.representative_seed(config)
    if seed is None:
        if report is not None:
            raise selection.SelectionError("UNCONFIGURED_SAMPLE_PAYLOADS")
        return None
    selection.validate_report(report)
    if report["seed"] != seed or not report["bucket_counts"]["selected"]:
        raise selection.SelectionError("SAMPLE_REPORT_BINDING")
    return {"schema": BLOCK_VERSION, "report": report}


def payload_sizes(directory):
    """Recount source rows, including NULL votes, without using compatibility CSV."""
    from polismath.replay.event_ingress import read_events
    events, _ = read_events(Path(directory) / "events.jsonl")
    votes = [e for e in events if e["kind"] == "vote"]
    p = len({e["pid"] for e in votes})
    c = len({e["tid"] for e in votes})
    with (Path(directory) / "participants.csv").open(newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ["participant-id", "moderation", "created"]:
            raise selection.SelectionError("SAMPLE_PARTICIPANT_SCHEMA")
        participants = list(reader)
    ids = [int(row["participant-id"]) for row in participants]
    if len(set(ids)) != len(ids):
        raise selection.SelectionError("SAMPLE_PARTICIPANT_CENSUS")
    meta = json.loads((Path(directory) / "events.meta.json").read_bytes())
    if type(meta["counts"].get("participants")) is not int or meta["counts"]["participants"] != len(ids):
        raise selection.SelectionError("SAMPLE_PARTICIPANT_CENSUS")
    return dict(P=p, V=len(votes), C=c,
                U=len({(e["pid"], e["tid"]) for e in votes}), matrix_area=p*c,
                registered_participants=len(ids), all_comments=len(events)-len(votes))


def admitted_rules(manifest, config, payload_root=None):
    """Closed census, distinct payloads and exact report-to-source size binding."""
    declared = manifest.get("representative")
    if fixture_config.representative_seed(config) is None:
        if declared is not None or manifest["schema_version"] == MANIFEST_VERSION:
            raise selection.SelectionError("UNCONFIGURED_SAMPLE_PAYLOADS")
        return {}
    if (manifest["schema_version"] != MANIFEST_VERSION or type(declared) is not dict
            or set(declared) != {"schema", "report"} or declared["schema"] != BLOCK_VERSION):
        raise selection.SelectionError("SAMPLE_MANIFEST_SCHEMA")
    block(config, declared["report"])
    payload_census(manifest)
    report = declared["report"]
    rules = {r["slug"]: r for r in (rule(i+1) for i in range(report["bucket_counts"]["selected"]))}
    reserved = {r["slug"] for r in config["roles"] + config["public_fixtures"]}
    reserved.update(config["coverage_role_map"])
    if set(rules) & reserved:
        raise selection.SelectionError("SAMPLE_ROLE_COLLISION")
    rows = [r for r in manifest["roles"] if r.get("slug") in rules]
    if (len(rows) != len(rules) or {r["slug"] for r in rows} != set(rules)
            or len({r.get("dir") for r in rows}) != len(rows)):
        raise selection.SelectionError("SAMPLE_PAYLOAD_CENSUS")
    sizes = []
    for row in rows:
        source = row.get("source")
        if source == "derived":
            source = row.get("derived_from", {}).get("source")
        if source != "production" or row.get("group") != "representative":
            raise selection.SelectionError("SAMPLE_SOURCE")
        metrics = row.get("measured_metrics", {})
        if not all(type(metrics.get(k)) is int and metrics[k] >= 0 for k in selection.SIZE_FIELDS):
            raise selection.SelectionError("SAMPLE_METRICS")
        selected_sizes = {k: metrics[k] for k in selection.SIZE_FIELDS}
        if payload_root is not None:
            from polismath.replay.fixture_bundle import safe_join
            if payload_sizes(safe_join(Path(payload_root), row["dir"])) != selected_sizes:
                raise selection.SelectionError("SAMPLE_PAYLOAD_SIZE_BINDING")
        sizes.append(tuple(selected_sizes[k] for k in selection.SIZE_FIELDS))
    expected = [tuple(r[k] for k in selection.SIZE_FIELDS) for r in report["chosen_entry_sizes"]]
    if Counter(sizes) != Counter(expected):
        raise selection.SelectionError("SAMPLE_SIZE_REPORT_BINDING")
    return rules


def resolved_spec(alias, dataset):
    """Ceiling-six cuts; source final moderation is applied only at the final cut.

    Current comment flags cannot reconstruct a history. Applying their complete
    final state at the final checkpoint is explicit, including missing/late
    modification timestamps and the empty bootstrap case.
    """
    from polismath.replay.schedule import ScheduleSpec
    if dataset.input_events is None:
        raise selection.SelectionError("SAMPLE_LOSSLESS_EVENTS_REQUIRED")
    n = dataset.n
    at = sorted({(k*n + 5)//6 for k in range(1, 7)})
    cuts = {"mode": "vote-count", "at": at}
    if not n:
        cuts["empty_checkpoint"] = True
    return ScheduleSpec(dataset=alias, schedule_id=SCHEDULE_ID, source="events-jsonl",
                        cuts=cuts, moderation="source-final-state", coverage="full-stream",
                        empty_output=None if n else {"n": 0, "n-cmts": 0, "tids": [], "in-conv": []},
                        notes="Uniform ceiling-six full stream; current source moderation at final checkpoint, not historical moderation.")


def ordered_prepared(prepared):
    """Measured vote count/area, preserving ordinary/restart recipe adjacency."""
    from polismath.replay import real_data
    groups = {}
    for expected in prepared:
        groups.setdefault(expected.entry.dataset, []).append(expected)
    def size(item):
        alias, _ = item
        dataset = real_data.load_export_votes(alias)
        return (dataset.n, len({v.pid for v in dataset.votes}) * len({v.tid for v in dataset.votes}), alias)
    return [entry for _, entries in sorted(groups.items(), key=size)
            for entry in sorted(entries, key=lambda e: (e.spec.restart_after is not None, e.entry.schedule_id))]
