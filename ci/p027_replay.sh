#!/usr/bin/env bash
# Replays the committed characterization baseline (server/characterization/artifacts/
# baseline.json.gz) against this checkout. Never records and never repacks: the
# committed archive is the expected side, byte for byte. Exit 0 only when every
# case completes with zero differences, zero oracle failures and full coverage.
set -euo pipefail
harness=server/characterization
name=${P027_REPLAY_NAME:-committed-baseline}
out=$harness/artifacts/replay-job
: "${COMPOSE_PROJECT_NAME:?set a unique p027 project}"
: "${POLIS_RECOVERY_PG_PORT:?set the isolated port window}"
export P027_NEGATIVE_CONTROLS=0 P027_MARKERS=1
unset P027_ONLY P027_PARITY_ONLY P027_STOP_ON_DIFF
for directory in "$out" "$harness/artifacts/$name" "$harness/artifacts/$name-replay"; do
  if [[ -e "$directory" ]]; then
    echo "Refusing to reuse $directory" >&2
    exit 1
  fi
done
mkdir -p "$out"
cleanup() {
  local rc=$?
  python3 "$harness/run.py" down >"$out/cleanup.log" 2>&1 || rc=1
  exit "$rc"
}
trap cleanup EXIT
node -e 'const c=require("node:crypto"),f=require("node:fs");const d=c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex");if(d!==f.readFileSync(process.argv[2],"utf8").trim())throw Error("committed baseline digest mismatch");console.log("baseline sha256 "+d)' "$harness/artifacts/baseline.json.gz" "$harness/artifacts/baseline.sha256"
started=$(date -u +%s)
rc=0
python3 "$harness/run.py" replay "$name" round6 >"$out/replay.log" 2>&1 || rc=$?
elapsed=$(( $(date -u +%s) - started ))
for file in results.json math-kernel.json census-differences.json snapshot-retries.jsonl report.md; do
  if [[ -f "$harness/artifacts/$name-replay/$file" ]]; then
    cp "$harness/artifacts/$name-replay/$file" "$out/$file"
  fi
done
grep -E '^[0-9]+/[0-9]+ .*(DIFF|status=[0-9]+ [^c])' "$out/replay.log" >"$out/differences.txt" || true
node - "$out" "$rc" "$elapsed" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const [out, rc, elapsed] = process.argv.slice(2);
const file = path.join(out, 'results.json');
const r = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
const summary = r ? {cases: r.cases, plannedCases: r.plannedCases, complete: r.complete, fatal: r.fatal,
  failures: r.failures, differences: r.differences, kernel: r.kernel ?? null,
  censusDifferences: r.censusDifferences ?? 0, coverageMissing: r.coverage.missing,
  exit: Number(rc), elapsedSeconds: Number(elapsed)} : {results: null, exit: Number(rc), elapsedSeconds: Number(elapsed)};
summary.pass = Boolean(r) && Number(rc) === 0 && r.complete && r.failures === 0 && r.differences === 0 &&
  r.coverage.missing === 0 && r.kernel === 'MATCH' && !r.censusDifferences;
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
if (!summary.pass) process.exitCode = 1;
JS
