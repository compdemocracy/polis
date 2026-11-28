#!/usr/bin/env bash
# The routing plan crate's checks (queue-rs/polis-routing-plan, the frames
# adapter): format, clippy, its tests, and two rules a reviewer can hold it
# to: the source scan (nothing under src/ reaches files, network, clock,
# environment, threads, processes, output or global state; the same list as
# the routing equation crate's; build.rs, which runs at build time only and
# reads the compiler's release, is outside it) and the dependency rule (it depends on
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
  # Under any rustc but the reviewed one (src/reserve.rs, REVIEWED_RUSTC),
  # every bound that rests on the standard library's implementation refuses.
  # The build script can be told to name no release, which is how that
  # refusal is tested under the reviewed rustc; it is rebuilt both ways.
  POLIS_ROUTING_PLAN_UNREVIEWED_STD=1 cargo test --locked -p polis-routing-plan \
    --test btree_bound -- --exact toolchain_gate_matches_the_compiler
)

# The source scan.
python3 -I - "$CHECK_ROOT/$CRATE/src" <<'PY' || fail 'the source scan found a forbidden item under src/'
import pathlib, re, sys
forbidden = [r"std::fs", r"std::net", r"std::time", r"std::env", r"std::thread", r"std::process",
             r"std::io::stdout", r"std::io::stderr", r"std::\{", r"\b(?:e?print(?:ln)?|dbg)!",
             r"\bstatic\s+mut\b", r"\bthread_local!", r"\bunsafe\b", r"\brand\b", r"\btokio\b",
             r"\bpostgres\b", r"\bstd::io\b"]
# Whitespace and aliases must not hide a forbidden standard-library path.
# These remain review aids; they do not replace review of dependencies/macros.
forbidden += [r"\bstd\s*::\s*(?:fs|net|time|env|thread|process|io|sync)\b",
              r"\b(?:std|core)\s*::\s*\{", r"\bcore\s*::\s*sync\b",
              r"\bstd\s*::\s*\*", r"\bstd\s+as\b",
              r"\buse\s+(?:::)?\s*std\s*;", r"\bextern\s+crate\b",
              r"\b(?:include|include_str|include_bytes|env|option_env)\s*!",
              r"(?<!')\bstatic\s+(?:mut\s+)?[A-Za-z_]" ]
def hits(source):
    return [pattern for pattern in forbidden if re.search(pattern, source)]
witnesses = [
    ("use std::collections::BTreeMap;", False),
    ("use std::fmt;", False),
    ("use std as system; system::fs::read_dir(\".\");", True),
    ("use std\nas system;", True),
    ("std :: fs :: read_dir(\".\");", True),
    ("std\n::\nfs::read_dir(\".\");", True),
    ("use std::*;", True),
    ("extern crate std as system;", True),
    ("include!(\"outside.rs\");", True),
    ("static STATE: std::sync::OnceLock<()> = todo!();", True),
]
for source, forbidden_expected in witnesses:
    if bool(hits(source)) != forbidden_expected:
        sys.exit(f"source-scan witness failed: {source!r}")
print(f"source scan witnesses: {len(witnesses)} judged as expected")
found = 0
for path in sorted(pathlib.Path(sys.argv[1]).rglob("*.rs")):
    for pattern in hits(path.read_text()):
        print(f"{path}: {pattern}")
        found += 1
sys.exit(1 if found else 0)
PY
echo 'source scan: nothing forbidden under src/'

# The dependency rule, read from cargo metadata: the crate's direct
# dependencies of every kind are exactly these four.
METADATA="$(mktemp)"
trap 'rm -f "$METADATA"' EXIT
(cd "$CHECK_ROOT/queue-rs" && cargo metadata --format-version 1 --locked --all-features) > "$METADATA" \
  || fail 'cargo metadata failed'
python3 -I - "$METADATA" "$CHECK_ROOT/queue-rs" <<'PY3' || fail 'the dependency rule failed'
import json, os, sys
ALLOWED = {"polis-routing-equation", "serde", "serde_json", "sha2"}
meta = json.load(open(sys.argv[1]))
pkgs = [p for p in meta["packages"] if p["name"] == "polis-routing-plan"]
if len(pkgs) != 1:
    sys.exit(f"expected one polis-routing-plan package, found {len(pkgs)}")
deps = {d["name"] for d in pkgs[0]["dependencies"]}
if deps != ALLOWED:
    sys.exit(f"dependencies {sorted(deps)} are not exactly {sorted(ALLOWED)}")
root = os.path.realpath(sys.argv[2])
pkg = pkgs[0]
if os.path.realpath(os.path.dirname(pkg["manifest_path"])) != os.path.join(root, "polis-routing-plan"):
    sys.exit("the adapter is outside its expected directory")
# Inspect resolved identities as well as declared names. A same-named path
# package or registry patch must not impersonate an allowed dependency.
packages = {p["id"]: p for p in meta["packages"]}
nodes = [n for n in meta["resolve"]["nodes"] if n["id"] == pkg["id"]]
if len(nodes) != 1:
    sys.exit("missing or ambiguous adapter resolution")
for edge in nodes[0]["deps"]:
    target = packages[edge["pkg"]]
    name = target["name"]
    if name not in ALLOWED:
        sys.exit(f"unexpected resolved dependency: {name}")
    if name == "polis-routing-equation":
        if os.path.realpath(os.path.dirname(target["manifest_path"])) != os.path.join(root, name):
            sys.exit("equation dependency is outside its expected directory")
    elif target.get("source") != "registry+https://github.com/rust-lang/crates.io-index":
        sys.exit(f"{name} is not the locked crates.io dependency")
print("dependency rule: polis-routing-plan depends on " + ", ".join(sorted(deps)))
PY3
