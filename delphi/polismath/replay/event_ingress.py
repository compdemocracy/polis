"""Authoritative certify-events/2 ingress; CSV is only a compatibility view.

NULL is retained and passed to the engines, never converted to a semantic
vote or pass. Existing engine NULL behavior is deliberately not repaired here.
Weights reach each engine unchanged; neither current engine uses this column.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

from polismath.replay.types import ModEvent, ReplayDataset
from polismath.utils.vote_convention import semantic_vote, validate_storage_agree_value


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _read(text):
    return json.loads(text, object_pairs_hook=_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def _integer(value, *, nullable=False):
    if nullable and value is None:
        return
    if type(value) is not int or not -(2**63) <= value < 2**63:
        raise ValueError("event integer required (signed 64-bit)")


def read_events(path: str | Path):
    """Validate before feeding either engine; no sorting or row dropping."""
    path = Path(path)
    meta = _read(path.with_name("events.meta.json").read_text())
    if meta.get("schema_version") != "certify-events/2":
        raise ValueError("unsupported events schema")
    convention = validate_storage_agree_value(meta.get("polarity", {}).get("storage_agree_value"))
    events = []
    votes = []
    comments = []
    digest = hashlib.sha256()
    for line in path.read_text().splitlines():
        e = _read(line)
        if not isinstance(e, dict) or type(e.get("ord")) is not int or e["ord"] != len(events):
            raise ValueError("event ord must be contiguous from zero")
        kind = e.get("kind")
        fields = {"ord", "kind", "created", "pid", "tid", "src"}
        fields |= {"vote", "weight_x_32767"} if kind == "vote" else {"modified", "mod", "is_meta"}
        if kind not in ("vote", "comment") or set(e) != fields:
            raise ValueError("unknown/missing event fields")
        for key in ("created", "pid", "tid"):
            _integer(e[key])
        src = e["src"]
        rows = votes if kind == "vote" else comments
        if (not isinstance(src, dict) or set(src) != {"table", "row"}
                or src["table"] != ("votes" if kind == "vote" else "comments")
                or type(src["row"]) is not int or src["row"] != len(rows)):
            raise ValueError("event source row does not match frozen order")
        if kind == "vote":
            if comments or (votes and e["created"] < votes[-1]["created"]):
                raise ValueError("votes must precede comments in created order")
            _integer(e["vote"], nullable=True)
            if e["vote"] not in (None, -1, 0, 1):
                raise ValueError("unknown vote")
            _integer(e["weight_x_32767"], nullable=True)
        else:
            _integer(e["modified"], nullable=True)
            _integer(e["mod"])
            if e["mod"] not in (-1, 0, 1) or type(e["is_meta"]) is not bool:
                raise ValueError("invalid comment state")
            if comments and e["tid"] <= comments[-1]["tid"]:
                raise ValueError("comments must be unique in tid order")
        rows.append(e)
        events.append(e)
        digest.update((json.dumps({k: v for k, v in e.items() if k != "src"},
                                 sort_keys=True, separators=(",", ":")) + "\n").encode())
    counts = meta.get("counts", {})
    for key, count in (("events", len(events)), ("vote_events", len(votes)), ("comment_events", len(comments))):
        if type(counts.get(key)) is not int or counts[key] != count:
            raise ValueError("event census mismatch")
    if meta.get("logical_digest_sha256") != digest.hexdigest():
        raise ValueError("event logical digest mismatch")
    return events, convention


def load_events(path: str | Path) -> ReplayDataset:
    events, convention = read_events(path)
    votes = [e for e in events if e["kind"] == "vote"]
    comments = [e for e in events if e["kind"] == "comment"]
    ds = ReplayDataset.build([
        (e["created"], e["pid"], e["tid"],
         None if e["vote"] is None else semantic_vote(e["vote"], convention))
        for e in votes
    ], mod_events=[ModEvent(e["modified"], e["tid"], e["mod"], e["is_meta"])
                   for e in comments if e["modified"] is not None])
    ds.votes = [replace(v, weight_x_32767=e["weight_x_32767"], source_ord=e["ord"])
                for v, e in zip(ds.votes, votes)]
    ds.input_events = tuple(events)
    ds.mod_events_skipped = sum(e["modified"] is None for e in comments)
    return ds


def input_hashes(path: str | Path) -> dict[str, str]:
    path = Path(path)
    return {name: hashlib.sha256(p.read_bytes()).hexdigest() for name, p in (
        ("events_sha256", path), ("events_meta_sha256", path.with_name("events.meta.json")))}


def compatibility_accounting(events_path: str | Path, csv_path: str | Path) -> dict:
    """Exact private diagnostic: every lost vote fact and its ordinal.

    A checkpoint in the old CSV addresses a different prefix after a NULL drop.
    This does not attempt to infer unavailable original facts from public CSVs.
    """
    from polismath.replay.real_data import read_export_vote_rows
    events, convention = read_events(events_path)
    votes = [e for e in events if e['kind'] == 'vote']
    retained = [e for e in votes if e['vote'] is not None]
    actual = read_export_vote_rows(csv_path)
    expected = [(e['created'] // 1000 * 1000, e['pid'], e['tid'],
                 semantic_vote(e['vote'], convention)) for e in retained]
    losses = []
    csv_slot = 0
    for slot, e in enumerate(votes, 1):
        if e['vote'] is not None:
            csv_slot += 1
        losses.append({'ord': e['ord'], 'event_vote_slot': slot,
                       'csv_vote_slot': csv_slot if e['vote'] is not None else None,
                       'null_vote_dropped': e['vote'] is None,
                       'milliseconds_lost': e['created'] % 1000,
                       'weight_lost': e['weight_x_32767'],
                       'weight_column_absent': True})
    return {'schema': 'polis-csv-loss/1', 'events': len(votes), 'csv_rows': len(actual),
            'csv_matches_declared_projection': actual == expected,
            'null_votes_dropped': sum(e['vote'] is None for e in votes),
            'subsecond_rows': sum(e['created'] % 1000 != 0 for e in votes),
            'non_null_weights_lost': sum(e['weight_x_32767'] is not None for e in votes),
            'rows': losses}
