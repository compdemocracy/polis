#!/usr/bin/env bash
# The routing equation crate's checks (queue-rs/polis-routing-equation):
# format, clippy, its tests, and three rules a reviewer can hold it to: the
# source scan (nothing under src/ reaches files, network, clock, environment,
# threads, processes, output or global state), the dependency rule (nothing
# else in the workspace depends on it; it depends on serde and serde_json
# only), and the unchanged-fixture rule (no golden or fixture file is modified,
# deleted or renamed against the base). They are review aids, not a proof:
# someone editing this script defeats them.
. "$(dirname "$0")/runtime.sh"

CRATE=queue-rs/polis-routing-equation
fail() { printf 'check-polis-routing-equation: %s\n' "$*" >&2; exit 1; }

(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
  cargo fmt -p polis-routing-equation --check
  cargo clippy --locked -p polis-routing-equation --all-targets -- -D warnings
  # The grid and draw tests print their counts; --nocapture shows them.
  cargo test --locked -p polis-routing-equation -- --nocapture
)

# The source scan.
python3 -I - "$CHECK_ROOT/$CRATE/src" <<'PY' || fail 'the source scan found a forbidden item under src/'
import pathlib, re, sys
forbidden = [r"std::fs", r"std::net", r"std::time", r"std::env", r"std::thread", r"std::process",
             r"std::io::stdout", r"std::io::stderr", r"std::\{", r"\b(?:e?print(?:ln)?|dbg)!",
             r"\bstatic\s+mut\b", r"\bthread_local!", r"\bunsafe\b", r"\brand\b", r"\btokio\b",
             r"\bpostgres\b"]
found = 0
for path in sorted(pathlib.Path(sys.argv[1]).rglob("*.rs")):
    for number, line in enumerate(path.read_text().splitlines(), 1):
        for pattern in forbidden:
            if re.search(pattern, line):
                print(f"{path}:{number}: {pattern}: {line.strip()}")
                found += 1
sys.exit(1 if found else 0)
PY
echo 'source scan: nothing forbidden under src/'

# The dependency rule, read from cargo metadata.
(cd "$CHECK_ROOT/queue-rs" && cargo metadata --format-version 1 --locked --no-deps) \
  | python3 -I -c '
import json, os, sys
meta = json.load(sys.stdin)
crate_dir = os.path.realpath(sys.argv[1])
members = set(meta["workspace_members"])
bad = []
for pkg in meta["packages"]:
    if pkg["id"] not in members:
        continue
    if pkg["name"] == "polis-routing-equation":
        deps = sorted((d["name"], d["kind"]) for d in pkg["dependencies"])
        if deps != [("serde", None), ("serde_json", None)]:
            bad.append(f"its dependencies are {deps}, not serde and serde_json")
        continue
    for d in pkg["dependencies"]:
        path = d.get("path")
        if (d["name"] == "polis-routing-equation" or d.get("rename") == "polis-routing-equation"
                or (path and os.path.realpath(path) == crate_dir)):
            bad.append(pkg["name"] + " depends on it")
if bad:
    print("\n".join(bad)); sys.exit(1)
' "$CHECK_ROOT/$CRATE" || fail 'the dependency rule failed'
echo 'dependency rule: no caller in the workspace; dependencies serde and serde_json'

# The unchanged-fixture rule, against the pull request base (GITHUB_BASE_REF
# on hosted runs, origin/edge locally, ROUTING_EQUATION_BASE to override). The
# comparison is from the merge base to the working tree, so an uncommitted
# change counts too. A base that cannot be found fails; it is never skipped.
BASE="${ROUTING_EQUATION_BASE:-}"
if [ -z "$BASE" ]; then
  if [ -n "${GITHUB_BASE_REF:-}" ]; then BASE="origin/$GITHUB_BASE_REF"; else BASE=origin/edge; fi
fi
MERGE_BASE="$(git -C "$CHECK_ROOT" merge-base "$BASE" HEAD 2>/dev/null)" || fail "cannot find the base $BASE (fetch it; the check never skips)"
CHANGED="$(git -C "$CHECK_ROOT" diff --name-status --diff-filter=MDR "$MERGE_BASE" -- "$CRATE/tests/golden" "$CRATE/tests/fixtures")"
[ -z "$CHANGED" ] || fail "golden or fixture files changed against $BASE (add a new rule version instead):
$CHANGED"
echo "unchanged-fixture rule: nothing modified, deleted or renamed against $BASE"
