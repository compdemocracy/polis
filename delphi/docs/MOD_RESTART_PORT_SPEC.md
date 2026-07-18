# Moderation + Restart-Seam Port Spec (R1 battery coverage)

Written 2026-07-22 (session 4) from verbatim Clojure evidence; implements the
last two goal-doc battery coverage items (moderation-heavy incl. meta-tids,
restart seams). Companion: CLJ-PARITY-FIXES-JOURNAL.md "Moderation-flow recon"
(session 3) for the original scout evidence.

## Clojure semantics (verbatim, read 2026-07-22 s4)

1. **mod-update** (conversation.clj:846-884): three INDEPENDENT ordered
   `reduce`s over the same mods seq — mod-out (conj if `is_meta OR mod=-1`
   else disj), mod-in (conj if `is_meta OR mod=1` else disj), meta-tids
   (conj if `is_meta` else disj). NOTE is_meta rows land in BOTH mod-out and
   mod-in. Watermark: `last-mod-timestamp = (apply max (or existing 0)
   (map :modified mods))`. NO recompute of any math.
2. **Batch ordering** (conv_man.clj:361-371 go-act!): each poll batch
   processes message types in order [:votes :moderation]. `react-to-messages
   :votes` = conv-update (full recompute); `:moderation` = `conv/mod-update`
   ONLY — but react-to-messages! (conv_man.clj:328-345) writes math_main
   (tick++) after EACH non-nil handler, so a mod batch RE-EMITS the blob with
   updated sets and UNCHANGED math. Moderation's effect on math lands at the
   NEXT votes recompute.
3. **Restart** (load-or-init, conv_man.clj:188-207): conv is rebuilt from the
   stored math_main blob via `restructure-json-conv` (conv_man.clj:171-186 —
   keeps ONLY {math_tick raw-rating-mat rating-mat lastVoteTimestamp mod-out
   mod-in zid pca in-conv n n-cmts group-clusters base-clusters repness
   group-votes subgroup-* group-aware-consensus comment-priorities meta-tids};
   maps lastVoteTimestamp→:last-vote-timestamp, lastModTimestamp→
   :last-mod-timestamp; base-clusters UNFOLDED; sets re-set-ified;
   raw-rating-mat RESET EMPTY). Then `:recompute :reboot` (metadata only — no
   consumer in conversation.clj; behavior emerges from state), raw-rating-mat
   rebuilt from the FULL vote log `[[pid tid vote]...]` in created order via
   update-nmat, and `mod-update` with the FULL mod history (conv-mod-poll 0).
   LOST on restart (not in blob): :rating-mat, :group-clusterings (per-k
   smoother memory), :base-clusterings equivalents, PCA start continuity
   beyond blob comps — the recovery tick's warm-start inputs are exactly the
   blob contents.

## Replay-step semantics (both drivers, MUST mirror)

- Step = (votes batch → conv-update/recompute) then (mod rows → mod-update,
  NO recompute) then record ONE blob. Mod rows attach to the FIRST cut whose
  cut_time_ms >= modified (and > prev cut time) — schedule.py:206-210 rule,
  already implemented py-side.
- Schedule field `"moderation": "interleave-by-timestamp"` activates weaving;
  mod events come from the dataset comments CSV (see Data below).
- Restart seam: schedule field `"restart_after": <step_index>` (top level,
  applies to BOTH drivers). After recording step N, the driver:
  clj: parse its own just-written step-N blob JSON (keywordized, mirroring
  db/load-conv), restructure-json-conv, assoc :recompute :reboot,
  raw-rating-mat ← update-nmat over ALL vote events with slot ≤ cut_N
  ([pid tid vote] triples, dataset order), then mod-update with ALL mod
  events with t_ms ≤ cut_N's clock; continue schedule.
  py: parse its own step-N blob, Conversation.from_dict (legacy parity
  restore), drop what Clojure drops (rating matrices rebuilt from the full
  vote slice; per-k group-clusterings smoother state LOST), replay full mod
  history via mod_update, continue. Assert the py restore drops the same
  state restructure-json-conv drops.

## Python ports

1. `Conversation.mod_update(mods)` — the conversation.clj:846-884 reducer +
   watermark, verbatim; no recompute. `mods` rows: {tid, is_meta, mod,
   modified}. Used by the replay driver (legacy mode) and later the poller.
   Existing `update_moderation` (replace-when-truthy; cannot remove) stays
   for improved-mode compatibility. TDD: RED via reducer cases python cannot
   express today (un-moderation disj; is_meta in both sets; watermark max;
   order sensitivity conj-then-disj vs disj-then-conj).
2. `ModEvent` gains `is_meta: bool = False` (schedule.py); slicer unchanged.
3. replay/real_data.py: build dataset.mod_events from the comments CSV
   columns (modified→t_ms, comment-id→tid, moderated→mod, is-meta→is_meta);
   rows with no modified timestamp: SKIP (cannot be woven; count them in
   provenance).
4. replay/driver.py: legacy path applies step.mod_events via mod_update
   (votes-then-mods, no mod recompute) replacing the cumulative
   update_moderation path for clojure-legacy replays; keep
   _guard_moderation_clear only for the improved path.
5. certify.py: pass --comments to the clj driver when the schedule requests
   moderation interleaving (and for meta coverage); py side reads the same
   CSV. Existing recordings unaffected (no schedule changes them).

## Clojure driver (math/dev/replay.clj — ONE edit; hash keys the recording
cache: full re-record follows)

1. Remove the moderation raise (replay.clj:398-403). Accept
   "interleave-by-timestamp": load mod rows from --comments CSV (tid,
   is-meta, mod/moderated, modified), weave per the cut rule above, apply
   `conv/mod-update` after each step's conv-update, record one blob per step.
2. `restart_after` support per the semantics above (reuse prep-main output;
   keywordized parse; restructure-json-conv is ON THE CLASSPATH — call it,
   do not reimplement).
3. Keep: meta-tids seeding from --comments at conv creation remains for
   backwards compat with existing recordings (vw), but new moderation
   schedules get meta-tids via mod-update (production-reachable route).

## Data

- prodclone extractor: comments export gains `is-meta`, `mod`, `modified`
  columns (additive; existing extractions unaffected). comment-body stays
  EMPTY (privacy).
- New extractions: pc-modheavy-01 (survey modheavy candidate, small/medium),
  pc-meta-01 (meta candidate with moderate size — query prodclone for
  is_meta conversations <100 ptpts or small vote counts; the survey's meta
  list is all huge).
- New battery entries: pc-modheavy-01 + pc-meta-01 with
  moderation=interleave-by-timestamp; restart variants: at least one small
  public dataset (vw uniform8 restart_after=4) + one prodclone
  (pc-midmix-01 restart_after=3). Battery notes must map the degenerate-tick
  edge case to vw-every-vote-56 early steps (goal-doc list bookkeeping).

## Order of work

1. py mod_update (TDD) + ModEvent.is_meta + real_data mod_events + driver
   legacy mod path (tests with synthetic fixtures).
2. replay.clj batch edit (mod + restart) — ONE edit.
3. py driver restart_after + schedule field plumbing + certify --comments.
4. Extractor columns + 2 extractions + battery entries.
5. Full re-record (clj cache invalidated by the replay.clj edit) + battery
   ×2 — chain in one background run (~90+ min).
6. Cross-check: restart-seam step N+1 blobs must MATCH; if they diverge,
   diff the restored state vs pre-restart state FIRST (the lost-state list
   above is the suspect set).
