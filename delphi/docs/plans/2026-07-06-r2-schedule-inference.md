# R2 Schedule Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement posterior inference of the latent recompute schedule (the "cut sequence") of a historic Polis conversation from its append-only votes table, per the model in `delphi/scratch/r2-inference/R2_schedule_inference.pdf` (host session artifact) and `delphi/docs/REPLAY_HARNESS_DESIGN.md` §10 (on the parity-stack chain; not in this chain's history — do not look for it here).

**Architecture:** A new self-contained package `polismath/replay/` implementing the L0→L2 algorithm ladder: deterministic physics pruning (L0), candidate proposal scans (L1a), an *exact* changepoint dynamic program with Plackett–Luce mark emissions on the prefix-sufficient surrogate model (L1, the workhorse), and self-normalized importance-sampling correction toward the chain-dependent model with endpoint potential (L2). A synthetic generator simulates the full production data-generating process (poller physics + weighted routing) to provide ground-truth schedules for testing. No SMC, no MCMC in v1 — L2 is plain IS from exactly-sampleable L1 posteriors.

**Tech Stack:** Python 3.12, numpy (<2), scipy (logsumexp), pytest. No new dependencies.

## Global Constraints

- **uv only** for all Python operations (`uv run pytest`, `uv sync`). Never bare `python`/`pip`.
- **TDD strictly**: BASELINE → RED → GREEN → FULL SUITE → COMMIT for every task. Baseline recorded 2026-07-06: **332 passed, 12 skipped, 58 xfailed** (command below).
- **Workspace**: jj workspace `r2-inference` at `/Users/julien/polis/github/polis-r2-inference`, chain based on `lnqnxusyxvvp` (#2581, `edge--`; chosen because #2585 bumped `anthropic>=0.116.0` which the pmg supply-chain guard doesn't vet yet — rebase onto `edge` when vetting catches up).
- **New files only** — do not modify any existing `polismath/` module, test, or config. The whole diff must be additive.
- Commit via `jj commit -m "..."` (auto-GPG-signed), one commit per task, message style `feat(delphi): replay — <component>` / `test(delphi): replay — <component>`.
- **No PR creation, no spr, no push** without Julien's explicit go.
- pytest invocation (baseline & full-suite steps):
  `uv run pytest tests/ -v --tb=short -n auto --ignore=tests/simplified_repness_test.py --ignore=tests/test_pakistan_conversation.py --ignore=tests/test_postgres_real_data.py --ignore=tests/test_minio_access.py --ignore=tests/test_batch_id.py --ignore=tests/test_math_pipeline_runs_e2e.py`
- Replay-only iteration loop: `uv run pytest tests/replay/ -v --tb=short`
- Debug artifacts go in `delphi/scratch/` (gitignored). Never in tracked dirs.
- Public datasets referenced by **slug glob** (`real_data/*-vw`), never hardcoding report-id directory names in code.

## Model conventions (normative for all tasks)

These fix the math exactly as implemented. Deviations are bugs.

- **Votes**: sorted by `(t_ms, original_index)`, 1-indexed `k = 1..n`. `VoteEvent(k, t_ms, pid, tid, sign, is_revote)`. `sign ∈ {AGREE, DISAGREE, PASS}` (semantic enum; real-data adapters own any sign mapping — export CSVs are sign-flipped vs DB, verify `math/src/polismath/darwin/export.clj:106-113` before era-A real-data use).
- **Slots**: cut slot `i ∈ {1..n}` = "recompute fired after ingesting votes `1..i`". A **Schedule** is a strictly increasing tuple of slots. Slot 0 (empty-batch recompute) is excluded from lattices (weights from empty prefix ≡ default 1 → observationally identical to no cut).
- **Segment scoring**: vote `k` is scored under the weights of the largest cut slot `s < k`; if no such cut, under uniform weights ≡ 1 (production: no `math_main` yet → server defaults every priority to 1). Sentinel `s = -1` denotes "no cut yet". Votes after the last cut form the tail segment, scored under the last cut's weights.
- **Prefix stats** (latest-vote-wins, matching the rating matrix): per tid, `A/D/P` counts of latest votes, `S = A+D+P`; `dom` = set of tids with ≥1 ingested vote.
- **Weights**:
  - Era B (post-2025-03-20): `w(tid) = 49.0` if `tid ∈ dom` else `1.0`.
  - Era A: `w(tid) = 49.0` if meta; else `[(1-p̂)·(E+1)·â·(1 + 8·2^(-S/5))]²` with `p̂=(P+1)/(S+2)`, `â=(A+1)/(S+2)`; `E` supplied by an engine adapter (tests: configured dict, default 0.0). Absent tids default `1.0`.
- **Availability** `S_k` for vote `k` (schedule-independent — key optimization): `{c : created_ms(c) ≤ t_k ∧ mod_ok(c, t_k) ∧ (p_k, c) not voted at any k' < k}`. `mod_ok` from timestamped mod events (strict: mod>0 required; non-strict: mod≥0). c_k itself is always retained in `S_k` even if data is inconsistent (guard + warn).
- **Emission** (partial likelihood on marks): non-revote votes only; per vote, `log[(1-ε)·w(c_k)/Σ_{c∈S_k} w(c) + ε/|S_k|]`, default `ε = 0.02`. Revotes are excluded from emission but included in prefix stats.
- **Moderation approximation (documented, v1)**: mod events affect availability only, not the weight domain. Exact for era B; approximation for era A.
- **Prior**: (a) forced slots must be cut (DP forbids spanning); (b) segment-count dimension with `T ∈ [T_min, T_max]` (tick-count side-info), or geometric per-cut penalty `log γ` when unconstrained.
- **DP**: log-domain. `seg(i,j) = Σ_{k∈(i,j], non-revote} emission(k; weights(prefix_i))`. Forward `α(j,t)`, backward with tail segment, cut marginals, max-product MAP, exact backward sampling. Ground truth for tests: brute-force enumeration over all valid subsets of a ≤12-slot lattice, equality within 1e-9.

## File Structure

```
polismath/replay/__init__.py      # public API re-exports
polismath/replay/types.py         # VoteEvent, CommentMeta, ModEvent, ReplayDataset, Schedule
polismath/replay/weights.py       # PrefixStats (incremental), era_b_weights, era_a_weights
polismath/replay/emission.py      # AvailabilityIndex, segment_loglik (O(1)/vote denominators)
polismath/replay/physics.py       # forced cuts, CandidateLattice
polismath/replay/scan.py          # L1a candidate proposals (first-vote, moderation, burst thinning)
polismath/replay/dp.py            # L1 exact DP: forward/backward/marginals/MAP/sampling
polismath/replay/correction.py    # L2 self-normalized IS + ESS; EngineForward protocol
polismath/replay/synthetic.py     # generative simulator with ground truth
polismath/replay/real_data.py     # export-CSV loader (slug glob), era detection by date
tests/replay/test_types.py
tests/replay/test_weights.py
tests/replay/test_emission.py
tests/replay/test_synthetic.py
tests/replay/test_physics.py
tests/replay/test_dp.py           # includes brute-force enumeration oracle
tests/replay/test_scan.py
tests/replay/test_end_to_end.py   # synthetic recovery, calibration, edge-case battery
tests/replay/test_correction.py
tests/replay/test_real_data.py    # semi-synthetic on vw timings + smoke with diagnostics
```

Interfaces between tasks are pinned in each task's **Produces** block; later tasks must import exactly those names.

---

### Task 1: types.py — events, dataset, schedule

**Files:** Create `polismath/replay/{__init__,types}.py`, `tests/replay/{__init__,test_types}.py`

**Produces:**
```python
class Vote(IntEnum): AGREE=1; DISAGREE=-1; PASS=0     # semantic; adapters map external signs
@dataclass(frozen=True) class VoteEvent:  k:int; t_ms:int; pid:int; tid:int; sign:int; is_revote:bool
@dataclass(frozen=True) class CommentMeta: tid:int; created_ms:int; is_meta:bool=False
@dataclass(frozen=True) class ModEvent:   t_ms:int; tid:int; mod:int    # mod ∈ {-1,0,1}
Schedule = tuple[int, ...]
@dataclass class ReplayDataset:
    votes: list[VoteEvent]; comments: dict[int, CommentMeta]
    mod_events: list[ModEvent]; strict_moderation: bool = False
    @classmethod
    def build(cls, raw_votes: list[tuple[int,int,int,int]],  # (t_ms, pid, tid, sign)
              comments: dict[int, CommentMeta] | None = None,   # None → infer created=first vote t
              mod_events: list[ModEvent] = (), strict_moderation: bool = False) -> "ReplayDataset"
    def segments(self, schedule: Schedule) -> list[tuple[int,int]]  # [(-1|s_j, s_{j+1}|n)] half-open on left
```
`build` sorts votes by `(t_ms, input_order)`, assigns k=1..n, flags revotes ((pid,tid) seen before), validates schedule helpers (strictly increasing, 1≤s≤n).

Steps: failing tests (sorting stability, revote flagging, inferred comment creation, segments incl. sentinel head and tail) → run RED → implement → GREEN → commit.

### Task 2: weights.py — prefix stats + era A/B formulas

**Files:** Create `polismath/replay/weights.py`, `tests/replay/test_weights.py`

**Produces:**
```python
DEFAULT_WEIGHT = 1.0; META_WEIGHT = 49.0
@dataclass class PrefixStats:
    A: dict[int,int]; D: dict[int,int]; P: dict[int,int]
    latest: dict[tuple[int,int], int]   # (pid,tid) -> sign, latest-wins
    dom: set[int]
    def push(self, v: VoteEvent) -> None      # incremental, handles revote signs (decrement old, increment new)
    def snapshot(self) -> "PrefixStats"        # deep-enough copy for memoization
def era_b_weights(stats: PrefixStats) -> dict[int, float]
def era_a_weights(stats: PrefixStats, extremity: Mapping[int,float], meta_tids: set[int]) -> dict[int, float]
def prefix_stats_at_slots(votes: list[VoteEvent], slots: Sequence[int]) -> dict[int, PrefixStats]  # one pass, snapshots
```

Hand-computed RED values (must appear in tests verbatim):
- tid with A=1,D=0,P=0 (S=1), E=0: `p̂=1/3, â=2/3, imp=(2/3)·1·(2/3)=4/9`; boost `1+8·2^(-1/5)=7.9646061`; w=`(4/9·7.9646061)² = 12.5289933` (assert abs tol 1e-6; compute the expected value inside the test from the formula written out longhand, then also assert the numeric literal to guard against formula drift).
- Same with E=2.5: multiply imp by 3.5 → w×3.5².
- Meta tid → exactly 49.0 regardless of stats. Era B: dom→49.0, non-dom absent from map (callers default 1.0).
- Revote A→D flips counts (A:1→0, D:0→1), S unchanged.

### Task 3: emission.py — PL segment log-likelihood

**Files:** Create `polismath/replay/emission.py`, `tests/replay/test_emission.py`

**Produces:**
```python
class AvailabilityIndex:
    def __init__(self, ds: ReplayDataset): ...   # precompute per-vote availability events
    def sweep(self, weights: Mapping[int,float], k_start: int, k_end: int, eps: float = 0.02,
              cum_out: np.ndarray | None = None) -> float
        # sum of per-vote log-lik for votes k in (k_start, k_end]; O(1)/vote via
        # total_available_weight(k) − voted_weight(pid_k, k); revotes skipped
def segment_loglik(idx: AvailabilityIndex, weights, i, j, eps=0.02) -> float
def cumulative_loglik(idx: AvailabilityIndex, weights, i, eps=0.02) -> np.ndarray
    # cum[j] = Σ_{k∈(i,j]} loglik under `weights`; enables seg(i,j)=cum[j]−cum[i] per left node
```
Implementation note: per left node one full sweep k=i+1..n maintaining (a) running total weight of available comments (comment-creation and mod events applied at their timestamps; weight looked up in `weights` with default 1.0), (b) per-pid voted-weight sums; each vote: denominator = total − voted[pid]; guard denominator ≥ w(c_k) (warn, clamp). Emission term `log((1-eps)*w/denom + eps/n_avail)`; needs available-count too (maintain int counter same way).

RED cases: two comments equal weights → log(1/2); weight 49 vs 1 → log(49/50) (ε=0); participant exhausts all comments (|S_k|=1 → term 0.0 at ε=0); moderated-out comment leaves denominator at its mod timestamp; revote contributes nothing; ε>0 mixture value hand-computed; cum array consistency `seg(i,j)=cum[j]-cum[i]`.

### Task 4: synthetic.py — ground-truth generator

**Files:** Create `polismath/replay/synthetic.py`, `tests/replay/test_synthetic.py`

**Produces:**
```python
@dataclass class SimConfig:
    era: str = "B"                      # "A" | "B"
    n_participants: int = 30; n_comments: int = 20; mean_votes_per_participant: float = 12.0
    duration_s: float = 3600.0; poll_interval_s: float = 1.0
    compute_time_s: float = 5.0; cache_lag_s: float = 0.0
    downtime: list[tuple[float,float]] = field(default_factory=list)   # worker-down windows (sim-seconds)
    restarts: list[float] = field(default_factory=list)                # restart instants → +1 load tick each
    session_quit_prob: float = 0.02; revote_prob: float = 0.01
    meta_frac: float = 0.0; mod_out: list[tuple[float,int]] = field(default_factory=list)  # (t_s, tid)
    extremity: dict[int,float] | None = None                            # era A only
    arrival_rate_per_s: float = 0.02; think_time_s: float = 20.0
    seed: int = 0
@dataclass class SimResult:
    dataset: ReplayDataset; true_schedule: Schedule; true_cut_times_ms: list[int]
    tick_count: int          # cuts + load ticks (initial load + restarts)
    weights_by_segment: list[dict[int,float]]   # ground-truth serve weights (diagnostics)
def simulate(cfg: SimConfig) -> SimResult
```
Event-driven sim: participant sessions (Poisson arrivals, serve→think→vote, quit); comment creation spread over first half of duration; worker: polls each `poll_interval_s` when up and not computing; on new votes, ingest (cut at last ingested vote index), compute for `compute_time_s`, weights become servable `cache_lag_s` later; routing = PL draw over availability with current servable weights (era-appropriate via weights.py); revotes injected outside routing; moderation applied at scripted times.

RED cases: seeded determinism (two runs identical); cuts strictly increasing & within 1..n; every inter-cut gap consistent with physics (no two cuts closer than compute_time); tick_count == len(schedule) + 1 + len(restarts); era-B weights_by_segment values ∈ {1,49}; downtime window contains no cuts; zero-vote config → empty schedule, no crash.

### Task 5: physics.py — L0 lattice

**Files:** Create `polismath/replay/physics.py`, `tests/replay/test_physics.py`

**Produces:**
```python
@dataclass class CandidateLattice:
    slots: list[int]              # sorted, unique, ⊆ 1..n
    forced: set[int]              # ⊆ slots; DP must cut at each
def forced_slots(ds, poll_interval_ms: int, compute_ms: int, downtime_ms: list[tuple[int,int]] = ()) -> set[int]
    # slot i forced iff t_{i+1} − t_i > poll_interval_ms + compute_ms and gap not inside a downtime window
def build_lattice(ds, forced: set[int], extra: set[int], max_slots: int = 400, burst_stride: int = 8) -> CandidateLattice
    # forced ∪ extra ∪ thinned burst slots (every `burst_stride`-th slot in runs with no candidate), capped
```
RED: synthetic with well-separated bursts → every true cut is forced or within stride of a candidate; downtime suppresses forcing; cap respected with forced slots always retained.

### Task 6: dp.py — L1 exact DP (vs brute force)

**Files:** Create `polismath/replay/dp.py`, `tests/replay/test_dp.py`

**Produces:**
```python
@dataclass class PriorConfig:
    log_gamma: float = -3.0                 # per-cut penalty (unconstrained mode)
    t_range: tuple[int,int] | None = None   # inclusive count constraint (constrained mode)
@dataclass class DPResult:
    log_Z: float; cut_marginals: dict[int,float]; map_schedule: Schedule; map_logpost: float
def run_dp(idx: AvailabilityIndex, lattice: CandidateLattice,
           weights_at: Mapping[int, Mapping[int,float]],   # left-node → weights (node -1 = uniform)
           prior: PriorConfig, eps: float = 0.02) -> tuple[DPResult, "DPState"]
def sample_schedules(state: DPState, n: int, rng: np.random.Generator) -> list[Schedule]
def log_posterior(idx, lattice, weights_at, prior, schedule, eps) -> float   # direct scorer (shared with tests & L2)
```
Node set: `[-1] + lattice.slots`, terminal `n`. Precompute `cum_i = cumulative_loglik(idx, weights_at[i], i)` per left node → `seg(i,j) = cum_i[j] − cum_i[i]`. Transitions `i→j` forbidden if a forced slot lies in `(i,j)`. Constrained mode adds count dimension `t ≤ T_max`.
Brute-force oracle in tests: enumerate all subsets of lattice.slots respecting forced/count constraints, score with `log_posterior`, compare: `log_Z` (logsumexp), every cut marginal, MAP schedule, and empirical frequencies of 4000 `sample_schedules` draws (χ²-loose, tol 4σ). Lattice sizes 6–10, n≈30, era B and era A weights.

### Task 7: scan.py + end-to-end synthetic recovery

**Files:** Create `polismath/replay/scan.py`, `tests/replay/test_scan.py`, `tests/replay/test_end_to_end.py`

**Produces:**
```python
def propose_candidates(ds: ReplayDataset) -> set[int]   # first-vote slots per tid, slots at mod-event times
def infer_schedule(ds, *, era, poll_interval_ms, compute_ms, extremity=None, meta_tids=frozenset(),
                   prior=PriorConfig(), eps=0.02, max_slots=400) -> tuple[DPResult, DPState, CandidateLattice]
    # convenience pipeline: physics → scan → lattice → prefix weights → run_dp
```
End-to-end RED battery (each a named test):
- `test_recover_era_b_moderate`: 30 ptpts/20 cmts sim; assert every true cut has marginal ≥0.5 or lies within 1 slot of such; MAP within 1 slot of truth for ≥80% of cuts; no phantom cut with marginal ≥0.5 farther than 2 slots from any true cut.
- `test_recover_era_a_sharper`: era A with spread extremities; recovery strictly no worse than era B on matched seeds.
- `test_calibration`: 20 seeds; nominal ≥50%-marginal detection precision/recall reported; assert recall ≥0.7, precision ≥0.7 (loose v1 floor; tighten later).
- Edge battery: zero votes; one vote; all-votes-one-burst (single batch: posterior mass on few/no cuts); every-vote-its-own-batch (sparse arrivals: forced cuts everywhere, DP trivially recovers); downtime mid-conv; restart double-tick; fresh-comment flood; participant exhaustion; mod-out mid-stream; count-constrained vs unconstrained agreement when T_true ∈ range.

### Task 8: correction.py — L2 IS

**Files:** Create `polismath/replay/correction.py`, `tests/replay/test_correction.py`

**Produces:**
```python
class EngineForward(Protocol):
    def forward(self, ds, schedule) -> tuple[float, np.ndarray]   # (true traj loglik, endpoint features)
@dataclass class ISResult:
    schedules: list[Schedule]; log_weights: np.ndarray; ess: float
    def weighted_marginals(self) -> dict[int,float]
def is_correct(ds, state: DPState, surrogate_logpost: Callable[[Schedule],float],
               engine: EngineForward, endpoint_obs: np.ndarray | None, endpoint_scale: float,
               n_samples: int, rng) -> ISResult
```
Test engine `ToyChainEngine`: era-B weights but with an EMA-carried extremity across cuts (chain-dependent) + endpoint = final EMA vector. Construct sim where chain effect displaces one boundary; assert L2 weighted marginals move toward truth vs L1 (KL or absolute-marginal improvement) and `ess ≥ n_samples/10`.

### Task 9: real_data.py — vw semi-synthetic + smoke

**Files:** Create `polismath/replay/real_data.py`, `tests/replay/test_real_data.py`

**Produces:**
```python
def load_export_votes(dataset_slug: str) -> ReplayDataset
    # glob real_data/*-{slug}/*-votes.csv; columns timestamp(s),datetime,comment-id,voter-id,vote
    # t_ms = timestamp*1000; sign mapping documented EXPORT-side (flip caveat); era-A use requires sign audit first
```
Tests (skip cleanly if dataset dir absent):
- `test_vw_loads`: 4683 votes, sorted, revotes flagged (expect ~87 per harness doc §5).
- `test_vw_semi_synthetic_recovery`: real timestamps/pids/tids; regenerate marks by simulating cuts (physics on real gaps) + era-B routing; recover: recall/precision ≥0.7 on forced-cut-dominated truth.
- `test_vw_smoke_real_marks`: full pipeline on the *actual* votes (era-A conv, surrogate E=0 → documented misspecification): assert finite log_Z, runtime < 120 s, marginals well-formed, and report top-10 cuts + tick-per-day profile into `scratch/r2-vw-smoke.json` for human review. **No accuracy claim.**
- `test_perf_guard`: synthetic n=50_000, |C|≈300 → `run_dp` < 60 s (forced-cut windowing keeps sweeps short; optimize only if this fails).

### Task 10: docs + final suite + report

README in `polismath/replay/` (model summary, API example, era caveats, pointers to the PDF/design doc by name); full-suite run compared to baseline; tidy `jj log`; final report (no PR without go).

---

## Execution notes (2026-07-06, post-implementation — deviations from the plan above)

All tasks executed and green (full suite: 424 passed = 332 baseline + 92 replay; 0 regressions). Deviations discovered by iteration, now normative:

1. **Emission delay is modeled, not ignored** (plan said "v1 ignores δ"): votes cast during a recompute are served under the previous weights; at 30 s compute that is a whole segment. `emission_delay_ms` shifts emission changepoints (`dp._emission_shift`), default = `compute_ms` in `infer_schedule`.
2. **Soft renewal idle prior added** (`idle_lambda_per_s`, `renewal_compute_ms`): an up worker with pending votes recomputes at the first free poll; unexplained idleness is exponentially penalized (soft ⇒ robust to unknown stalls). This is what pins cuts in emission-flat stretches.
3. **Min-spacing constraint added** (sound: forbids a transition only when even the maximal wall-time spacing cannot reach one fastest compute).
4. **Count-constrained runs densify the lattice** (stride 1): thinning + spacing + exact count creates spurious `InfeasibleScheduleError` on representative slots. Dense mode is for n up to a few thousand; large-n uses the unconstrained prior.
5. **Sim gained `compute_jitter`**: constant compute makes the true schedule deterministic given vote times (physics-only solvable) — jitter makes recovery tests honest.
6. **Metrics**: MAP sorted-pairing displacement is a misleading metric (one insertion cascades); the suite asserts posterior localization (median-over-samples nearest distance: 1 vote median, p90 2 synthetic) and coverage@3 (≥ 0.92 observed). On bursty real skeletons (vw: median inter-vote gap 0 s) localization is asserted in TIME (~10 s median ≈ compute-jitter window, physics-limited).
7. `cumulative_loglik` grew `k_stop` (sweep to the next forced cut) — the perf-guard enabler (17k votes, unconstrained: well under 60 s).
