"""Verdicts of the two-convention gate (P-078 PR-F).

    python ci/vote_convention/compare.py v0 OUT        # the required leg
    python ci/vote_convention/compare.py v1 OUT        # v0 against v1

``v0`` checks the leg recorded at today's convention on its own: every leg ran,
the replay fixtures still reproduce their recorded components, the declared-sign
fold adapter is the identity at the oracle's own sign, the public battery
exports back to its committed votes file, and no export failed.

``v1`` compares OUT/v0 with OUT/v1 byte for byte. Exactly one field is
normalised: ``vote`` of the stored rows (``db/``), which must differ by sign and
in nothing else. Every other output (pca2 bodies and heads, every CSV export,
math_main / math_bidtopid / math_ptptstats, the replay cuts, the fold) must be
byte-identical: the export sign is fixed at +1 and the engines are meant to read
the convention, not assume it. Until PR-A (the convention row) and PR-B/C (the
chokepoints) land, they do not, and this comparison fails. EXPECTED_RED names
every family that is red today and why; a red outside it is a regression.

    python ci/vote_convention/compare.py v1 OUT --ratchet   # required in CI

Writes OUT/verdict-<leg>.json and a Markdown summary (to $GITHUB_STEP_SUMMARY
when set). Exit status: 0 fully green; 3 (v1 only) red, but every red family is
on EXPECTED_RED; 1 anything else. ``--ratchet`` exits 0 for 0 or 3 and 1
otherwise: the required step, while the strict comparison stays informative.

The ratchet accepts a v0/v1 difference only in a file pinned in
expected-red-v1.json, and only when it is sign-shaped: structurally identical to
v0 (status, headers but etag/content-length; JSON keys recursively, list
lengths, types and identity fields such as tids / n / in-conv; CSV header, row
count and every column but the declared sign-carrying ones), so only leaf values
differ (inside the comment-selection subtrees, only the container). Both legs must write exactly the inventory derived from
the fixture set and the pca2 case list, with no failed export and no HTTP 5xx.
``--write-pins`` re-baselines the pin file from OUT (review its diff).
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "delphi"))
sys.path.insert(0, str(HERE))

#: Families of output and the reason each is red at v1 on today's code.
EXPECTED_RED: Dict[str, str] = {
    "math/math_main": "PR-A + PR-C: the poller reads votes with the code constant STORAGE_AGREE_VALUE = -1 "
                      "(delphi/polismath/database/postgres.py poll_votes), so v1 rows are folded as their opposite "
                      "and math_main inverts.",
    "replay": "PR-A + PR-C: the replay cuts are read back through the same production loader "
              "(PostgresClient.poll_votes) and inherit the constant; the recorded column order no longer reproduces.",
    "pca2": "PR-A + PR-C: GET /api/v3/math/pca2 serves the math_main the poller wrote; the body (and its ETag / "
            "content-length) changes with it. The route itself has no vote literal.",
    "export/votes.csv": "PR-A + PR-B: server/src/report.ts writes String(-row.vote): the export negates the raw row "
                        "with a sign it assumes.",
    "export/participant-votes.csv": "PR-A + PR-B: server/src/report.ts sets -row.vote per participant and counts "
                                    "n-agree / n-disagree on the result.",
    "export/comments.csv": "PR-A + PR-B: server/src/report.ts counts agrees as row.vote === -1 and disagrees as === 1.",
    "export/comment-groups.csv": "PR-A + PR-C: built from math_main group-votes (A/D/S), which invert with the math.",
}

#: Exit status of ``compare.py v1`` when every red is expected (1 = an unexpected red).
EXIT_EXPECTED_RED = 3

#: Families that must be green at v1 even today: the fixture loader, the
#: companions, and the outputs no vote value reaches or that are sign-blind.

MUST_HOLD: Dict[str, str] = {
    "db": "the loader writes the opposite sign and nothing else",
    "fold/declared": "the frozen fold oracle through its declared-sign adapter, the way every caller calls it (PR-G)",
    "math/math_bidtopid": "unchanged by the inversion today (the pid/bid mapping); a change is a regression",
    "math/math_ptptstats": "unchanged by the inversion today; a change is a regression",
    # Sign-blind: they stay green even with math_main inverted (counts, a mirrored
    # clustering's group count and group ids). Their green is not evidence that
    # the sign does not matter, but a change in them is a regression.
    "export/summary.csv": "sign-blind (not evidence): counts and the group count",
    "export/participant-importance.csv": "sign-blind (not evidence): -row.vote only feeds .size; group ids survive a mirror",
}


def family(rel: str) -> str:
    head = rel.split("/", 1)[0]
    if head == "export":
        return "export/" + rel.split(".", 1)[1]
    if head == "math":
        return "math/" + rel.rsplit(".", 2)[-2]
    if head == "fold":
        return "fold/" + rel.rsplit(".", 2)[-2]
    return head


def files(base: Path) -> Dict[str, Path]:
    return {
        str(p.relative_to(base)): p
        for p in base.rglob("*")
        if p.is_file() and not p.name.startswith("_") and p.parent.name != "_meta" and p.name != "engine-leg.json"
    }


def same_but_sign(a: bytes, b: bytes) -> Tuple[bool, str]:
    """db/<zid>.votes.json: v1 must be v0 with every vote negated, nothing else."""
    ra, rb = json.loads(a), json.loads(b)
    if len(ra) != len(rb):
        return False, f"row count {len(ra)} != {len(rb)}"
    for i, (x, y) in enumerate(zip(ra, rb)):
        if x.keys() != y.keys() or any(x[k] != y[k] for k in x if k != "vote"):
            return False, f"row {i} differs outside vote"
        if x["vote"] is None or y["vote"] is None:
            if x["vote"] is not y["vote"]:
                return False, f"row {i} NULL on one side only"
        elif y["vote"] != -x["vote"]:
            return False, f"row {i} vote {x['vote']} -> {y['vote']} is not a sign change"
    return True, ""


PINNED_RED = HERE / "expected-red-v1.json"
EXPORTS = ("summary.csv", "comments.csv", "votes.csv", "participant-votes.csv",
           "participant-importance.csv", "comment-groups.csv")
MATH_TABLES = ("math_main", "math_bidtopid", "math_ptptstats")


def case_file(case_id: str) -> str:
    """server_leg.cjs's file stem for a pca2 case."""
    return "pca2/" + re.sub(r"[^A-Za-z0-9._-]+", "_", case_id)


def pca2_case_ids() -> List[str]:
    """The case identities of server/characterization/pca2-cases.cjs, from the module itself."""
    script = ("process.stdout.write(JSON.stringify(require(process.argv[1]).pca2Cases().map((c) => c.caseId)))")
    out = subprocess.run(["node", "-e", script, str(ROOT / "server/characterization/pca2-cases.cjs")],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def expected_inventory() -> Set[str]:
    """Every output each leg must write, derived from the declared fixture set and
    the pca2 case list, never from what a leg reports about itself."""
    import fixtures

    inv: Set[str] = set()
    for c in fixtures.all_conversations():
        inv.add(f"db/{c.zid:05d}.votes.json")
        if c.votes:
            inv.add(f"fold/{c.zid:05d}.declared.json")
        inv |= {f"export/{c.zid:05d}.{name}" for name in EXPORTS}
        if c.math_env:
            inv |= {f"math/{c.zid:05d}.{c.math_env}.{t}.json" for t in MATH_TABLES}
        if c.replay:
            inv.add(f"replay/{c.source.replace('/', '-')}.json")
    for case_id in pca2_case_ids():
        inv |= {case_file(case_id) + ".head.json", case_file(case_id) + ".body"}
    return inv


def load_pinned() -> Set[str]:
    data = json.loads(PINNED_RED.read_text())
    return {rel for rels in data["files"].values() for rel in rels}


def leg_problems(base: Path, inventory: Set[str]) -> List[str]:
    """One leg on its own: complete inventory, no failed export, no server error,
    and its self-reported counts agree with the inventory."""
    leg = base.name
    problems = []
    have = set(files(base)) if base.exists() else set()
    problems += [f"{leg}: missing output {rel}" for rel in sorted(inventory - have)]
    problems += [f"{leg}: output outside the inventory {rel}" for rel in sorted(have - inventory)]
    try:
        server = json.loads((base / "_meta" / "server-leg.json").read_text())
        n_cases = sum(1 for rel in inventory if rel.endswith(".head.json"))
        if server.get("exportFailures") != 0:
            problems.append(f"{leg}: server leg reports {server.get('exportFailures')} export failure(s)")
        if server.get("pca2Cases") != n_cases:
            problems.append(f"{leg}: server leg recorded {server.get('pca2Cases')} pca2 cases, {n_cases} expected")
    except (OSError, ValueError) as exc:
        problems.append(f"{leg}: no server-leg metadata ({exc})")
    try:
        engine = json.loads((base / "engine-leg.json").read_text())
        n_replay = sum(1 for rel in inventory if rel.startswith("replay/"))
        if len(engine.get("replay", {})) != n_replay:
            problems.append(f"{leg}: engine leg replayed {len(engine.get('replay', {}))} fixtures, {n_replay} expected")
    except (OSError, ValueError) as exc:
        problems.append(f"{leg}: no engine-leg metadata ({exc})")
    for rel in sorted(have & inventory):
        path = base / rel
        if rel.startswith("export/"):
            status = path.read_text(errors="replace").partition("\n")[0]
            if status != "status 200":
                problems.append(f"{leg}: {rel} failed ({status})")
        elif rel.endswith(".head.json"):
            try:
                code = json.loads(path.read_text())["status"]
            except (ValueError, KeyError) as exc:
                problems.append(f"{leg}: {rel} unreadable ({exc})")
                continue
            if not isinstance(code, int) or code >= 500:
                problems.append(f"{leg}: {rel} HTTP {code}")
    return problems


def _decode_body(base: Path, rel: str) -> bytes:
    raw = (base / rel).read_bytes()
    head = json.loads((base / (rel[: -len(".body")] + ".head.json")).read_text())
    return gzip.decompress(raw) if head.get("headers", {}).get("content-encoding") == "gzip" and raw else raw


#: Fields that identify what an output is about. They must be EQUAL across the
#: legs inside a pinned file: a storage-sign dependence changes values, never these.
IDENTITY_FIELDS = frozenset({
    "tids", "zid", "n", "n-cmts", "in-conv", "user-vote-counts", "math_tick", "meta-tids", "mod-in", "mod-out",
    "participant_count", "comment_count", "lastVoteTimestamp", "lastModTimestamp", "moderation",
    "source", "cut", "event_count", "user_vote_counts", "last_vote_timestamp", "ambiguous",
})

#: Subtrees that SELECT comments by sign (which comments are consensus or
#: representative flips with the sign). Inside them only the container type and,
#: for a dict, its keys (group ids, agree/disagree) must match.
SELECTION_SUBTREES = frozenset({
    "/consensus/agree", "/consensus/disagree", "/repness/#", "/repness_full/group_repness/#",
    "/repness_full/consensus_comments/agree", "/repness_full/consensus_comments/disagree",
})

#: CSV columns whose values carry the sign (everything else must be equal).
#: participant-votes.csv also carries one vote column per comment id, and
#: comment-groups.csv group-<g>-agrees / -disagrees / -passes per group.
CSV_SIGN_COLUMNS = {
    "votes.csv": {"vote"},
    "comments.csv": {"agrees", "disagrees"},
    "participant-votes.csv": {"n-agree", "n-disagree"},
    "comment-groups.csv": {"total-agrees", "total-disagrees", "total-passes"},
}


def _number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def structural_diff(a, b, path: str = "") -> Optional[str]:
    """The first structural difference between two JSON values, or None.

    Same types (int and float are one number type), same dict keys recursively,
    same list lengths, equal IDENTITY_FIELDS; only leaf values may differ, and
    inside SELECTION_SUBTREES only the container type."""
    if not (type(a) is type(b) or (_number(a) and _number(b))):
        return f"{path or '/'}: type {type(a).__name__} -> {type(b).__name__}"
    norm = re.sub(r"/\d+(?=/|$)", "/#", path)
    if norm in SELECTION_SUBTREES:
        return None
    if isinstance(a, dict):
        if set(a) != set(b):
            return f"{path or '/'}: keys changed {sorted(set(a) ^ set(b))[:6]}"
        for k in a:
            if k in IDENTITY_FIELDS and a[k] != b[k]:
                return f"{path}/{k}: identity field changed"
            why = structural_diff(a[k], b[k], f"{path}/{k}")
            if why:
                return why
    elif isinstance(a, list):
        if len(a) != len(b):
            return f"{path or '/'}: length {len(a)} -> {len(b)}"
        for n, (x, y) in enumerate(zip(a, b)):
            why = structural_diff(x, y, f"{path}/{n}")
            if why:
                return why
    return None


def _same_structure_json(x: bytes, y: bytes) -> Tuple[bool, str]:
    try:
        a, b = json.loads(x) if x.strip() else None, json.loads(y) if y.strip() else None
    except ValueError as exc:
        return False, f"not JSON ({exc})"
    why = structural_diff(a, b)
    return (why is None, why or "")


def _same_structure_csv(rel: str, x: bytes, y: bytes) -> Tuple[bool, str]:
    sa, _, ta = x.decode().partition("\n")
    sb, _, tb = y.decode().partition("\n")
    if sa != sb:
        return False, f"status line changed ({sa} -> {sb})"
    ra, rb = list(csv.reader(io.StringIO(ta))), list(csv.reader(io.StringIO(tb)))
    if not ra or not rb or ra[0] != rb[0]:
        return False, "CSV header changed"
    if len(ra) != len(rb):
        return False, f"row count {len(ra) - 1} -> {len(rb) - 1}"
    header = ra[0]
    name = rel.split(".", 1)[1]
    free = CSV_SIGN_COLUMNS.get(name, set())
    for n, (row_a, row_b) in enumerate(zip(ra[1:], rb[1:]), 1):
        if len(row_a) != len(row_b):
            return False, f"row {n}: column count changed"
        for col, va, vb in zip(header, row_a, row_b):
            if va == vb:
                continue
            per_comment = name == "participant-votes.csv" and col.isdigit()
            per_group = name == "comment-groups.csv" and re.fullmatch(r"group-[a-z]+-(agrees|disagrees|passes)", col)
            if col not in free and not per_comment and not per_group:
                return False, f"row {n}: identity column {col!r} changed"
            if name == "votes.csv" and str(-int(va or 0)) != vb:
                return False, f"row {n}: vote {va} -> {vb} is not a sign change"
    return True, ""


def sign_shaped(rel: str, v0: Path, v1: Path) -> Tuple[bool, str]:
    """Is the v0/v1 difference of ``rel`` the kind a storage-sign dependence makes?
    Structure is identical to v0 (keys, lengths, types, identity fields, CSV
    header, row count and identity columns); only sign-carrying leaf values differ."""
    x, y = (v0 / rel).read_bytes(), (v1 / rel).read_bytes()
    if rel.endswith(".head.json"):
        a, b = json.loads(x), json.loads(y)
        drop = lambda h: {**h, "headers": {k: v for k, v in h.get("headers", {}).items()
                                           if k not in ("etag", "content-length")}}
        return (drop(a) == drop(b), "status or a header other than etag/content-length changed")
    if rel.endswith(".body"):
        return _same_structure_json(_decode_body(v0, rel), _decode_body(v1, rel))
    if rel.startswith("export/"):
        return _same_structure_csv(rel, x, y)
    if rel.startswith("math/"):
        ha, _, ba = x.partition(b"\n")
        hb, _, bb = y.partition(b"\n")
        if ha != hb:
            return False, "math row identity (zid, math_env, math_tick) changed"
        return _same_structure_json(ba, bb)
    return _same_structure_json(x, y)


def write_pins(out: Path) -> int:
    """Pin today's differing outputs (outside the must-hold families) as the
    expected-red cases. Run only to re-baseline, and review the diff."""
    inventory = expected_inventory()
    v0, v1 = out / "v0", out / "v1"
    a, b = files(v0), files(v1)
    pins: Dict[str, List[str]] = {}
    for rel in sorted(inventory & set(a) & set(b)):
        fam = family(rel)
        if fam not in MUST_HOLD and a[rel].read_bytes() != b[rel].read_bytes():
            pins.setdefault(fam, []).append(rel)
    PINNED_RED.write_text(json.dumps({
        "schema": "vote-gate-expected-red/1",
        "about": "Outputs that differ between v0 and v1 on today's code, pinned file by file (P-078 PR-F). "
                 "A difference elsewhere, or one here that is not sign-shaped, fails the ratchet. "
                 "Delete entries as PR-A/B/C turn them green; never add one to hide a regression.",
        "counts": {fam: len(rels) for fam, rels in sorted(pins.items())},
        "files": pins,
    }, indent=1, sort_keys=True) + "\n")
    print(json.dumps({fam: len(rels) for fam, rels in sorted(pins.items())}))
    return 0


def compare_v1(out: Path, inventory: Optional[Set[str]] = None, pinned: Optional[Set[str]] = None) -> dict:
    """v0 against v1. A difference is accepted only where it is pinned (the file
    is listed in expected-red-v1.json) and sign-shaped; every leg must be complete
    and free of failures. Anything else is a failure of the required ratchet."""
    inventory = expected_inventory() if inventory is None else inventory
    pinned = load_pinned() if pinned is None else pinned
    v0, v1 = out / "v0", out / "v1"
    failures = leg_problems(v0, inventory) + leg_problems(v1, inventory)
    a, b = files(v0) if v0.exists() else {}, files(v1) if v1.exists() else {}
    result = {"leg": "v1", "families": {}, "failures": failures, "now_green": [],
              "missing": sorted((inventory - set(a)) | (inventory - set(b)))}
    for rel in sorted(inventory & set(a) & set(b)):
        fam = family(rel)
        entry = result["families"].setdefault(fam, {"files": 0, "differ": []})
        entry["files"] += 1
        x, y = a[rel].read_bytes(), b[rel].read_bytes()
        if fam == "db":
            ok, why = same_but_sign(x, y)
            if not ok:
                entry["differ"].append(rel)
                failures.append(f"{rel}: {why}")
            continue
        if x == y:
            if rel in pinned:
                result["now_green"].append(rel)
            continue
        entry["differ"].append(rel)
        if fam in MUST_HOLD:
            failures.append(f"{rel}: must-hold family {fam} changed")
        elif rel not in pinned:
            failures.append(f"{rel}: differs but is not a pinned expected-red case")
        else:
            ok, why = sign_shaped(rel, v0, v1)
            if not ok:
                failures.append(f"{rel}: not a sign-shaped difference: {why}")
    for fam, entry in sorted(result["families"].items()):
        entry["status"] = "green" if not entry["differ"] else "red"
        if fam in MUST_HOLD:
            entry["reason"] = "must hold: " + MUST_HOLD[fam]
        elif fam in EXPECTED_RED:
            entry["reason"] = EXPECTED_RED[fam]
    failed_rels = {f.split(":", 1)[0] for f in failures}
    result["unexpected"] = sorted({family(r) for r in failed_rels if "/" in r} |
                                  {f.split(":", 1)[0] for f in failures if f.startswith(("v0:", "v1:"))})
    result["ratchet_ok"] = not failures
    result["green"] = not failures and all(e["status"] == "green" for e in result["families"].values())
    return result


def battery_roundtrip(out: Path) -> List[str]:
    """The battery conversations were loaded from their committed export files
    (agree = +1). At v0 the server's votes.csv for them must give back the same
    (timestamp, comment-id, voter-id, vote) rows: stored row -> export, end to end."""
    import fixtures

    problems = []
    for name, (rel, zid) in fixtures.BATTERY.items():
        committed = next((ROOT / rel).glob("*-votes.csv"))
        exported = out / "v0" / "export" / f"{zid:05d}.votes.csv"
        if not exported.exists():
            problems.append(f"battery/{name}: no export")
            continue
        status, _, body = exported.read_text().partition("\n")
        if status != "status 200":
            problems.append(f"battery/{name}: export {status}")
            continue

        def rows(text):
            return sorted((r["timestamp"], r["comment-id"], r["voter-id"], r["vote"])
                          for r in csv.DictReader(io.StringIO(text)))

        if rows(body) != rows(committed.read_text()):
            problems.append(f"battery/{name}: votes.csv does not reproduce {committed.name}")
    return problems


def check_v0(out: Path, inventory: Optional[Set[str]] = None) -> dict:
    base = out / "v0"
    problems = leg_problems(base, expected_inventory() if inventory is None else inventory)
    engine = json.loads((base / "engine-leg.json").read_text())
    for source, verdict in sorted(engine["replay"].items()):
        if verdict is False:
            problems.append(f"replay/{source}: no longer reproduces its recorded components")
    server = json.loads((base / "_meta" / "server-leg.json").read_text())
    fold = sorted((base / "fold").glob("*.declared.json"))
    if engine.get("fold", {}).get("fold_identity") is not True:
        problems.append("fold: the declared-sign adapter is not the identity at the oracle's own sign")
    problems += battery_roundtrip(out)
    return {"leg": "v0", "replay": engine["replay"], "math_conversations": engine["math"]["conversations"],
            "pca2_cases": server["pca2Cases"], "exports": server["exports"], "folds": len(fold),
            "problems": problems, "green": not problems}


def markdown(v: dict) -> str:
    if v["leg"] == "v0":
        lines = ["## Two-convention gate: v0 (agree = -1, required)", "",
                 f"- pca2 cases recorded: {v['pca2_cases']}; CSV exports: {v['exports']}; "
                 f"math rebuilds: {v['math_conversations']}; folds: {v['folds']}",
                 f"- replay verdicts: `{json.dumps(v['replay'], sort_keys=True)}`",
                 f"- **{'green' if v['green'] else 'RED'}**"]
        lines += [f"  - {p}" for p in v["problems"]]
        return "\n".join(lines) + "\n"
    lines = ["## Two-convention gate: v1 (agree = +1) against v0", "",
             "Expected red until PR-A (convention row) and PR-B/C (chokepoints). "
             "Only a pinned, sign-shaped difference is expected; any other difference, a missing output, "
             "a failed export or an HTTP 5xx fails the required ratchet.", "",
             "| family | files | differing | status | why |", "|---|---|---|---|---|"]
    for fam, e in sorted(v["families"].items()):
        status = e["status"] if e["status"] == "green" else ("UNEXPECTED red" if fam in v["unexpected"] else "expected red (pinned)")
        lines.append(f"| {fam} | {e['files']} | {len(e['differ'])} | {status} | {e.get('reason', '')} |")
    for fam, e in sorted(v["families"].items()):
        if e["differ"]:
            shown = e["differ"][:40]
            lines += ["", f"<details><summary>{fam}: {len(e['differ'])} differing</summary>", "", "```"]
            lines += shown + ([f"... {len(e['differ']) - len(shown)} more"] if len(e["differ"]) > len(shown) else [])
            lines += ["```", "</details>"]
    if v["failures"]:
        lines += ["", f"**Unexpected failures ({len(v['failures'])})** — these fail the required ratchet:", ""]
        lines += [f"- {f}" for f in v["failures"][:60]]
    if v["now_green"]:
        lines += ["", f"Pinned expected-red outputs now green ({len(v['now_green'])}); delete them from "
                  "expected-red-v1.json: " + ", ".join(v["now_green"][:20])]
    return "\n".join(lines) + "\n"


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ratchet = "--ratchet" in sys.argv[1:]
    leg, out = args[0], Path(args[1])
    if "--write-pins" in sys.argv[1:]:
        sys.exit(write_pins(out))
    verdict = check_v0(out) if leg == "v0" else compare_v1(out)
    (out / f"verdict-{leg}.json").write_text(json.dumps(verdict, indent=1, sort_keys=True) + "\n")
    text = markdown(verdict)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if ratchet:
        text = (f"## Two-convention ratchet: {'green' if verdict['ratchet_ok'] else 'RED'}\n\n"
                f"Failures: {len(verdict['failures'])}\n" + "".join(f"- {f}\n" for f in verdict["failures"][:60]))
    if summary:
        with open(summary, "a") as fh:
            fh.write(text)
    print(text)
    if leg == "v1" and verdict["failures"]:
        print(f"{len(verdict['failures'])} UNEXPECTED failure(s); first: {verdict['failures'][:5]}", file=sys.stderr)
    if leg == "v1" and ratchet:
        # Required step: fail on anything but a pinned, sign-shaped difference.
        sys.exit(0 if verdict["ratchet_ok"] else 1)
    if verdict["green"]:
        sys.exit(0)
    sys.exit(EXIT_EXPECTED_RED if leg == "v1" and verdict["ratchet_ok"] else 1)

if __name__ == "__main__":
    main()
