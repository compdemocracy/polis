#!/usr/bin/env bash
# The routing plan crate's checks (queue-rs/polis-routing-plan, the frames
# adapter): format, clippy, its tests, and two rules a reviewer can hold it
# to: the source scan (nothing under src/ reaches files, network, clock,
# environment, threads, processes, output or global state; the same list as
# the routing equation crate's) and the dependency rule (it depends on
# polis-routing-equation, serde, serde_json and sha2, and nothing else). They
# are review aids, not a proof: someone editing this script defeats them.
. "$(dirname "$0")/runtime.sh"

CRATE=queue-rs/polis-routing-plan
fail() { printf 'check-polis-routing-plan: %s\n' "$*" >&2; exit 1; }

(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
  cargo fmt -p polis-routing-plan --check
  cargo clippy --locked -p polis-routing-plan --all-targets -- -D warnings
  cargo test --locked -p polis-routing-plan
)

# The source scan.
python3 -I - "$CHECK_ROOT/$CRATE/src" <<'PY' || fail 'the source scan found a forbidden item under src/'
import pathlib, re, sys
forbidden = [r"std::fs", r"std::net", r"std::time", r"std::env", r"std::thread", r"std::process",
             r"std::io::stdout", r"std::io::stderr", r"std::\{", r"\b(?:e?print(?:ln)?|dbg)!",
             r"\bstatic\s+mut\b", r"\bthread_local!", r"\bunsafe\b", r"\brand\b", r"\btokio\b",
             r"\bpostgres\b", r"\bstd::io\b"]
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

# The dependency rule, read from cargo metadata: the crate's direct
# dependencies of every kind are exactly these four.
METADATA="$(mktemp)"
trap 'rm -f "$METADATA"' EXIT
(cd "$CHECK_ROOT/queue-rs" && cargo metadata --format-version 1 --locked --no-deps) > "$METADATA" \
  || fail 'cargo metadata failed'
python3 -I - "$METADATA" <<'PY3' || fail 'the dependency rule failed'
import json, sys
ALLOWED = {"polis-routing-equation", "serde", "serde_json", "sha2"}
meta = json.load(open(sys.argv[1]))
pkgs = [p for p in meta["packages"] if p["name"] == "polis-routing-plan"]
if len(pkgs) != 1:
    sys.exit(f"expected one polis-routing-plan package, found {len(pkgs)}")
deps = {d["name"] for d in pkgs[0]["dependencies"]}
if deps != ALLOWED:
    sys.exit(f"dependencies {sorted(deps)} are not exactly {sorted(ALLOWED)}")
print("dependency rule: polis-routing-plan depends on " + ", ".join(sorted(deps)))
PY3
