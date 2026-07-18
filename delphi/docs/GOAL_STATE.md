STATUS: DONE

# GOAL_STATE — R1 parity goal ACHIEVED (2026-07-24, session 5)

All three GOAL_R1_PARITY.md "DONE means" conditions hold, evidenced in-repo:

1. **Battery: TWO consecutive fully-clean passes on the final tree** —
   20/20 MATCH, DIVERGENCE=0, ERROR=0, exit 0 on both
   (real_data/.local/replays/battery_s5_pass{7,8}.log — the FINAL tree,
   post #2657-review hardening; same-day clean pairs pass{1,2}, {3,4},
   {5,6} on predecessor trees: FOUR consecutive clean pairs total). Battery: 20
   entries = all real_data datasets + prodclone extractions + the goal
   doc's edge cases (mod-heavy, revote-heavy, banned, meta, degenerate,
   zero-votes, restart seams). divergences.json: ZERO open (70 resolved +
   11 carved-out, every carve diagnosed + quirk-ledgered Q1-Q19).
   Subgroup-* carve (Q7) logged on every run, never silent.
2. **Poller equivalence PASSES** (MATH_POLLER_EQUIV_SPEC.md harness, live
   vs the REAL Clojure container): vw verdict MATCH 8/8 batches +
   pc-meta-02 verdict MATCH 6/6 batches with the moderation stream
   (146/146 mod events), both including a kill+restart seam mid-schedule;
   identical math_main/bidToPid/ptptstats rows (structural identity;
   floats within the measured clj self-jitter envelope — the declared,
   per-run-reported tolerance); caching_tick/math_ticks/watermark
   semantics verified. Evidence: real_data/.local/replays/poller_equiv/
   {vw,pc-meta-02}/ (verdict JSONs, manifests, runner logs) + 6 kept DBs.
3. **This line**: STATUS: DONE (written only after 1+2 held).

## For Julien's walkthrough (morning review)

- Journal sessions 4-5 (CLJ-PARITY-FIXES-JOURNAL.md) narrate every
  per-change note. Highlights: restart-seam from_dict restore; Q17 hash
  tie-break PORT; Q18 uniqify ulp knife-edge CARVE (+pc-meta-02 swap);
  **Q19 = REAL Clojure production bug** (conv-actor race losing votes —
  wants an upstream fix); FOUR real py-poller production bugs fixed
  (pid/tid/zid ints; derive_ptptstats wrote the WRONG STATISTIC — now
  the verbatim repness.clj geometric port).
- Stack (all Draft, NEVER merged per constraints): docs PR #2626,
  feature PR #2656, NEW harness PR (created this push), ci commit.
  python-ci dispatched at final push — check the run.
- Parked: fraction-cut py-round clj-driver fix (needs ~2h cache
  re-record); Q19 upstream fix decision; poller cutover phases
  (MATH_POLLER_DESIGN.md §4) are the natural NEXT goal.
