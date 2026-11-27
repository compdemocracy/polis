#!/usr/bin/env bash
# The routing equation crate's checks (queue-rs/polis-routing-equation):
# format, clippy, its tests, and three rules a reviewer can hold it to: the
# source scan (nothing under src/ reaches files, network, clock, environment,
# threads, processes, output or global state), the dependency rule (at most
# one crate in the workspace depends on it, and only polis-routing-plan; it
# depends on serde and serde_json only), and the unchanged-fixture rule (no golden or fixture file is modified,
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
  # The precomputation benchmark, run once in its smoke mode: a few dozen
  # constructed comments, one run per case, no timing assertion. It fails if
  # a case no longer runs, a draw is not of an eligible candidate, a receipt
  # does not read back, or an edge case ends differently.
  cargo test --locked -p polis-routing-equation --bench routing_precompute -- --smoke
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

# The dependency rule, read from cargo metadata: at most one direct
# dependent in the workspace, and only the adapter crate polis-routing-plan
# (queue-rs/polis-routing-plan); none passes. Every kind of dependency counts:
# normal, dev and build, renamed (`package =`), by path, and target-specific.
# The rule first runs on constructed metadata documents, its witnesses, and
# fails if any of them is judged wrongly; then on the workspace's own.
METADATA="$(mktemp)"
trap 'rm -f "$METADATA"' EXIT
(cd "$CHECK_ROOT/queue-rs" && cargo metadata --format-version 1 --locked --no-deps) > "$METADATA" \
  || fail 'cargo metadata failed'
python3 -I - "$METADATA" "$CHECK_ROOT/queue-rs" <<'PY3' || fail 'the dependency rule failed'
import json, os, sys

ALLOWED = "polis-routing-plan"

def violations(meta, queue_rs):
    crate_dir = os.path.realpath(os.path.join(queue_rs, "polis-routing-equation"))
    allowed_dir = os.path.realpath(os.path.join(queue_rs, ALLOWED))
    members = set(meta["workspace_members"])
    bad, dependents = [], set()
    for pkg in meta["packages"]:
        if pkg["id"] not in members:
            continue
        pkg_dir = os.path.realpath(os.path.dirname(pkg["manifest_path"]))
        if pkg["name"] == "polis-routing-equation" or pkg_dir == crate_dir:
            deps = sorted((d["name"], d["kind"]) for d in pkg["dependencies"])
            if deps != [("serde", None), ("serde_json", None)]:
                bad.append(f"its dependencies are {deps}, not serde and serde_json")
            continue
        for d in pkg["dependencies"]:
            path = d.get("path")
            if (d["name"] == "polis-routing-equation" or d.get("rename") == "polis-routing-equation"
                    or (path and os.path.realpath(path) == crate_dir)):
                kind = d["kind"] or "normal"
                where = f" for {d['target']}" if d.get("target") else ""
                if pkg["name"] == ALLOWED and pkg_dir == allowed_dir:
                    dependents.add(pkg["name"])
                else:
                    bad.append(f"{pkg['name']} depends on it ({kind}{where}); only {ALLOWED} may")
    if len(dependents) > 1:
        bad.append(f"more than one direct dependent: {sorted(dependents)}")
    return bad

# The witnesses: constructed metadata, each judged as it must be.
ROOT = "/constructed/queue-rs"
def pkg(name, deps, folder=None):
    return {"id": name, "name": name, "dependencies": deps,
            "manifest_path": f"{ROOT}/{folder or name}/Cargo.toml"}
def dep(kind=None, rename=None, target=None, name="polis-routing-equation", path=True):
    return {"name": name, "kind": kind, "rename": rename, "target": target,
            "path": f"{ROOT}/polis-routing-equation" if path else None}
library = pkg("polis-routing-equation", [dep(name="serde", path=False), dep(name="serde_json", path=False)])
def doc(*pkgs):
    every = (library,) + pkgs
    return {"packages": list(every), "workspace_members": [p["id"] for p in every]}
witnesses = [
    ("none", doc(pkg("polis-api", [])), True),
    ("polis-routing-plan, normal", doc(pkg("polis-routing-plan", [dep()])), True),
    ("polis-routing-plan, normal and dev", doc(pkg("polis-routing-plan", [dep(), dep(kind="dev")])), True),
    ("polis-api, normal", doc(pkg("polis-api", [dep()])), False),
    ("polis-api, renamed", doc(pkg("polis-api", [dep(rename="equation")])), False),
    ("polis-api, dev", doc(pkg("polis-api", [dep(kind="dev")])), False),
    ("polis-api, build", doc(pkg("polis-api", [dep(kind="build")])), False),
    ("polis-api, target-specific", doc(pkg("polis-api", [dep(target="cfg(unix)")])), False),
    ("polis-api, by path under another name", doc(pkg("polis-api", [dep(name="other")])), False),
    ("polis-routing-plan and polis-api", doc(pkg("polis-routing-plan", [dep()]), pkg("polis-api", [dep()])), False),
    ("a package named polis-routing-plan in another folder", doc(pkg("polis-routing-plan", [dep()], folder="elsewhere")), False),
    ("the library with a third dependency", {"packages": [pkg("polis-routing-equation", library["dependencies"] + [dep(name="rand", path=False)])],
                                             "workspace_members": ["polis-routing-equation"]}, False),
]
wrong = [name for name, meta, passes in witnesses if (not violations(meta, ROOT)) != passes]
if wrong:
    print("the dependency rule judges these witnesses wrongly: " + "; ".join(wrong)); sys.exit(1)
print(f"dependency rule witnesses: {len(witnesses)} judged as expected")

with open(sys.argv[1]) as f:
    meta = json.load(f)
bad = violations(meta, sys.argv[2])
if bad:
    print("\n".join(bad)); sys.exit(1)
PY3
echo 'dependency rule: no dependent in the workspace but polis-routing-plan; dependencies serde and serde_json'

# The unchanged-fixture rule, against the pull request base (GITHUB_BASE_REF
# on hosted runs, origin/edge locally, ROUTING_EQUATION_BASE to override). The
# comparison is from the merge base to the working tree, so an uncommitted
# change counts too. A base that cannot be found fails; it is never skipped.
BASE="${ROUTING_EQUATION_BASE:-}"
if [ -z "$BASE" ]; then
  if [ -n "${GITHUB_BASE_REF:-}" ]; then BASE="origin/$GITHUB_BASE_REF"; else BASE=origin/edge; fi
fi
MERGE_BASE="$(git -C "$CHECK_ROOT" merge-base "$BASE" HEAD 2>/dev/null)" || fail "cannot find the base $BASE (fetch it; the check never skips)"
# Two files are exempt: the binding, which moves to a new rule version in the
# change that adds that version's fixture, and the checksum list, which may
# only grow (checked below).
CHANGED="$(git -C "$CHECK_ROOT" diff --name-status --diff-filter=MDR "$MERGE_BASE" -- "$CRATE/tests/golden" "$CRATE/tests/fixtures" \
  ":(exclude)$CRATE/tests/fixtures/SHA256SUMS" ":(exclude)$CRATE/tests/fixtures/CURRENT_PYTHON_RULE")"
[ -z "$CHANGED" ] || fail "golden or fixture files changed against $BASE (add a new rule version instead):
$CHANGED"
echo "unchanged-fixture rule: nothing modified, deleted or renamed against $BASE"
REMOVED="$(git -C "$CHECK_ROOT" diff --unified=0 "$MERGE_BASE" -- "$CRATE/tests/fixtures/SHA256SUMS" | grep -E '^-[^-]' || true)"
[ -z "$REMOVED" ] || fail "tests/fixtures/SHA256SUMS lost or changed a line against $BASE (it may only grow):
$REMOVED"
FIXTURES="$CHECK_ROOT/$CRATE/tests/fixtures"
python3 -I - "$FIXTURES" <<'PY2' || fail "the fixture checksums or the binding do not hold"
import hashlib, os, sys
root = sys.argv[1]
listed = {}
with open(os.path.join(root, "SHA256SUMS")) as f:
    for line in f:
        digest, name = line.rstrip("\n").split("  ", 1)
        listed[name] = digest
on_disk = set()
for d, _, files in os.walk(root):
    for n in files:
        rel = os.path.relpath(os.path.join(d, n), root)
        if rel not in ("SHA256SUMS", "CURRENT_PYTHON_RULE") and "__pycache__" not in rel:
            on_disk.add(rel)
assert on_disk == set(listed), f"files and SHA256SUMS differ: {sorted(on_disk ^ set(listed))}"
for name, digest in listed.items():
    with open(os.path.join(root, name), "rb") as f:
        assert hashlib.sha256(f.read()).hexdigest() == digest, f"{name}: SHA-256 differs"
rule, path, digest = open(os.path.join(root, "CURRENT_PYTHON_RULE")).read().split()
assert digest == "sha256:" + listed[path], "the binding names a fixture by a digest it does not have"
print(f"fixture checksums: {len(listed)} files match; binding {rule} -> {path}")
PY2
