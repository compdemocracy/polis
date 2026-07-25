# GOAL: Cutover-ready Python math — mode collapse, clarity, re-certification

Standing autonomous goal (set with Julien, 2026-07-27). Successor to
GOAL_R1_PARITY.md (achieved 2026-07-24 — its DONE evidence stands; this goal
prepares the actual Clojure-off/Python-on switch per Julien's rulings in
POST_CUTOVER_IMPROVEMENTS.md and CUTOVER_RUNBOOK.md). Work session after
session; decide, document, keep going. Propose-then-wait is suspended for
this goal; compensating controls are per-change journal notes and the
walkthrough section in GOAL_STATE at each milestone. Stop only for hard
blockers (broken environment, usage limit, AWS denial — see Constraints).

## DONE means (ALL must hold, evidenced in-repo)

1. **Mode collapse**: the engine has ONE code path — exact legacy semantics.
   Gate: `grep -rn "ENGINE_MODE\|engine_mode\|resolve_engine_mode" delphi/polismath/`
   returns ZERO hits (the flag machinery itself is deleted); improved-only
   branches extracted to parked jj commits (side bookmark `improvements/*`,
   one commit per POST_CUTOVER_IMPROVEMENTS.md queue item) BEFORE deletion.
   Participant-ban filtering DELETED outright (not parked — dropped feature).
   run_delphi.py/job_poller (the API-called pipeline) exercises the same
   single path — no pipeline-only math branches.
2. **Clarity refactor landed PRE-cutover** (Julien ruling 2026-07-27):
   PR 14b/14c — `compute_group_comment_stats_df` reads like the deleted
   scalar recipe; vectorized blob-injection tests green. Bit-identity guarded
   by the battery.
3. **Golden snapshots re-recorded** at the collapse commit (legacy values,
   verified against the certified battery recordings before recording —
   never blind), full regression suite green vs the new baseline.
4. **Battery**: TWO consecutive fully-clean passes (20/20 MATCH, zero open
   ledger entries) on the exact final tree.
5. **Equivalence release gate**: scripts/poller_equiv.py full-run verdict
   PASS (non-vacuous) on vw AND pc-meta-02 on the final tree.
6. **Large-conv EC2 measurement recorded**: one full-PCA tick of the largest
   prodclone conv shape (33k ptpts × 783 cmts; synthesize the shape if
   extraction is impractical) timed on the target EC2 class via the `bench`
   AWS profile; number + verdict (serial OK / needs deterministic
   large-conv path) written into CUTOVER_RUNBOOK.md risk register.
7. GOAL_STATE.md first line flips to `STATUS: DONE` only after 1-6 hold.

A session ending with open ledger entries, an incomplete collapse, or an
unrecorded measurement has made PROGRESS, not achieved the goal.

## Constraints

- Extract-then-delete: every improved-mode branch worth re-landing is first
  moved VERBATIM to a parked commit on the `improvements` side chain (per
  queue item), so post-cutover PRs are rebases, not rewrites. Ban filtering
  is deleted WITHOUT parking (dropped feature).
- TDD calibrated per GOAL_R1_PARITY.md (RED mandatory for behavior pins;
  full-suite gate per push, delegated per the gate protocol).
- Golden snapshots: re-record ONLY after cross-checking against the battery's
  certified clj recordings; never blind.
- NEVER merge PRs; everything ships as Draft on the spr stack. python-ci on
  spr branches needs manual workflow_dispatch (dispatch at wind-down, check
  at next orientation).
- Privacy: real_data/.local stays gitignored; slugs OK, zids/report-ids/
  content never committed.
- AWS: `bench` profile ONLY (tagged EC2, us-east-1, budget+forecast alarms
  exist). NEVER widen a policy or switch profiles on AccessDenied — stop and
  report. Terminate instances when done; verify termination.
- The Clojure tree stays untouched (it remains the oracle until decommission).

## Method

- **Phase 0 — battery tooling speedup FIRST** (Julien 2026-07-27: the ~36-min
  first-pass py re-replay blocks every code change; data in journal s6):
  (a) scope the py cache tree-hash to the ENGINE surface — exclude pure
  harness files (certify.py, poller_equiv.py, prodclone.py, shard_bench.py,
  polismath/poller/**) whose changes cannot alter replay outputs (driver.py/
  schedule.py/real_data.py DO shape replays — keep them in);
  (b) parallelize battery entries (independent by construction) with
  ~6 workers → target <8 min first pass;
  (c) prove both with an A/B run before relying on them.
- **Phase 1 — inventory**: enumerate every engine_mode branch site (grep) and
  classify: DELETE (ban filtering, dead), PARK (queue items 2-8), KEEP-AS-ONLY
  (legacy behavior). Write the inventory to the journal before cutting.
- **Phase 2 — collapse**, bottom-up, re-running the (fast) battery per chunk.
- **Phase 3 — clarity refactor** (14c then 14b), battery-guarded.
- **Phase 4 — goldens re-record + full gates + equiv release gate.**
- **Phase 5 — EC2 large-conv measurement** (bench profile; reuse the
  cost-model harness patterns; runbook update).
- Reviews per push: Claude review subagent; Copilot ONCE per PR at
  review-ready. Triage against the quirks ledger (a "fix" undoing legacy
  semantics is now a POST-cutover queue item, not a code change).

## Session protocol

Orientation = GOAL doc + GOAL_STATE.md only. Wind-down: finish the cycle,
gate, commit, rewrite GOAL_STATE (numbered next actions, file:line), push,
dispatch CI. Durable state on disk, never in chat. Token floor per
GOAL_R1_PARITY.md (unchanged).
