# Cut-cadence experiment results

Generated 2026-07-06 21:38 UTC by `uv run python -m polismath.replay.experiments.run_cadence --exp all --out polismath/replay/experiments/results_cadence.json --md polismath/replay/experiments/RESULTS.md --jobs 6` (grid: eras ['B', 'A'], N [5, 10, 50], seeds [0, 1, 2], 1000 votes, 200 posterior samples/run; all runs count-constrained t_range=(T,T)). Cells are medians across seeds.

Reproduce per experiment family (from `delphi/`):

```bash
uv run python -m polismath.replay.experiments.run_cadence --exp fixed --out /tmp/results_fixed.json
uv run python -m polismath.replay.experiments.run_cadence --exp poisson --out /tmp/results_poisson.json
uv run python -m polismath.replay.experiments.run_cadence --exp time --out /tmp/results_time.json
uv run python -m polismath.replay.experiments.run_cadence --exp bursty --out /tmp/results_bursty.json
# full committed grid:
uv run python -m polismath.replay.experiments.run_cadence --exp all \
    --out polismath/replay/experiments/results_cadence.json \
    --md polismath/replay/experiments/RESULTS.md --jobs 6
```

## Posterior localization and coverage

| family | era | N | cuts | loc med (votes) | loc p90 (votes) | loc med (s) | loc p90 (s) | cov@3v | cov@10s |
|---|---|---|---|---|---|---|---|---|---|
| fixed | B | 5 | 199 | 1.0 | 2.0 | 6.1 | 7.2 | 0.91 | 0.70 |
| fixed | B | 10 | 99 | 2.5 | 3.0 | 12.1 | 15.2 | 0.69 | 0.42 |
| fixed | B | 50 | 19 | 3.0 | 6.2 | 16.0 | 31.0 | 0.55 | 0.38 |
| fixed | A | 5 | 199 | 1.0 | 2.0 | 6.1 | 7.2 | 0.91 | 0.70 |
| fixed | A | 10 | 99 | 2.0 | 3.0 | 12.1 | 15.6 | 0.70 | 0.45 |
| fixed | A | 50 | 19 | 2.0 | 5.0 | 11.9 | 26.6 | 0.70 | 0.51 |
| poisson | B | 5 | 205 | 1.0 | 2.0 | 6.0 | 7.8 | 0.91 | 0.68 |
| poisson | B | 10 | 104 | 2.5 | 3.0 | 12.5 | 15.2 | 0.67 | 0.42 |
| poisson | B | 50 | 20 | 5.8 | 15.0 | 30.4 | 77.3 | 0.40 | 0.31 |
| poisson | A | 5 | 205 | 1.0 | 2.0 | 6.2 | 7.9 | 0.91 | 0.69 |
| poisson | A | 10 | 104 | 2.0 | 3.0 | 12.2 | 16.0 | 0.68 | 0.45 |
| poisson | A | 50 | 20 | 3.0 | 17.4 | 12.7 | 86.2 | 0.55 | 0.41 |
| time | B | 5 | 191 | 1.0 | 2.0 | 6.6 | 9.6 | 0.90 | 0.65 |
| time | B | 10 | 101 | 3.0 | 3.0 | 12.7 | 16.4 | 0.66 | 0.40 |
| time | B | 50 | 19 | 7.5 | 20.3 | 37.2 | 103.8 | 0.34 | 0.22 |
| time | A | 5 | 191 | 1.0 | 2.0 | 6.6 | 9.6 | 0.90 | 0.65 |
| time | A | 10 | 101 | 2.5 | 3.0 | 12.3 | 16.4 | 0.68 | 0.42 |
| time | A | 50 | 19 | 4.8 | 21.0 | 23.3 | 106.3 | 0.41 | 0.31 |
| bursty | B | - | 44 | 0.0 | 22.9 | 0.0 | 13.7 | 0.81 | 0.86 |
| bursty | A | - | 44 | 0.0 | 21.3 | 0.0 | 12.9 | 0.83 | 0.87 |

## Estimator comparison — matched median displacement

Optimal 1-1 assignment of estimate to truth; three point estimates: MAP schedule, per-index posterior median, single posterior draw.

| family | era | N | MAP (votes) | median (votes) | draw (votes) | MAP (s) | median (s) | draw (s) |
|---|---|---|---|---|---|---|---|---|
| fixed | B | 5 | 2.0 | 2.0 | 2.0 | 13.7 | 12.3 | 20.8 |
| fixed | B | 10 | 5.0 | 2.5 | 5.0 | 23.3 | 12.2 | 27.3 |
| fixed | B | 50 | 3.0 | 2.0 | 5.0 | 16.0 | 9.7 | 25.2 |
| fixed | A | 5 | 1.0 | 2.0 | 2.0 | 9.9 | 11.9 | 15.2 |
| fixed | A | 10 | 3.0 | 2.5 | 5.0 | 25.4 | 12.5 | 26.7 |
| fixed | A | 50 | 2.0 | 1.0 | 4.0 | 10.0 | 6.1 | 18.6 |
| poisson | B | 5 | 17.0 | 12.0 | 4.0 | 32.1 | 20.1 | 20.2 |
| poisson | B | 10 | 26.0 | 13.0 | 8.0 | 49.9 | 21.2 | 24.6 |
| poisson | B | 50 | 35.5 | 10.5 | 11.0 | 182.8 | 44.9 | 40.0 |
| poisson | A | 5 | 23.0 | 12.0 | 3.0 | 42.5 | 22.3 | 20.4 |
| poisson | A | 10 | 34.0 | 14.8 | 7.0 | 65.9 | 35.2 | 32.2 |
| poisson | A | 50 | 43.5 | 40.8 | 5.0 | 184.1 | 168.0 | 23.2 |
| time | B | 5 | 5.0 | 2.5 | 3.0 | 23.8 | 18.0 | 41.0 |
| time | B | 10 | 36.0 | 9.5 | 8.0 | 75.5 | 31.5 | 35.3 |
| time | B | 50 | 59.0 | 26.0 | 31.5 | 203.5 | 104.3 | 156.3 |
| time | A | 5 | 7.0 | 2.5 | 3.0 | 18.9 | 18.0 | 30.8 |
| time | A | 10 | 31.0 | 10.0 | 11.0 | 66.3 | 31.7 | 46.0 |
| time | A | 50 | 50.0 | 26.0 | 29.0 | 98.1 | 133.3 | 147.1 |
| bursty | B | - | 0.5 | 0.5 | 0.0 | 0.0 | 0.0 | 0.0 |
| bursty | A | - | 0.5 | 0.5 | 0.0 | 0.0 | 0.0 | 0.0 |

## Posterior concentration

| family | era | N | MAP mass | distinct schedules (of 200) | median needed sorting |
|---|---|---|---|---|---|
| fixed | B | 5 | 2.53e-148 | 200 | no |
| fixed | B | 10 | 4.27e-82 | 200 | no |
| fixed | B | 50 | 1.06e-16 | 200 | no |
| fixed | A | 5 | 5.71e-140 | 200 | no |
| fixed | A | 10 | 1.22e-75 | 200 | no |
| fixed | A | 50 | 8.09e-13 | 200 | no |
| poisson | B | 5 | 7.76e-164 | 200 | no |
| poisson | B | 10 | 4.29e-93 | 200 | no |
| poisson | B | 50 | 7.74e-17 | 200 | no |
| poisson | A | 5 | 2.37e-153 | 200 | no |
| poisson | A | 10 | 1.06e-84 | 200 | no |
| poisson | A | 50 | 1.67e-12 | 200 | no |
| time | B | 5 | 3.16e-156 | 200 | no |
| time | B | 10 | 1.34e-95 | 200 | no |
| time | B | 50 | 5.47e-15 | 200 | no |
| time | A | 5 | 1.39e-147 | 200 | no |
| time | A | 10 | 7.81e-84 | 200 | no |
| time | A | 50 | 4.63e-13 | 200 | no |
| bursty | B | - | 5.75e-14 | 200 | no |
| bursty | A | - | 3.21e-11 | 200 | no |
