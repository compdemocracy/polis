# HANDOFF: execute the Clojure→Python math cutover (steps 0-3 as WIP PRs)

> **STATUS (2026-07-28, s8): PREP DONE; CLEAN CUT RULED.** Colin ruled
> clean cut (no shadow) — Step 1/#2686 was folded into the flip PR and
> closed. Open draft PRs: Step 0 = #2685 (PROD DEPLOY vehicle,
> stable←edge), Step 2 = #2687 (flip — carries the comparison tool +
> cache-cap fix; mechanism confirmation pending), Step 3 = #2688
> (decommission), Step 4 = #2689 (remove Clojure tree, move Python math
> to top-level math/ — added per Julien). Rulings in CUTOVER_RUNBOOK.md
> "Execution shape". NOTHING merged; no AWS-side change made. Journal:
> session 8. Julien triggers Step 0.

Written 2026-07-28 at the close of s7 (GOAL_CUTOVER_READY: DONE). This is
the ENTRY POINT for the session that ships the cutover. Read order:
1. This file.
2. CUTOVER_RUNBOOK.md — canonical: evidence base, risk register with the
   FINAL measured verdict, "Execution shape" (shadow analysis, PR plan,
   CDK verdict), steps 0-3.
3. GOAL_STATE.md (STATUS: DONE + walkthrough) if provenance is needed.

## Where things stand (evidence all in-repo)

- Engine: ONE code path, Clojure-exact legacy semantics. Certified:
  battery 20/20 MATCH pairs at every s7 milestone incl. the final tree;
  live equivalence vw 8/8 + pc-meta-02 8/8 non-vacuous; goldens
  re-recorded (comparer 7/7); suite 1171 green.
- Performance solved: vectorized warm-start k-means (#2679,
  bit-identical). r8g.4xlarge, 33,422×783/2.0M votes: cold 29.0s, warm
  26.6s (was 519.6s / 1856.0s). Verdict: serial OK at every shape; no
  blocklisting (Julien ruling: never blocklist; warm start stays).
- Naming: compose service `math-python`, profile `math-python`, env
  `MATH_PYTHON_ENV` (default math_env value 'python').
- The ENTIRE stack is Draft/UNMERGED (spr-managed, ~#2613-#2682+).
  Nothing is on `edge` yet, and prod deploys from `stable`.

## OPEN RULINGS — get from Julien before the relevant PR

1. Shadow vs clean replace. Recommendation on file (runbook "Execution
   shape"): time-boxed shadow 24-48h with the written exit checklist.
2. Flip mechanism — pick ONE: poller MATH_ENV→'prod' vs server
   mathEnv→'python'. Runbook step 2 demands it be written down.

## The PRs

- **PR-S0 — land + promote.** (a) Merge the stack bottom-up:
  `jj spr merge --count <N>` — NEVER the GitHub UI (spr can't track UI
  squashes). Julien decides the merge moment/team sign-off. (b) Promote
  edge→stable: CHECK FIRST how stable has historically been advanced
  (`git log origin/stable` — fast-forward vs PR; not verified in s7).
  Prod's after_install.sh does `git reset --hard origin/stable`.
- **PR-S1 — shadow wiring.** scripts/after_install.sh, math role branch
  (`elif [ "$SERVICE_FROM_FILE" == "math" ]`, ~line 105-108): change
  `up -d math` → `up -d math math-python`. Env: MATH_PYTHON_ENV +
  MATH_CONV_CACHE_CAP must reach the instance .env — that comes from
  Secrets Manager `polis-web-app-env-vars` (AWS-side edit, needs
  Julien/elevated creds — NOT bench, NOT a repo change; coordinate).
  Copy the exit checklist (runbook Execution shape) into the PR body.
  MATH_CONV_CACHE_CAP: set it (LRU; eviction cost = certified restart
  seam). Pre-soak verify item: read the clj container's actual -Xmx on
  the host (`docker stats`); memory math says 128 GiB host / 16g python
  cap / clj unchanged — wide margins, but cite real numbers.
- **PR-S2 — flip.** One env change per ruling 2; revert instructions in
  the PR body. Rollback semantics: both envs' rows coexist
  (UNIQUE(zid, math_env)); caching_tick is MAX+1 so monotonicity
  survives swaps in both directions; restart clj `math` to roll back.
- **PR-S3 — decommission.** Remove `math` from docker-compose.yml AND
  its `up -d math` line in after_install.sh; archive note for math/
  (the Clojure tree stays as the certification oracle — do NOT delete).

## Gotchas that will bite (all learned the hard way)

- spr: one commit = one PR on the single stack bookmark. NEVER
  `jj squash -m` into an spr commit (wipes the commit-id trailer →
  garbage PRs); preserve trailers when re-describing; use
  `--use-destination-message`. jj split gives BOTH halves the trailer —
  rewrite the second half's description fresh and move the spr bookmark
  back (`jj bookmark set spr/edge/<id> -r <first> --allow-backwards`).
- jj-colocated: NEVER `git checkout --`/`git restore` a working file
  (git index = parent commit; wipes uncommitted work).
- Copilot review credits are EXHAUSTED — use independent review-agent
  subagents per PR (the s7 pattern; all 15+ s7 PRs reviewed that way).
- python-ci on spr branches needs manual `gh workflow run python-ci.yml
  --ref <branch>` (dispatch at wind-down, check at next orientation).
- Compose profiles gate DEV only; prod starts services BY NAME.
- Battery cost model: no engine edit ~22s cached pair; engine edit
  ~19min re-replay (run `cd delphi && uv run python scripts/certify.py
  run`). The cutover PRs touch deploy/compose only → cached pairs.
- Shadow comparer WILL flag the 7 historical large convs (Q10: clj rows
  are unseeded-random there) — expected, not a defect (runbook risk 2).

## Post-cutover (not this session, but adjacent)

POST_CUTOVER_IMPROVEMENTS.md is the queue: parks on improvements/*
bookmarks (items 2/4/5/8), item 12 (persist warm-start state — kills
restart-induced K flips), item 9b optional. Candidate after the soak:
downsize the math host (CDK cdk/ec2.ts instanceTypeMathWorker) once
real utilization is measured — the vectorized engine likely doesn't
need an r8g.4xlarge.
