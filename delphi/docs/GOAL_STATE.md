STATUS: IN PROGRESS

# GOAL_STATE — checkpoint for GOAL_CUTOVER_READY.md (cap ~50 lines)

Predecessor GOAL_R1_PARITY.md: ACHIEVED 2026-07-24 (evidence pointers in its
final journal entries; battery ×4 clean pairs, live equiv PASS ×2 datasets).

## Where we are (2026-07-27, session 6 wind-down)

- Copilot triage COMPLETE: 25 threads — 16 fixes applied (TDD; 647-test gate
  green), 2 quirk-rejections cited, 3 declines, 1 deferral (#2644). Battery
  ×2 re-ran on the triaged tree (s6 logs — check verdicts at orientation if
  this session ended before they landed). Issues #2660/#2661/#2662 opened
  (Q10/Q12/Q13+Q18 — "fixed by the Python push").
- Julien rulings captured in POST_CUTOVER_IMPROVEMENTS.md +
  CUTOVER_RUNBOOK.md: bans DROPPED entirely; equiv = release gate not CI;
  sharding parked (data: p99=5 active convs/min vs ~100 ticks/min EC2-
  measured serial capacity); clarity refactor moved PRE-cutover; large-conv
  EC2 tick measurement is a flip precondition; run_delphi.py is
  PRODUCTION-called (POST /api/v3/delphi/jobs → job_poller FULL_PIPELINE).
- Battery timing DATA (journal s6): first pass after an engine change ≈36
  min (py re-replay, clj cached); second consecutive pass ≈21 SECONDS;
  full clj re-record ≈91 min. Phase 0 tooling attacks the 36-min pass.

## Next actions

1. s6 battery CONFIRMED clean: 20/20 MATCH ×2 on the triaged tree
   (battery_s6_pass{1,2}.log; only 3 clj re-records fired — the restart
   entries carry no comments CSV). Commit split DONE: triage fixes = PR
   #2663 (spr/edge/efb914d7), docs = #2659. python-ci dispatched on
   #2663's head (run 30276844539) — CHECK at orientation. Thread
   replies/resolves: CONFIRMED complete — all 20 open threads across 11
   PRs replied (citing #2663) and resolved; 25/25 Copilot comments closed.
2. Phase 0 of GOAL_CUTOVER_READY.md: battery tooling speedup (hash scoping
   + parallel entries; A/B-prove — timing data in journal s6: 36-min
   first pass / 21-s cached pass). THEN Phase 1 inventory (grep all
   engine_mode branch sites; classify DELETE/PARK/KEEP; journal it).
3. Review the new PRs per protocol when review-ready: #2659 (docs), #2663
   (triage batch — request Copilot once; our agent already covered the
   content via the triage itself).
4. Parked questions needing input: none — all rulings recorded.

## Pointers

- Contract: GOAL_CUTOVER_READY.md. Roadmap: POST_CUTOVER_IMPROVEMENTS.md.
  Runbook: CUTOVER_RUNBOOK.md. Quirks: CLOJURE_QUIRKS.md Q1-Q19.
- Battery: scripts/certify.py run (20 entries). Equiv release gate:
  scripts/poller_equiv.py full-run (needs pgproxy 127.0.0.1:15432 up:
  `docker start polis-dev-postgres-1 pgproxy`).
- Suite baseline: 1134 passed / 22 skipped / 46 xfailed (2026-07-24) + s6
  additions; gate delegation protocol in GOAL_R1_PARITY.md.
