# GOAL: Certified Clojure↔Python math parity (R1 warm-start), including the poller

Standing autonomous goal (set by Julien, 2026-07-22). Work session after session
until DONE. Do not ask questions — decide, document, keep going. This is a
standing math-core handover: propose-then-wait is suspended for this goal;
compensating controls are per-change journal notes and a walkthrough doc at
each milestone. Stop only for hard blockers you cannot clear yourself (broken
environment, usage limit) and resume after.

## DONE means

For every (dataset × schedule) in the battery, the H-A/H-B replay comparison
shows ZERO structural divergences (in-conv membership, base/group cluster ids &
memberships, repness & consensus selections, comment priorities/routing) and
all floats within declared, per-run-reported tolerances, at EVERY step of the
warm-start chain — not just cold start. Plus poller equivalence: identical
math_main/bidToPid/ptptstats rows and tick/watermark semantics vs the Clojure
math container on the same vote streams, including a restart-mid-schedule seam.
Declare DONE only after TWO consecutive fully-clean battery passes.

Completion signaling: the FIRST line of `GOAL_STATE.md` is `STATUS: IN
PROGRESS` until every DONE condition above holds, then — and only then —
`STATUS: DONE`. A session that winds down with open divergence fingerprints
(docs/divergences.json) or an incomplete battery has made PROGRESS, not
achieved the goal, regardless of how cleanly it wound down.

Subgroup keys (subgroup-clusters/-votes/-repness) are CARVED OUT of acceptance
(dead feature — evidence in CLOJURE_QUIRKS.md Q7); log the exclusion on every
certification run, never silently.

## Battery

All real_data datasets + several prodclone extractions (small/medium — verify
Clojure's runtime scaling empirically first and set the size cutoff from data),
and edge cases: moderation-heavy, revote-heavy, banned participants (mod=-1),
meta-tids, degenerate ticks, zero-votes conversations, restart seams. Privacy:
prodclone data stays in real_data/.local/ (gitignored), minted neutral slugs,
never commit zids/report-ids/vote or comment content.

## Constraints

- NEVER modify existing Clojure sources except additive logging; new files
  under math/dev/ are fine.
- Replicate Clojure quirks/bugs in clojure-legacy mode ONLY; improved mode
  keeps the correct behavior. Ledger every replicated quirk in
  CLOJURE_QUIRKS.md; never "fix" a ledgered quirk silently (it would surface
  as a divergence).
- TDD for every behavioral change, CALIBRATED (Julien-approved 2026-07-22;
  supersedes the strict `<tdd-cycle>` form for this goal only):
  - RED observation is MANDATORY when the test pins a bug or divergence (proves
    the test can detect it). For defensive guards / belt-and-braces where the
    pre-change behavior is trivially derivable by reading, a written
    justification may replace an observed RED — no reverting code just to
    stage a failure.
  - Targeted tests run per fix; the FULL-suite gate runs per PUSH (before each
    `jj spr update`), not per commit.
  - Full-suite gates are DELEGATED to a cheap subagent (Sonnet default; Haiku
    fine for routine expected-green runs): the agent runs the suite in its own
    foreground with `-v` (pytest-timestamper hang detection preserved in ITS
    context) and returns ONLY: the summary line; per-failure names +
    `--tb=short` tracebacks; any delta in skips/xfails vs the recorded
    baseline; and a stall report (test name + elapsed) if output stalls
    >5 minutes — kill and report, never wait indefinitely. The top level
    reads raw suite output only if the agent's report is ambiguous.
  - Golden snapshots re-recorded only after verifying against Clojure.
- PR granularity: one PR per port/subsystem (its tests + quirk-ledger row
  included); substantive review fixes squash into their owning commit; pure
  trivia (wording, type hints) batches into the top docs commit.
- Everything ships as Draft PRs on the spr stack (or side branches). NEVER
  merge. Keep CLJ-PARITY-FIXES-JOURNAL.md and PLAN_DISCREPANCY_FIXES.md
  current every session. python-ci on spr/edge/* branches needs manual
  workflow_dispatch.

## Method

1. **Phase 0 — automation kit** (script-driven loop, not model-driven):
   certify.py battery runner (headless, idempotent, hash-cached, compact JSON
   verdicts); Clojure recordings cached once per (dataset, schedule) and reused
   across Python iterations; first-divergence focuser (bisect to earliest
   divergent step, print only divergent keys); prodclone extractor
   (feature-filtered); Clojure timing probe.
2. **Ports, in order**: degenerate-tick group-clusterings overwrite + the
   <2-participants edge (Opus 2026-07-21 verdict, journal; APPROVED);
   env_flags resolver move — pca.py and engine_mode.py both import from
   polismath/utils/env_flags.py (APPROVED); remaining sequential bits (D1
   remainder; comment-priorities previous-tick group-votes at un-mirror time;
   mod=-1 leak replication in legacy mode); blob-shape alignment
   (to_math_main_blob() whitelist serializer).
3. **Certification loop**: run battery → diagnose first divergence → port →
   rerun, until two consecutive dry passes. Then poller equivalence harness.
4. **Reviews on every new PR** (Julien-authorized 2026-07-22, standing for
   this goal): (a) a Claude review subagent (Sonnet) on the PR diff at
   creation; (b) a Copilot review requested via
   `.claude/skills/copilot-review/request-copilot-review.sh` ONCE per PR when
   it reaches review-ready state — re-request only after substantive changes,
   never per push (monthly AI-credit budget, resets the 1st). Fetch + triage
   via the batch script (`fetch_copilot_batch.sh` pattern): non-math fixes
   applied directly; math-core findings applied under goal autonomy but
   checked against CLOJURE_QUIRKS.md first — a reviewer "fix" that would undo
   a replicated quirk gets a thread reply citing the ledger row instead of a
   code change. Resolve addressed threads; ledger + journal every applied fix.
5. **Delegation**: Sonnet subagents (isolated clones, commit-early) for
   automation scripts, mechanical ports from written specs, test authoring;
   Haiku for battery babysitting, CI watching, boilerplate; full-suite
   gates per the delegated-gate protocol in Constraints. Escalation ladder:
   a failed Sonnet delegation retries ONCE on Opus before any top-level
   takeover (≈half the weighted token cost, and keeps failure debris out of
   top-level context). Opus also quarantines exploration-heavy diagnosis of
   REFOUND-LIKE divergences (plausible variant of a ledgered fingerprint):
   the Opus agent runs the bisect/dead-end search and returns an evidence
   package (verbatim divergent keys, step ids, file:line quotes) plus a
   candidate diagnosis; the top level reads that evidence itself and draws
   the conclusion (FLOOR preserved). Novel-divergence diagnosis, Clojure
   semantics reading, port design, and integration gates stay at the top
   level. Anti-rule: never delegate read-heavy/conclude-light tasks over
   context the top level already holds — a subagent's cold input costs more
   than the top level's cached reads.

## Session protocol (resumption)

- ORIENTATION on every fresh session: this file + `GOAL_STATE.md` (the ≤50-line
  live checkpoint — overwrite it freely; history belongs in the journal). Read
  the journal tail / PLAN / spec docs only when GOAL_STATE.md points at them
  for the task at hand — never re-read them wholesale.
- WIND-DOWN when context runs low (no auto-compact): finish the current
  port/test cycle, commit, update the journal's "What's Next" with precise
  next actions (file:line level), push, and end the session cleanly. Never
  leave uncommitted work or a stale What's Next.
- Durable state lives on disk, never in chat context: the battery cache
  (recordings + hashed verdicts) makes "where were we" = "run certify.py,
  read the summary". Scratch diagnosis notes go to delphi/scratch/ with a
  RESUME pointer in the journal if mid-diagnosis.

## Token discipline (no reasoning-power loss intended; the floor is below)

- **Hash-first comparison**: certify.py compares whole-blob hashes before any
  key-by-key diff — hash-equal steps cost zero tokens and zero descent.
- **Divergence fingerprint ledger**: every divergence gets a fingerprint
  (key-path × step-kind × mode) in divergences.json with its diagnosis; a
  refound fingerprint reuses the diagnosis instead of re-deriving it across
  datasets.
- **Terse-output contract**: every bespoke script prints ≤40 lines (verdicts);
  detail goes to files. Subagents return structured JSON per an explicit
  contract in their prompt, not prose reports.
- **Scout cheap, conclude at top level**: Haiku/Explore agents LOCATE things in
  big files (Clojure sources, blobs) and return verbatim quotes with file:line;
  the top level reads only those windows and draws every conclusion itself.
  Windowed reads only (never whole files >500 lines).
- **Batching**: `jj spr update` at most twice per session; one CI dispatch at
  session end, checked at next orientation (never poll). Review-triage via the
  batch-file fetch script, never per-PR interactive fetching.
- **Recorded gate baseline**: the suite baseline (counts + skip list) lives in
  a file; the gate agent diffs against it mechanically and reports only deltas.
- **Accidents become documentation immediately**: any process mistake that
  burned tokens gets a same-session gotcha entry (memory / skill / this doc) —
  historically the single largest sink.

FLOOR — never cut for tokens: the top level reads the actual divergence
evidence before concluding; RED observed for divergence-pinning tests; full
gate before every push; golden snapshots verified against Clojure before
re-recording; per-change journal notes.
