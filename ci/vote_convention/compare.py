"""Verdicts of the two-convention gate (P-078 PR-F).

    python ci/vote_convention/compare.py v0 OUT        # the required leg
    python ci/vote_convention/compare.py v1 OUT        # v0 against v1

``v0`` checks the leg recorded at today's convention on its own: every leg ran,
the replay fixtures still reproduce their recorded components, the declared-sign
fold companion is the identity at the oracle's own sign, the public battery
exports back to its committed votes file, and no export failed.

``v1`` compares OUT/v0 with OUT/v1 byte for byte. Exactly one field is
normalised: ``vote`` of the stored rows (``db/``), which must differ by sign and
in nothing else. Every other output (pca2 bodies and heads, every CSV export,
math_main / math_bidtopid / math_ptptstats, the replay cuts, both folds) must be
byte-identical: the export sign is fixed at +1 and the engines are meant to read
the convention, not assume it. Until PR-A (the convention row) and PR-B/C (the
chokepoints) land, they do not, and this comparison fails. EXPECTED_RED names
every family that is red today and why; a red outside it is a regression.

    python ci/vote_convention/compare.py v1 OUT --ratchet   # required in CI

Writes OUT/verdict-<leg>.json and a Markdown summary (to $GITHUB_STEP_SUMMARY
when set). Exit status: 0 fully green; 3 (v1 only) red, but every red family is
on EXPECTED_RED; 1 anything else. ``--ratchet`` exits 0 for 0 or 3 and 1
otherwise: the required step, while the strict comparison stays informative.
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple

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
    "fold/direct": "PR-G (retire or wrap): the frozen fold oracle reads raw rows at its own literal RAW_AGREE = -1. "
                   "Its declared-sign companion (fold/declared) is the form every caller moves to.",
}

#: Exit status of ``compare.py v1`` when every red is expected (1 = an unexpected red).
EXIT_EXPECTED_RED = 3

#: Families that must be green at v1 even today: the fixture loader, the
#: companions, and the outputs no vote value reaches or that are sign-blind.

MUST_HOLD: Dict[str, str] = {
    "db": "the loader writes the opposite sign and nothing else",
    "fold/declared": "the declared-sign companion of the fold oracle",
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


def compare_v1(out: Path) -> dict:
    a, b = files(out / "v0"), files(out / "v1")
    result = {"leg": "v1", "families": {}, "unexpected": [], "missing": sorted(set(a) ^ set(b))}
    for rel in sorted(set(a) & set(b)):
        fam = family(rel)
        entry = result["families"].setdefault(fam, {"files": 0, "differ": []})
        entry["files"] += 1
        x, y = a[rel].read_bytes(), b[rel].read_bytes()
        if fam == "db":
            ok, why = same_but_sign(x, y)
            if not ok:
                entry["differ"].append(f"{rel}: {why}")
        elif x != y:
            entry["differ"].append(rel)
    for fam in list(MUST_HOLD) + list(EXPECTED_RED):
        if fam not in result["families"]:  # a family that vanished is a regression too
            result["unexpected"].append(fam)
    for fam, entry in sorted(result["families"].items()):
        entry["status"] = "green" if not entry["differ"] else "red"
        if fam in MUST_HOLD:
            entry["reason"] = "must hold: " + MUST_HOLD[fam]
        elif fam in EXPECTED_RED:
            entry["reason"] = EXPECTED_RED[fam]
        if entry["differ"] and (fam in MUST_HOLD or fam not in EXPECTED_RED):
            result["unexpected"].append(fam)
    result["green"] = not result["unexpected"] and not result["missing"] and all(
        e["status"] == "green" for e in result["families"].values())
    # Lists of failing cases are the evidence; keep them but cap the summary.
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


def check_v0(out: Path) -> dict:
    base = out / "v0"
    problems = []
    engine = json.loads((base / "engine-leg.json").read_text())
    for source, verdict in sorted(engine["replay"].items()):
        if verdict is False:
            problems.append(f"replay/{source}: no longer reproduces its recorded components")
    server = json.loads((base / "_meta" / "server-leg.json").read_text())
    if server["pca2Cases"] != 336:
        problems.append(f"pca2: {server['pca2Cases']} cases recorded, 336 expected")
    if server["exportFailures"]:
        problems.append(f"export: {server['exportFailures']} exports failed")
    fold = sorted((base / "fold").glob("*.direct.json"))
    for direct in fold:
        declared = direct.with_name(direct.name.replace(".direct.", ".declared."))
        if direct.read_bytes() != declared.read_bytes():
            problems.append(f"fold/{direct.name}: the declared companion is not the identity at the oracle's sign")
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
             "A red family outside the expected list, or a red `db` / `fold/declared`, is a regression.", "",
             "| family | files | differing | status | why |", "|---|---|---|---|---|"]
    for fam, e in sorted(v["families"].items()):
        status = e["status"] if e["status"] == "green" else ("UNEXPECTED red" if fam in v["unexpected"] else "expected red")
        lines.append(f"| {fam} | {e['files']} | {len(e['differ'])} | {status} | {e.get('reason', '')} |")
    for fam, e in sorted(v["families"].items()):
        if e["differ"]:
            shown = e["differ"][:40]
            lines += ["", f"<details><summary>{fam}: {len(e['differ'])} differing</summary>", "", "```"]
            lines += shown + ([f"... {len(e['differ']) - len(shown)} more"] if len(e["differ"]) > len(shown) else [])
            lines += ["```", "</details>"]
    if v["missing"]:
        lines += ["", f"Outputs present on one side only: {', '.join(v['missing'][:20])}"]
    return "\n".join(lines) + "\n"


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--ratchet"]
    ratchet = "--ratchet" in sys.argv[1:]
    leg, out = args[0], Path(args[1])
    verdict = check_v0(out) if leg == "v0" else compare_v1(out)
    (out / f"verdict-{leg}.json").write_text(json.dumps(verdict, indent=1, sort_keys=True) + "\n")
    text = markdown(verdict)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if ratchet:
        text = (f"## Two-convention ratchet: {'green' if not verdict['unexpected'] and not verdict['missing'] else 'RED'}\n\n"
                f"Unexpected red families: {verdict['unexpected'] or 'none'}; one-sided outputs: {len(verdict['missing'])}\n")
    if summary:
        with open(summary, "a") as fh:
            fh.write(text)
    print(text)
    if leg == "v1" and verdict["unexpected"]:
        print(f"UNEXPECTED red families: {verdict['unexpected']}", file=sys.stderr)
    if leg == "v1" and ratchet:
        # Required step: fail only on a red that is not on the expected list
        # (or a must-hold family, or an output present on one side only).
        sys.exit(0 if not verdict["unexpected"] and not verdict["missing"] else 1)
    if verdict["green"]:
        sys.exit(0)
    sys.exit(EXIT_EXPECTED_RED if leg == "v1" and not verdict["unexpected"] and not verdict["missing"] else 1)


if __name__ == "__main__":
    main()
