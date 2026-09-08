STATUS: DONE

# GOAL_STATE — GOAL_CUTOVER_READY.md ACHIEVED (2026-07-27, session 7)

All seven DONE conditions hold, evidenced in-repo:

1. Mode collapse: gate grep (ENGINE_MODE|engine_mode|resolve_engine_mode
   over delphi/polismath/) = 0 hits; ban filtering DELETED outright;
   parks = jj bookmarks improvements/item-{2,4,5,8} (pushed to origin;
   verbatim reverse patches, NOT buildable — re-land = keep improved
   side). PRs #2665-#2671. run_delphi/job_poller share the single path.
2. Clarity refactor 14b/14c landed: PR #2673 (two-phase split +
   blob-injection pins), battery-proven bit-identical.
3. Goldens re-recorded at the collapse tree (verify-then-record, journal
   s7): comparer 7/7 PASS; --include-local suite green (one justified
   Q12 xfail on FLI-cold_start prod-blob comparison, #2674).
4. Battery: 20/20 MATCH ×2 consecutive on the final tree (re-run after
   the last docs edits); divergences.json 81 entries, 0 open.
5. Equivalence release gate: poller_equiv full-run PASS live on the
   final code tree — vw 8/8 MATCH, pc-meta-02 8/8 MATCH, non-vacuous,
   0 envelope-excused divergences.
6. EC2 measurement in CUTOVER_RUNBOOK risk item 3: r8g.4xlarge,
   33,422×783/2.0M votes — cold 519.6s, WARM 1856.0s (~31 min).
   VERDICT (FINAL): serial OK at every observed shape — item 9a
   (vectorized warm-start k-means, PR #2679, bit-identical) re-measured
   on the same r8g.4xlarge: cold 519.6s→29.0s, warm 1856.0s→26.6s
   (~70x). No blocklisting (none needed); item 9b (seeded sampled PCA)
   now optional.
7. This line 1 flip.

## For walkthrough (Julien)

- Collapse series #2665-#2671 + #2673 + #2674 + #2675 (+docs #2672,
  #2659, triage #2663, Phase-0 #2664). ALL independently review-agent'd:
  clean (one pin applied: _euclidean NaN test, #2663 review). All 5
  python-ci dispatches green. Copilot NOT used (credits exhausted —
  independent agents instead, Julien ruling s7).
- Battery cost model now: no edit ~22s / harness edit ~2m / engine edit
  ~19m (pakistan long pole). Phase 0 A/B data in journal s7.
- Big deduced finding: warm tick ≫ cold tick at scale (legacy kmeans
  warm start); Clojure's large-conv path never special-cased kmeans
  (only :pca — conversation.clj:760-773), so item 9 = seeded sampled
  PCA + kmeans performance. Runbook risk item 3 has the numbers.
- Next goal candidates: execute CUTOVER_RUNBOOK steps 0-3 (land, shadow,
  flip, decommission — needs Julien/team); post-cutover queue items
  (POST_CUTOVER_IMPROVEMENTS.md), item 9 first if large convs matter.

## Pointers

- Contract: GOAL_CUTOVER_READY.md. Roadmap: POST_CUTOVER_IMPROVEMENTS.md.
- Runbook: CUTOVER_RUNBOOK.md. Journal: CLJ-PARITY-FIXES-JOURNAL.md s7.
- Battery: cd delphi && uv run python scripts/certify.py run (workers=6).
- Suite baseline: 1155/22/44 (+2 xpassed) without --include-local; 1285+1xfail with
  --include-local.
