# Axis-continuity evidence (public `vw` replays)

Evidence produced by `polismath.replay.axis_continuity` (see that module's
docstring for what is measured and why — DIAGNOSTIC ONLY, never a certify
gate) over Python-only replays of the public `vw` dataset
(`delphi/real_data/r6vbnhffkxbd7ifmfbdrd-vw`). No Clojure driver, no
Postgres/Docker — these come straight from the CSV loader
(`polismath.replay.real_data.load_export_votes`).

All four runs share the same engine commit and dataset:

- **Engine commit**: `78e80c2154a132792a4114528937fb1d3c8b0037`
  (`feat/delphi-axis-continuity`)
- **Dataset**: `vw` — `2025-11-11-1704-r6vbnhffkxbd7ifmfbdrd-votes.csv`
  (sha256 `622b8c164150dc509f7387d81d2e2d616d37211c3bb256458064972ad805b56a`),
  `2025-11-11-1704-r6vbnhffkxbd7ifmfbdrd-comments.csv`
  (sha256 `ffaed9db95e7c9c28cb8595cef9845a262b80c0c787f2a2492ba41c28cf683d2`)
- **Python** 3.12.11; numpy 1.26.4, pandas 2.3.3, scipy 1.17.1, sklearn 1.9.0;
  `POLISMATH_PCA_IMPL=powerit` (default)

All commands below run from `delphi/`. Recordings land under
`real_data/.local/replays/` (gitignored, `.gitignore:222-223`); only this
README and the `axis-continuity-*.json` reports in this directory are
committed.

## 1. `vw` / `uniform8` — the warm chain

Battery schedule id per `scripts/certify_battery.json`'s
`{"dataset": "vw", "preset": "uniform", "n_cuts": 8}` entry (resolved by
`polismath.replay.certify.derive_schedule_id(preset="uniform", n_cuts=8)` to
base id `uniform8`; the `-clojure-legacy` suffix that function adds is a
`certify.py`-battery-only artifact for cross-engine recording-cache keys and
is not used here, since this is a Python-only run outside `certify.py`). Cut
points (8 evenly-spaced vote counts, `vote-count` mode,
`clojure.warm_start: chain`) match `scripts/schedules/vw-uniform8-restart4.json`
exactly: 585, 1171, 1756, 2342, 2927, 3512, 4098, 4683.

```
uv run python scripts/replay_driver.py run \
    --dataset vw --preset uniform --n-cuts 8 --schedule-id uniform8

uv run python -m polismath.replay.axis_continuity \
    --recording real_data/.local/replays/vw/uniform8 --engine py \
    --out polismath/replay/evidence/axis-continuity-vw-uniform8.json
```

**Result**: 8 checkpoints, 7 pairs, `flips=0 reordered=0
excused_degenerate=0 undefined=0 subspace_rotations=5`. The warm chain
(previous tick's real PCA components threaded in as the power-iteration
start vector at every step after the first) holds orientation over the
whole run — no PC flip, matching the "legacy holds orientation" half of
`docs/PLAN_DISCREPANCY_FIXES.md:542`.

## 2. `vw` / `uniform8-coldcontrol` — negative control

**What was checked first**: whether the driver/schedule offers a documented,
engine-unmodified way to disable the warm start.

- `POLISMATH_ENGINE_MODE` (the "improved (cold) mode" vs
  "clojure-legacy" split `docs/PLAN_DISCREPANCY_FIXES.md`'s D1 entry
  describes) is **not read anywhere in the current code**
  (`grep -rn POLISMATH_ENGINE_MODE polismath/` → no hits outside comments).
  That historical toggle predates a refactor: `Conversation._compute_pca`
  (`polismath/conversation/conversation.py:753-761`) now threads the
  previous tick's `pca.comps` into `pca_project_dataframe` as
  `start_vectors` **unconditionally**, with `require_powerit=True`
  **unconditionally** — there is no live switch that skips this.
- `POLISMATH_PCA_IMPL=sklearn` does not help either: `pca.py:332-341`
  explicitly overrides it back to `powerit` (with a warning) whenever
  `require_powerit` or `start_vectors` is set, i.e. every real tick — sklearn
  can't be seeded, so the code refuses to silently drop the warm start.
- `ScheduleSpec.clojure["warm_start"]` (default `"chain"`) is **inert
  metadata** for the schedule JSON, reserved for the future H-B Clojure
  driver (module docstring, `schedule.py`). `grep -rn "spec.clojure"
  polismath/replay/*.py` → no hits: the Python driver never reads it.
- `restart_after` (`driver.py`'s `_restart_conversation`) is **not** a cold
  control: it rebuilds the conversation via `Conversation.from_dict`, which
  explicitly *restores* the `pca` block (driver.py:187-213) — the warm
  chain survives the restart seam. It changes which rating-matrix state is
  rebuilt from scratch, not PCA orientation continuity.

**Conclusion**: there is no live flag to flip. So *no engine code was
touched*. Instead, the negative control below composes the unmodified
driver differently: it calls `polismath.replay.driver.run_replay` **eight
separate times**, once per `uniform8` cut boundary, each as its **own**
independent single-cut schedule (`vote-count` mode, one `at` entry). Every
call constructs a fresh `Conversation` and pins its PCA to the Q12
ones-vector cold seed before its one step (`driver.py:104-115`) — so, unlike
`uniform8`, no step ever sees another step's actual computed components.
The 8 resulting single-step recordings were reduced into one 8-step
recording directory under schedule id `uniform8-coldcontrol` by
`scratchpad/build_coldcontrol.py` (a throwaway composition script, not
part of this PR) using `polismath.replay.store.write_recording` — the same
store module a normal run uses, just fed pre-built `StepRecord`s.
`prev_slot` is honestly recorded as `0` for every step (each run replays
votes `1..cut` fresh, not an increment from the previous cut); `schedule.json`'s
`notes` field and `provenance.json`'s `coldcontrol_assembly` field both spell
out the composition. Same 8 cut points, same vote/comment CSVs, same engine
commit — only PCA cross-step continuity differs.

```
# scratchpad/build_coldcontrol.py: for cut in [585,1171,1756,2342,2927,3512,4098,4683]:
#     spec = ScheduleSpec.from_dict({"dataset": "vw", "schedule_id": f"...-{i}",
#         "cuts": {"mode": "vote-count", "at": [cut]}, "moderation": "none", ...})
#     records = run_replay(load_export_votes("vw"), spec)   # 1 StepRecord
# then store.write_recording(assembled_8_records, uniform8_coldcontrol_spec)

uv run python -m polismath.replay.axis_continuity \
    --recording real_data/.local/replays/vw/uniform8-coldcontrol --engine py \
    --out polismath/replay/evidence/axis-continuity-vw-uniform8-coldcontrol.json
```

**Result**: 8 checkpoints, 7 pairs, `flips=1 reordered=0
excused_degenerate=0 undefined=0 subspace_rotations=5`. The single flip is
pair `006->007` (0-based `ReplayStep.index`, i.e. the 7th cut, vote count
4098→4683): PC2's signed cosine goes from `+0.966821` (unflipped, same as
the warm chain) to `-0.758356` — same subspace, opposite orientation,
eigengap 0.437 (well above the 0.02 degeneracy floor, so not excused). This
**reproduces the step-6 PC2 flip** `docs/PLAN_DISCREPANCY_FIXES.md:542`
and the `axis_continuity` module docstring describe for cold/non-warm mode,
under today's engine, via a schedule-level composition rather than a
retired engine-mode flag.

## 3. `vw` / `every-vote-56`

```
uv run python scripts/replay_driver.py run \
    --schedule scripts/schedules/vw-every-vote-56.json

uv run python -m polismath.replay.axis_continuity \
    --recording real_data/.local/replays/vw/every-vote-56 --engine py \
    --out polismath/replay/evidence/axis-continuity-vw-every-vote-56.json
```

Schedule: `explicit-event-index`, one recompute per vote for the first 56
votes (prefix, truncated before the Q11 knife-edge at vote 57 — see the
schedule file's `notes`). **Result**: 56 checkpoints, 55 pairs, `flips=2
reordered=0 excused_degenerate=0 undefined=32 subspace_rotations=5`. The 32
`UNDEFINED` pairs are early-conversation degenerate ticks (too few shared
tids / near-zero components on 1-comment-at-a-time steps) — expected at
this density, and never silently read as "stable" (module docstring, status
`UNDEFINED`). The 2 flips are at pairs `041->042` and `044->045`, both
exact antipodal PC2 flips (`cosine -1.000000`, `principal_angles_deg=[0,0]`
— same subspace) at a *low* eigengap (0.099 / 0.088, still above the 0.02
floor so not excused): even the warm chain is not immune to a flip when two
eigenvalues are close and per-vote steps churn the ordering fast.

## 4. `vw` / `front-loaded6`

```
uv run python scripts/replay_driver.py run \
    --dataset vw --preset front-loaded --n-cuts 6 --schedule-id front-loaded6

uv run python -m polismath.replay.axis_continuity \
    --recording real_data/.local/replays/vw/front-loaded6 --engine py \
    --out polismath/replay/evidence/axis-continuity-vw-front-loaded6.json
```

Schedule id per `derive_schedule_id(preset="front-loaded", n_cuts=6)` →
`front-loaded6`; cuts (quadratic spacing, dense early) are 130, 520, 1171,
2081, 3252, 4683. **Result**: 6 checkpoints, 5 pairs, `flips=0 reordered=0
excused_degenerate=0 undefined=0 subspace_rotations=5`. Warm chain holds
here too; every pair carries a subspace-rotation note (principal angle
>15°) since front-loading concentrates the early, sparsest, least-stable
recomputes — expected instability in *which* axes span the space, not in
orientation.

## Summary

| Recording | Checkpoints | Flips | Reordered | Excused | Undefined | Notes |
|---|---|---|---|---|---|---|
| `uniform8` (warm chain) | 8 | 0 | 0 | 0 | 0 | continuous |
| `uniform8-coldcontrol` (negative control) | 8 | 1 | 0 | 0 | 0 | PC2 flip at pair 6→7, reproduces PLAN_DISCREPANCY_FIXES.md:542 |
| `every-vote-56` | 56 | 2 | 0 | 0 | 32 | antipodal PC2 flips at low-but-nondegenerate eigengap |
| `front-loaded6` | 6 | 0 | 0 | 0 | 0 | continuous; frequent subspace rotation |

The negative control confirms the diagnostic can detect a real discontinuity
under today's engine and isn't just reporting "no flip" by construction: the
warm chain (`uniform8`) is clean, an independently-reassembled cold sequence
over the *same* cuts and data (`uniform8-coldcontrol`) is not.
