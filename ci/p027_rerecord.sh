#!/usr/bin/env bash
# Invoked from the immutable target checkout. The driver may come from another ref.
set -euo pipefail
control_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target_root=$(pwd)
harness=server/characterization
out=$harness/artifacts/rerecord-job
: "${COMPOSE_PROJECT_NAME:?set a unique p027 project}"
: "${POLIS_RECOVERY_PG_PORT:?set the isolated port window}"
export BUILDX_CONFIG=${BUILDX_CONFIG:-${TMPDIR:-/tmp}/$COMPOSE_PROJECT_NAME-buildx}
export P027_NEGATIVE_CONTROLS=0 P027_MARKERS=1
unset P027_ONLY P027_PARITY_ONLY P027_RECORDING P027_STOP_ON_DIFF
if [[ -e "$out" ]]; then
  echo 'Refusing to reuse an existing job output directory' >&2
  exit 1
fi
for directory in recording rerecord-fresh rerecord-fresh-replay; do
  if [[ -e "$harness/artifacts/$directory" ]]; then
    echo "Refusing stale recording/replay directory: $directory" >&2
    exit 1
  fi
done
mkdir -p "$out"
cp "$harness/artifacts/baseline.json.gz" "$out/previous.json.gz"
cp "$harness/artifacts/baseline.sha256" "$out/previous.sha256"
# Local and workflow teardown both go through the same ownership guard.
cleanup() {
  local rc=$?
  python3 "$harness/run.py" down >"$out/cleanup.log" 2>&1 || rc=1
  cp "$out/previous.json.gz" "$harness/artifacts/baseline.json.gz"
  cp "$out/previous.sha256" "$harness/artifacts/baseline.sha256"
  exit "$rc"
}
trap cleanup EXIT
stage() {
  local label=$1 rc=0
  shift
  "$@" >"$out/$label.log" 2>&1 || rc=$?
  printf '%s\n' "$rc" >"$out/$label.exit"
  tail -n 8 "$out/$label.log"
  return "$rc"
}
if [[ ${1:-} != --reuse-images ]]; then
  # Fixed historical image names are safe only on an ephemeral hosted runner.
  [[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
  stage build bash "$control_root/ci/p027_rerecord_build.sh"
fi
node "$harness/baseline.cjs" "$out/previous"
# A failed/partial record is diagnostic only; do not pack it as a candidate.
stage record python3 "$harness/run.py" record recording round6
stage accounting node "$control_root/server/characterization/rerecord-accounting.cjs" \
  "$target_root" "$out/previous" "$harness/artifacts/recording" "$out/accounting.json"
stage pack node "$harness/baseline.cjs" pack "$harness/artifacts/recording"
cp "$harness/artifacts/baseline.json.gz" "$out/baseline.json.gz"
cp "$harness/artifacts/baseline.sha256" "$out/baseline.sha256"
# Exact round trip of the candidate, independently of the baseline unit suite.
node "$harness/baseline.cjs" "$out/repacked"
node - "$target_root" "$out" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const [root, out] = process.argv.slice(2);
const {pack} = require(path.join(root, 'server/characterization/baseline.cjs'));
const digest = pack(path.join(out, 'repacked'), path.join(out, 'repacked.json.gz'));
if (digest !== fs.readFileSync(path.join(out, 'baseline.sha256'), 'utf8').trim()) throw Error('non-deterministic repack');
fs.writeFileSync(path.join(out, 'repack.json'), JSON.stringify({sha256: digest, identical: true}) + '\n');
JS
stage record-down python3 "$harness/run.py" down
failed=0
# Preserve any replay differences (including r19/r20) and still run the controls.
stage replay python3 "$harness/run.py" replay rerecord-fresh round6 || failed=1
if [[ -f "$harness/artifacts/rerecord-fresh-replay/results.json" ]]; then
  cp "$harness/artifacts/rerecord-fresh-replay/results.json" "$out/replay-results.json"
  cp "$harness/artifacts/rerecord-fresh-replay/comparisons.actual.jsonl" "$out/replay-comparisons.jsonl"
fi
cp "$harness/artifacts/recording/results.json" "$out/record-results.json"
stage node-tests python3 "$harness/run.py" test || failed=1
stage python-tests python3 -m unittest discover -s "$harness" -p 'test_*.py' || failed=1
stage negative python3 "$harness/negative.py" || failed=1
if [[ -f "$harness/artifacts/negative-controls.json" ]]; then
  cp "$harness/artifacts/negative-controls.json" "$out/negative-controls.json"
fi
node - "$out" "$failed" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const [out, failed] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(path.join(out, 'accounting.json')));
const checks = Object.fromEntries(['record','accounting','pack','record-down','replay','node-tests','python-tests','negative'].map(k =>
  [k, Number(fs.readFileSync(path.join(out, k + '.exit'), 'utf8'))]));
const readJson = name => JSON.parse(fs.readFileSync(path.join(out, name + '.json')));
const record = readJson('record-results'), replay = readJson('replay-results');
const controls = readJson('negative-controls');
const expectedControls = ['response','effect','remove-route','hang-route','error-route','exit-route','real-email-loop','unobserved-network-egress'];
const evidencePass = record.cases > 0 && record.failures === 0 &&
  record.cases === a.counts.unchanged + a.counts.changed + a.counts.added &&
  replay.cases === record.cases && replay.failures === 0 && replay.differences === 0 &&
  replay.coverage.missing === 0 && controls.length === expectedControls.length &&
  controls.every((c,i) => c.control === expectedControls[i] && c.exit === (i < 6 ? 1 : 0));
const result = {target: a.target, base: a.base, baseResolution: a.baseResolution, record: {cases: record.cases, failures: record.failures},
  replay: {cases: replay.cases, failures: replay.failures, differences: replay.differences},
  negativeControls: controls.length, evidencePass, archiveSha256: fs.readFileSync(path.join(out,'baseline.sha256'),'utf8').trim(),
  counts: a.counts, checks, reviewEligible: a.reviewEligible && failed === '0' && evidencePass, autoMerge: false};
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
if (!result.reviewEligible) process.exitCode = 1;
JS
