#!/usr/bin/env python3
"""The vote-sign literal lint (P-078 PR-F, plan §1c.4).

    python3 ci/vote_convention/sign_lint.py            # check the tree (CI)
    python3 ci/vote_convention/sign_lint.py --list     # print every current hit

A *vote-sign literal* is a sign constant or sign test that sits within WINDOW
lines of the word ``vote``: a bare ``-1``, ``* -1``, an equality against ``±1``
(``=== 1``, ``== -1``, ``!== -1``, SQL ``vote = 1``), a sign test (``vote < 0``,
``0 > vote``) or a negated vote (``-row.vote``, ``-vote``, ``-int(r['vote'])``,
``vote=-v``, ``0 - vote``, Clojure ``(- (long sign))``). Each one restates the storage or
wire sign instead of asking the one place that owns it.

Outside the chokepoint modules (CHOKEPOINTS) every hit must be in the allowlist
``sign-literal-allowlist.json``. The allowlist was seeded from today's tree and
the 350-row vote-sign audit of 2026-10-03; each entry carries its audit row.
Entries are keyed by path and the whitespace-normalised line text (not the line
number) with a count, so edits elsewhere in a file never trip the lint, while
any NEW literal, or one more copy of an allowlisted line, fails it.

Allowlisted sites that disappear are reported as stale (not a failure); the PRs
that move a site into a chokepoint delete its entry. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST = Path(__file__).resolve().with_name("sign-literal-allowlist.json")

#: Lines on either side of a hit that are searched for the word ``vote``.
WINDOW = 3

#: The modules that own the sign. A literal there is the declaration itself.
#: Paths that do not exist yet are the chokepoints their PRs create (plan §1b).
CHOKEPOINTS: Dict[str, str] = {
    "server/src/votes/convention.ts": "server chokepoints 1 and 2 (PR-B, in flight)",
    "delphi/polismath/utils/vote_convention.py": "the Python storage convention (chokepoint 3)",
    "coordinator-rs/src/vote_convention.rs": "the Rust StorageConvention (chokepoint 5, PR-C)",
    "client-participation/js/util/voteConvention.js": "legacy client helper (chokepoint 7, PR-D)",
    "client-participation-alpha/src/api/votes.ts": "alpha client helper (chokepoint 8, PR-D)",
    "client-report/src/util/voteCounts.js": "client-report helper (chokepoint 9, PR-D)",
    "ci/vote_convention/provision.py": "the gate's fixture loader: it writes raw values at the convention under test",
    # The lint and its test spell the patterns they look for.
    "ci/vote_convention/sign_lint.py": "this lint (its patterns)",
    "ci/vote_convention/test_gate.py": "this lint's test (its inputs)",
}

SOURCE_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py", ".rs", ".clj", ".cljs", ".cljc",
    ".sql", ".sh", ".txt",
}
#: Generated or vendored bytes, never hand-edited.
SKIP = re.compile(r"(^|/)(node_modules|dist|build|vendor|\.astro)/|\.min\.js$|(^|/)package-lock\.json$")

PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("times-minus-one", re.compile(r"\*\s*-\s*1(?![\d.])|\(\*\s+-1(?![\d.])")),
    # Equality against -1 anywhere in the window; against +1 only on a line that names the vote
    # (``len(x) == 1`` is not a sign).
    ("equals-minus-one", re.compile(r"[!=]==?\s*-\s*1(?![\d.\w])|(?<![\w.])-1\s*[!=]==?(?!=)")),
    ("equals-one", re.compile(r"(?i)vote\w*(?:\[[^\]]*\]|\.\w+)*\s*[!=]==?\s*\+?1(?![\d.\w])"
                              r"|(?<![\w.\-])\+?1\s*[!=]==?\s*[\w.]*vote")),
    ("sign-test", re.compile(r"(?<![\w])(?:\w+\.)?vote(?:_?val(?:ue)?)?\s*[<>]=?\s*0(?![\d.])"
                             r"|(?<![\w.])0\s*[<>]=?\s*(?:\w+\.)?vote\b")),
    ("negated-vote", re.compile(r"(?<![\w)\]\-])-\(?(?:[\w\[\]'\"]+\.)*vote\b(?!-)")),
    # -int(r['vote']), -v['vote'], -r[:vote], 0 - vote
    ("negated-subscript", re.compile(r"(?<![\w)\]\-])-\s*(?:\w+\()*[\w.]*\[\s*['\"]?:?vote\w*['\"]?\s*\]"
                                     r"|(?<![\w.])0\s*-\s*\(?[\w.\[\]'\"]*vote", re.I)),
    # vote=-v, 'vote': -sign, :vote (- ...)
    ("assigned-negation", re.compile(r"vote\w*['\"]?\s*(?<![=!<>])(?:=|:)(?!=)\s*-\s*\(?[A-Za-z_]", re.I)),
    # Clojure unary minus: (- x), (- (long sign))
    ("clojure-negation", re.compile(r"\(-\s+(?:\([\w\-.]+\s+[\w\-.?!*]+\)|[\w\-.?!*]+)\s*\)")),
    # SQL single '=' against a sign: vote = 1, vote=-1
    ("sql-equals-sign", re.compile(r"\bvote\s*(?<![=!<>])=(?!=)\s*[-+]?\s*1(?![\d.\w])", re.I)),
    ("minus-one", re.compile(r"(?<![\w.\-)\]])-1(?![\d.\w])")),
]
#: Index and shape idioms that spell -1 without meaning a vote.
NOT_A_SIGN = re.compile(r"\[\s*-1\s*\]|\[\s*:\s*-1\s*\]|::-1|:-1\]|\[-1:|reshape\([^)]*-1|axis\s*=\s*-1"
                        r"|(?:indexOf|findIndex|lastIndexOf|search|find)\([^)]*\)\s*[!=]==?\s*-1"
                        r"|-1\s*[!=]==?\s*\w+\.(?:indexOf|findIndex)\(")
VOTE = re.compile(r"vote", re.I)


def tracked(root: Path = ROOT) -> List[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True).stdout
    return [p for p in out.decode().split("\0") if p]


def in_scope(path: str) -> bool:
    if SKIP.search(path) or Path(path).suffix not in SOURCE_SUFFIXES:
        return False
    if path.endswith(".txt") and "/pinned/" not in path:
        return False  # only the pinned oracle sources are .txt code
    return not any(path == c or (c.endswith("/") and path.startswith(c)) for c in CHOKEPOINTS)


def normalise(line: str) -> str:
    return " ".join(line.split())


def classify(line: str) -> Optional[str]:
    """The first sign-literal pattern the line matches, or None."""
    probe = NOT_A_SIGN.sub(" ", line)
    return next((name for name, rx in PATTERNS if rx.search(probe)), None)


def hits(path: str, root: Path = ROOT) -> Iterator[Tuple[int, str, str]]:
    try:
        lines = (root / path).read_text(encoding="utf-8").splitlines()
    except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
        return
    if not any(VOTE.search(line) for line in lines):
        return
    for i, line in enumerate(lines):
        if len(line) > 400:  # data blobs, not code
            continue
        kind = classify(line)
        if not kind:
            continue
        lo, hi = max(0, i - WINDOW), min(len(lines), i + WINDOW + 1)
        if any(VOTE.search(lines[j]) for j in range(lo, hi)):
            yield i + 1, normalise(line), kind


def scan(root: Path = ROOT) -> Dict[Tuple[str, str], List[Tuple[int, str]]]:
    found: Dict[Tuple[str, str], List[Tuple[int, str]]] = {}
    for path in tracked(root):
        if in_scope(path):
            for lineno, text, kind in hits(path, root):
                found.setdefault((path, text), []).append((lineno, kind))
    return found


def load_allowlist() -> Dict[Tuple[str, str], dict]:
    data = json.loads(ALLOWLIST.read_text())
    return {(e["path"], e["text"]): e for e in data["entries"]}


def main(argv: Optional[List[str]] = None, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="print every current hit as JSON lines")
    args = parser.parse_args(argv)
    found = scan(root)
    if args.list:
        for (path, text), where in sorted(found.items()):
            print(json.dumps({"path": path, "text": text, "lines": [n for n, _ in where],
                              "kind": where[0][1], "count": len(where)}))
        return 0
    allowed = load_allowlist()
    new, stale = [], []
    for key, where in sorted(found.items()):
        entry = allowed.get(key)
        limit = entry["count"] if entry else 0
        if len(where) > limit:
            for lineno, kind in where[limit:] if entry else where:
                new.append(f"{key[0]}:{lineno}: [{kind}] {key[1]}")
    for key, entry in sorted(allowed.items()):
        if len(found.get(key, [])) < entry["count"]:
            stale.append(f"{key[0]}: {entry['text']}  ({entry['audit']})")
    print(f"vote-sign lint: {sum(len(w) for w in found.values())} sites in scope, "
          f"{sum(e['count'] for e in allowed.values())} allowlisted ({len(allowed)} entries), "
          f"{len(new)} new, {len(stale)} stale")
    for s in stale:
        print(f"  stale (delete the allowlist entry): {s}")
    if new:
        print("\nNew vote-sign literal(s). Take the sign from the chokepoint of your layer instead:")
        for c, why in CHOKEPOINTS.items():
            print(f"  {c}  ({why})")
        print("")
        for n in new:
            print(f"::error::{n}" if "GITHUB_ACTIONS" in os.environ else n)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
