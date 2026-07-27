STATUS: IN PROGRESS

# GOAL_STATE — checkpoint for GOAL_CUTOVER_READY.md (cap ~50 lines)

## Where we are (2026-07-27, session 7 wind-down)

- Phase 0 DONE + A/B-proven: engine-scoped py cache hash + 6-way parallel
  battery (PR #2664, python-ci green, review clean). Costs now: no edit
  ~22s, harness-only edit ~2m, engine edit ~19m (long pole
  pakistan:uniform8 ~18m — <8m target unreachable without intra-entry
  parallelism; journal s7).
- Phase 1 DONE: engine_mode inventory journaled (s7).
- Phase 2 DONE — MODE COLLAPSE EXECUTED: 7 commits = PRs #2665-#2671.
  DONE-gate grep = 0 hits over delphi/polismath/. Ban filtering DELETED
  outright. Parks minted: jj bookmarks improvements/item-{2,4,5,8}
  (verbatim reverse patches off the C7 commit; NOT buildable — they
  carry old flag refs; re-landing = keep the improved side only).
  Battery on the collapsed tree: 20/20 MATCH full py re-replay (19m21s)
  + cached pass 22s. Full suite 1155 passed / 22 skipped / 44 xfailed
  / 2 XPASS (D9/D10 vw-cold_start now match Clojure — parity improved).
- Phase 3 DONE: 14b blob-injection pins + 14c two-phase split (PR
  #2673); battery 20/20 on the refactored tree (bit-identity); collapse
  review agent verdict CLEAN, its 3 cleanups applied. #2664 CI green.

## Next actions

1. Orientation: check CI runs 30286254481 (collapse tip) + 30288678922
   (#2673 14b/c) + the #2673 review agent result; Copilot comments on
   #2659/#2663. Triage per protocol (a "fix" undoing legacy semantics =
   post-cutover queue item). Phase 3 is DONE (PR #2673; battery 20/20 on
   the refactored tree = bit-identity; journal s7 cont.).
2. Phase 4: goldens. Diagnostic done (journal s7 cont.): public datasets
   have NO goldens (comparisons skip); the 5 private goldens are at
   real_data/.local/*/golden_snapshot.json. Verify current private-golden
   drift with `uv run python scripts/regression_comparer.py --include-local`
   (needs /private-data setup), cross-check intended new values against
   the battery clj recordings, THEN re-record via
   scripts/regression_recorder.py; full suite --include-local green.
3. Phase 4 gates on the final tree: TWO consecutive clean battery passes
   + poller_equiv.py full-run PASS (non-vacuous) on vw AND pc-meta-02
   (pgproxy 127.0.0.1:15432 up: `docker start polis-dev-postgres-1
   pgproxy`; docker compose services for the clj container).
4. Phase 5: EC2 large-conv tick measurement (bench AWS profile, 33k
   ptpts × 783 cmts shape) → number + serial-OK verdict into
   CUTOVER_RUNBOOK.md risk register.
5. Only after all of 1-6 of the DONE list hold on the final tree: flip
   line 1 here to STATUS: DONE.

## Pointers

- Contract: GOAL_CUTOVER_READY.md. Roadmap: POST_CUTOVER_IMPROVEMENTS.md.
- Battery: cd delphi && uv run python scripts/certify.py run (workers=6).
- Suite baseline: 1155/22/44 + 2 xpassed (s7 collapse tree).
- s7 journal: Phase 0/1/2 + battery evidence (CLJ-PARITY-FIXES-JOURNAL.md).
