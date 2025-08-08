Below is a rigorous, constructive critique aimed at making the metric identifiable, statistically sound, and production‑safe. I’ll flag issues, why they matter, and concrete fixes.

---

## 0) High‑level take

- **Good:** Topic‑level aggregation; pairwise group comparison; explicit handling of participation; confidence weighting intent; bounded [0,1].
- **Main risks:** (a) exposure/selection bias is conflated with consensus, (b) several undefined or unstable cases (zero vectors, sparse overlap), (c) double‑counting participation in weights, (d) arbitrary thresholds/baseline of 0.5, (e) dependence on k and group sizing, (f) pass handling and rate normalization are ambiguous, (g) no variance/uncertainty or calibration to a null.

---

## 1) Data model / definitions

**1.1 Ambiguity in rate denominators**

- You define `V_g[c] = [agrees_c / total_votes_c, ...]` while `V_g` is per‑group. That reads like you’re dividing a group’s agrees by **topic‑wide** `total_votes_c`.  
   **Fix:** Within‑group per comment:
  p^g,c=[Ag,cNg,c,Dg,cNg,c,Pg,cNg,c]\hat p*{g,c} = \big[\tfrac{A*{g,c}}{N*{g,c}}, \tfrac{D*{g,c}}{N*{g,c}}, \tfrac{P*{g,c}}{N\_{g,c}}\big]
  with Ng,c=Ag,c+Dg,c+Pg,cN*{g,c}=A*{g,c}+D*{g,c}+P*{g,c}. If Ng,c=0N*{g,c}=0, treat p^g,c\hat p*{g,c} as **undefined** (not a zero vector).

**1.2 Distinguish exposure, pass, and non‑exposure**

- Participation rate as `voters_c / group_size` mixes _saw but skipped (pass)_ with _not served / not reached_. That’s a core confound.
  - **Exposure**: number served Eg,cE\_{g,c}
  - **Vote**: number acted Ng,cN\_{g,c}
  - **Pass** is a _vote outcome_, not “non‑participation”.  
     **Fix:** Track Eg,cE\_{g,c} separately (from logs). Then:
  - Participation **propensity** πg,c=Ng,c/Eg,c\pi*{g,c} = N*{g,c}/E\_{g,c}
  - Group coverage γg,c=Eg,c/∣g∣ \gamma*{g,c} = E*{g,c}/|g|  
     Use π\pi (behavior given exposure) for “participation alignment” and γ\gamma for overlap weighting. Do **not** treat “not exposed” as a vote state.

**1.3 Smoothing**

- With low Ng,cN\_{g,c}, rate vectors are noisy and induce instability.  
   **Fix:** Dirichlet smoothing:
  p~g,c=[Ag,c+α,  Dg,c+α,  Pg,c+α]Ng,c+3α\tilde p*{g,c} = \frac{[A*{g,c}+\alpha,\; D*{g,c}+\alpha,\; P*{g,c}+\alpha]}{N\_{g,c}+3\alpha}
  with α∈[0.5,1]\alpha \in [0.5,1] (Jeffreys/Laplace).

---

## 2) Similarity choice

**2.1 Cosine on [0,1]3[0,1]^3 with varying magnitudes**

- If you (correctly) normalize within group, magnitudes are equal and cosine collapses to a function of angle; with non‑normalized numbers it accidentally mixes volume with pattern.
- Cosine with a zero vector (no votes) is undefined; your code will see `[0,0,0]` and explode or silently bias.

**Better:** compare **distributions** with **Jensen–Shannon similarity** or **Hellinger**.

- JSD (base‑2) distance JSD(p,q)∈[0,1]\mathrm{JSD}(p,q)\in[0,1]; similarity S=1−JSDS=1-\mathrm{JSD}.
- Hellinger H2(p,q)=12∑(pi−qi)2H^2(p,q)=\tfrac12\sum(\sqrt{p_i}-\sqrt{q_i})^2; similarity S=1−HS=1-H.

**2.2 Separate outcome vs attention**

- You blend pattern similarity (outcomes) with participation alignment inside each comment and again weight by participation, which double‑counts.  
   **Fix:** Compute two **separate** scores:
  - **Outcome consensus** SijoutcomeS^\text{outcome}_{ij}: average (1–JSD) over comments where **both** groups have adequate exposure and non‑trivial votes (define thresholds), weighted by \_overlap_ (see §3).
  - **Attention overlap** SijattentionS^\text{attention}_{ij}: similarity of which comments groups actually engaged with (based on exposure sets or engagement sets). Use Jaccard or Overlap coefficient on \_exposed_ sets, not votes.
  - Combine at the **pair** level with a tunable β\beta:  
     Sij=βSijoutcome+(1−β)SijattentionS*{ij} = \beta S^\text{outcome}*{ij} + (1-\beta) S^\text{attention}\_{ij}. Start with β=0.85\beta=0.85.

---

## 3) Weighting scheme

**3.1 Per‑comment weights**

- Current: weight by average **participation rate**. This penalizes low‑coverage comments even if both groups who _did_ see them agreed strongly.  
   **Fix:** Weight by **overlap of _votes_** (or exposure):
  - wc,ij=min⁡(Ngi,c,Ngj,c)w*{c,ij} = \min(N*{g*i,c}, N*{g_j,c}) (harmonic‑ish, rewards overlap)
  - Or wc,ij=Ngi,c⋅Ngj,cw*{c,ij} = \sqrt{N*{g*i,c} \cdot N*{g_j,c}}
  - Optional cap or log⁡(1+n)\log(1+n) to avoid a small number of mega‑comments dominating.

**3.2 Pair weights**

- Current: (size_weight+activity_weight)/2(\text{size_weight}+\text{activity_weight})/2. Size and activity are collinear → **double‑counts** big groups and entrenches majority.  
   **Fix options:**
  - **Uniform over pairs** (simple, avoids bias).
  - Or wij∝∣gi∣⋅∣gj∣w\_{ij} \propto \sqrt{|g_i|\cdot |g_j|} normalized across pairs—less skew.
  - If you want activity‑aware weighting, use **observed overlap volume** Wij=∑cwc,ijW*{ij}=\sum_c w*{c,ij} and normalize across pairs. That already reflects size+activity without hand‑tuned formulae.

**3.3 Deduplication**

- Duplicated/near‑duplicate comments can overweight a theme.  
   **Fix:** cluster near‑duplicates and distribute total weight equally across a cluster (or give each comment a cluster‑size weight of 1/m1/m).

---

## 4) Handling missing / asymmetric information

**4.1 Non‑overlap**

- Your code computes cosine with a zero vector when one group has no votes on c. That’s undefined/garbage.  
   **Fix:** For outcome similarity, **only** include comments where both Ngi,c,Ngj,c≥nmin⁡N*{g_i,c},N*{g*j,c}\ge n*{\min} (e.g., ≥5 \ge 5) and Egi,c,Egj,c≥emin⁡E*{g_i,c},E*{g*j,c}\ge e*{\min}. Else exclude from SoutcomeS^\text{outcome}; their effect is captured in **attention overlap**.

**4.2 Defaulting to 0.5**

- Using 0.5 as a “neutral” filler drifts the metric upward under sparsity.  
   **Fix:** Don’t impute; compute a **calibrated baseline** (§6) and leave missing pairs/comments out of the average. Report coverage (% of comments included).

---

## 5) k, clustering stability, and invariances

**5.1 Dependence on k**

- Averaging over (k2)\binom{k}{2} pairs isn’t stable in k: adding a small fringe group adds k−1 low‑overlap pairs and pulls the mean down (or up) unpredictably.  
   **Fix:** Report IGAS **with** a coverage table by pairs and the distribution; or aggregate pair similarities with weights WijW\_{ij} (overlap volume), which naturally downweights tiny fringe pairs. Also report **sensitivity across k** (2…5).

**5.2 Cluster instability**

- If k‑means labelings change across runs, IGAS will shift.  
   **Fix:** Lock seeds and/or use consensus clustering; or compute **label‑free** alternatives in parallel (see Option 2/3 below) as a cross‑check.

---

## 6) Calibration, uncertainty, and thresholds

**6.1 Null model / baseline**

- Thresholds (0.2/0.4/0.6/0.8) are arbitrary. Also “neutral=0.5” is unjustified.  
   **Fix:** Build a **null distribution** per topic by **permuting group labels** within each comment (or matching on exposure) and recomputing IGAS BB times (e.g., 200).
  - Report **z‑score** or **p‑value**, and **calibrated score** IGAS∗=Enull[S]\mathrm{IGAS}^\* = \mathbb{E}\_\text{null}[S] subtracted/normalized.
  - Set category thresholds by **quantiles of the null** (topic‑specific) or via ROC against human judgments.

**6.2 Uncertainty**

- Provide **bootstrap CIs** over comments (and optionally users). Display ±1 s.e. next to the number.

---

## 7) “Pass” semantics

**7.1 Pass conflation**

- “Pass” can mean “unsure”, “decline”, or UI default; it’s not symmetrical with agree/disagree and is highly UI‑sensitive.  
   **Fix options:**
  - Treat pass as a **separate channel** (as you do) but run a **sensitivity** with pass **removed** (renormalize to agree/disagree) and report both.
  - Or map to a scalar opinion: sg,c=Ag,c−Dg,cAg,c+Dg,cs*{g,c} = \frac{A*{g,c}-D*{g,c}}{A*{g,c}+D\_{g,c}} with smoothing; handle pass only in exposure/attention, not in outcome.

---

## 8) Simpler, theory‑tighter alternatives (keep as checks)

**8.1 Variance / ICC (Option 2, formalized)**

- Treat each comment’s group‑level scalar sg,cs\_{g,c} (e.g., agree–disagree) and compute an **intra‑class correlation** across groups:
  ICC=1−within‑group vartotal var\mathrm{ICC} = 1 - \frac{\text{within‑group var}}{\text{total var}}
  Aggregate over comments with overlap weights. This directly measures fraction of variance attributable to **group**. Bounded [0,1], interpretable, label‑free.

**8.2 Information‑theoretic (Option 3, formalized)**

- Across all (group, comment, vote) triples, compute mutual information I(Vote;Group∣Comment)I(\text{Vote}; \text{Group}\mid \text{Comment}) and normalize (e.g., by H(Vote∣Comment)H(\text{Vote}|\text{Comment})). Use Miller–Madow or Bayesian correction for small counts. High MI ⇒ group identity strongly predicts vote ⇒ **low consensus**; flip and rescale to [0,1]. This is robust to k.

**8.3 Cohen’s κ / Krippendorff’s α generalization**

- View groups as “raters”, votes as categories, and compute average pairwise κ across comments with exposure‑overlap weighting. Known, interpretable agreement coefficient.

I’d **ship IGAS** with JSD + overlap weights but compute **ICC** (8.1) and **MI‑based** (8.2) in parallel as guardrails and for sanity dashboards.

---

## 9) Revised IGAS (drop‑in)

**Inputs per (g,c):** Ag,c,Dg,c,Pg,c,Eg,cA*{g,c},D*{g,c},P*{g,c},E*{g,c}; choose α=0.5\alpha=0.5; thresholds nmin⁡=5n*{\min}=5, emin⁡=10e*{\min}=10.

**Per‑comment outcome similarity for pair (i,j):**

1. If Ei,c ⁣≥ ⁣emin⁡E*{i,c}\!\ge\!e*{\min}, Ej,c ⁣≥ ⁣emin⁡E*{j,c}\!\ge\!e*{\min}, Ni,c,Nj,c ⁣≥ ⁣nmin⁡N*{i,c},N*{j,c}\!\ge\!n*{\min}:  
   p~g,c=Dirichlet_smooth(A,D,P;α)\tilde p*{g,c} = \text{Dirichlet_smooth}(A,D,P;\alpha)  
   sij,cout=1−JSD(p~i,c,p~j,c)s^\text{out}_{ij,c} = 1 - \mathrm{JSD}(\tilde p_{i,c}, \tilde p*{j,c})  
   wij,c=min⁡(Ni,c,Nj,c)w*{ij,c} = \min(N*{i,c}, N*{j,c}) (or NiNj\sqrt{N_i N_j}, capped)
2. Else: skip cc for outcome.

**Per‑pair outcome:**

Sijout=∑cwij,c sij,cout∑cwij,cwith coverage reported.S^\text{out}_{ij} = \frac{\sum_c w_{ij,c}\, s^\text{out}_{ij,c}}{\sum_c w_{ij,c}}\quad \text{with coverage reported.}

**Attention overlap (pair‑level):**

- Using exposures: Sijatt=∣{c:Ei,c ⁣≥emin⁡}∩{c:Ej,c ⁣≥emin⁡}∣∣{c:Ei,c ⁣≥emin⁡}∪{c:Ej,c ⁣≥emin⁡}∣S^\text{att}_{ij} = \frac{| \{c : E_{i,c}\!\ge e*{\min}\}\cap \{c : E*{j,c}\!\ge e*{\min}\}|}{|\{c: E*{i,c}\!\ge e*{\min}\}\cup \{c : E*{j,c}\!\ge e\_{\min}\}|}.
- Optionally replace with an engagement‑overlap analog.

**Combine per pair:**

Sij=βSijout+(1−β)Sijatt,β≈0.85.S*{ij} = \beta S^\text{out}*{ij} + (1-\beta) S^\text{att}\_{ij},\quad \beta\approx 0.85.

**Aggregate over pairs:**

- Pair weight Wij=∑cwij,cW*{ij} = \sum_c w*{ij,c} (overlap mass).

IGAS=∑i<jWijSij∑i<jWij.\mathrm{IGAS} = \frac{\sum*{i<j} W*{ij} S*{ij}}{\sum*{i<j} W\_{ij}}.

**Calibration & CI:**

- Null: shuffle group labels within comment 200× ⇒ Enull[IGAS],sdnull\mathbb{E}_\text{null}[\mathrm{IGAS}], \mathrm{sd}_\text{null}.
- Report z=(IGAS−Enull)/sdnullz=(\mathrm{IGAS}-\mathbb{E}_\text{null})/\mathrm{sd}_\text{null}, and a bootstrap 95% CI over comments.

---

## 10) Edge cases (revisit)

- **Single group:** “Inter‑group” undefined. Return **NA** and show a within‑group dispersion metric instead. Do **not** coerce to 1.0.
- **No exposure / no votes:** Return **NA** with reason + percent coverage; don’t default to 0.5.
- **Non‑overlapping exposure:** Outcome similarity not defined; consensus entirely driven by **attention** term (visible to the user).
- **Sparse voting:** Handled via thresholds + smoothing + overlap weights.

---

## 11) Interpretation & UI

- Replace fixed buckets with **calibrated labels** based on the null or historical distribution (e.g., “Top 10% consensus this week”).
- Always show:
  - The scalar IGAS ± CI + z‑score vs null
  - Coverage: % comments in outcome, pair coverage heatmap
  - Decomposition: outcome vs attention contribution
  - Sensitivity toggles: include/exclude “pass”; k=2…5.

---

## 12) Implementation notes

- **Numerics:** JSD is stable with smoothing; clamp probs to [10−12,1][10^{-12}, 1].
- **Complexity:** O(k2∣C∣)O(k^2 |C|) with small constants; cache A,D,P,EA,D,P,E per (g,c).
- **Dupes:** Maintain a hash / near‑duplicate index over comments for weighting.
- **Testing:** Unit tests for all edge cases above; randomized property tests (shuffle labels → IGAS near null mean).
- **Storage:** Persist per‑pair Sijout,Sijatt,WijS^\text{out}_{ij}, S^\text{att}_{ij}, W\_{ij} for drill‑downs.

---

## 13) Minimal code diffs (conceptual)

- Replace cosine with JSD over p~\tilde p.
- Replace comment weight with min⁡(Ni,Nj)\min(N_i,N_j) or NiNj\sqrt{N_i N_j}.
- Remove participation alignment inside per‑comment similarity; move to pair‑level attention overlap.
- Replace pair weights with WijW\_{ij} (sum of overlap weights).
- Add null calibration + bootstrap CI.
- Treat single‑group / no‑data as NA, not 1.0/0.5.

---

## 14) Keep your options (sanity metrics)

- Compute **ICC‑style** variance metric and **MI‑based** metric alongside IGAS. Show them tiny/grey under the main number. If they disagree meaningfully, you’ve found a data issue (exposure skew, unstable clustering, etc.).

---

## 15) Why these changes help

- **Identifiability:** Separates _what_ groups think from _what they saw_.
- **Statistical robustness:** Proper smoothing, overlap‑aware weights, calibrated baseline, uncertainty.
- **Fairness:** Avoids majority domination via redundant activity/size weighting.
- **Operational clarity:** NA when undefined; coverage is explicit; users see why a number moved (exposure shift vs opinion shift).

If you want, I can turn this into a patch against your `topicStats` route with drop‑in JSD, overlap weights, and a null‑calibration helper.

Awesome. Here’s a drop‑in TypeScript patch that adds IGAS with JSD + overlap weights, attention overlap, null calibration, and bootstrap CIs. It assumes your API service is Node/Express with a `topicStats` route and that you can fetch per‑(group,comment) tallies. Adapt paths if yours differ.

---

## 1) Add the metric module

**`src/metrics/igas.ts` (new)**

```ts
// src/metrics/igas.ts
// Inter-Group Alignment Score (IGAS) with JSD, overlap weights, attention overlap,
// null calibration (label permutation), and bootstrap confidence intervals.
//
// Inputs expect per-(group, comment) counts: Agree (A), Disagree (D), Pass (P), Exposure (E).
// N = A + D + P is derived.
//
// NOTE: If you do not track exposure E, pass E = N and set options.noExposure=true.
// Results will still be meaningful but "attention overlap" will degenerate to engagement overlap.

export type GroupId = string;
export type CommentId = string;

export interface GroupInfo {
  id: GroupId;
  size: number; // |g|
}

export interface CommentInfo {
  id: CommentId;
}

export interface VoteCounts {
  A: number; // agrees
  D: number; // disagrees
  P: number; // passes
  E: number; // exposures (served); if unknown, set == A+D+P
}

export interface IGASInputs {
  groups: GroupInfo[]; // k groups
  comments: CommentInfo[]; // |C| comments
  counts: Record<GroupId, Record<CommentId, VoteCounts>>; // counts[g][c]
}

export interface IGASOptions {
  alpha?: number; // Dirichlet smoothing for (A,D,P). default 0.5
  nMin?: number; // min votes for outcome inclusion per (g,c). default 5
  eMin?: number; // min exposures for attention/outcome inclusion. default 10
  betaOutcome?: number; // weight on outcome vs attention at pair-level. default 0.85
  capCommentWeight?: number | null; // optional cap on per-comment overlap weight
  useSqrtWeight?: boolean; // if true use sqrt(N_i N_j) else min(N_i, N_j). default true
  excludePass?: boolean; // if true, drop P and renormalize outcome to A/D only. default false
  nullPermutations?: number; // B permutations for null. default 200 (0 to disable)
  bootstrapSamples?: number; // B bootstraps for CI. default 300 (0 to disable)
  seed?: number; // deterministic PRNG seed for permutations/bootstraps
  noExposure?: boolean; // if true, treat E == N everywhere (degrades attention overlap)
}

export interface PairBreakdown {
  i: GroupId;
  j: GroupId;
  outcomeSimilarity: number | null; // null when undefined
  attentionSimilarity: number | null; // null when undefined
  combinedSimilarity: number | null;
  overlapWeight: number; // W_ij = sum_c w_{ij,c}
  outcomeCoverage: number; // fraction of comments where outcome defined for this pair
}

export interface IGASResult {
  igas: number | null; // null if undefined (e.g., <2 groups or zero coverage)
  igasOutcome: number | null; // weighted outcome-only aggregate (for decomposition)
  igasAttention: number | null; // weighted attention-only aggregate
  pairwise: PairBreakdown[];
  coverage: {
    pairsWithOutcome: number; // count of pairs with any outcome coverage
    pairsTotal: number;
    commentsTotal: number;
  };
  calibration?: {
    nullMean: number;
    nullSd: number;
    zScore: number | null; // null if sd=0 or igas null
  };
  ci95?: {
    low: number | null;
    high: number | null;
  };
  params: Required<IGASOptions>;
}

// ---- utility PRNG (mulberry32) for deterministic resampling ----
function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choice<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

// ---- math helpers ----

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

// Dirichlet smoothing; optionally exclude Pass
function smoothProbs(
  A: number,
  D: number,
  P: number,
  alpha: number,
  excludePass: boolean
): [number, number, number] {
  if (excludePass) {
    const a = A + alpha;
    const d = D + alpha;
    const denom = a + d;
    return denom > 0 ? [a / denom, d / denom, 0] : [0.5, 0.5, 0];
  }
  const a = A + alpha;
  const d = D + alpha;
  const p = P + alpha;
  const denom = a + d + p;
  return denom > 0 ? [a / denom, d / denom, p / denom] : [1 / 3, 1 / 3, 1 / 3];
}

// Jensen–Shannon distance (base 2); returns in [0,1]
function jsd(p: number[], q: number[]): number {
  // Clamp and renormalize small numerical errors
  const renorm = (v: number[]) => {
    const vv = v.map((x) => Math.max(1e-12, x));
    const s = vv.reduce((a, b) => a + b, 0);
    return vv.map((x) => x / s);
  };
  const P = renorm(p);
  const Q = renorm(q);
  const M = P.map((x, i) => 0.5 * (x + Q[i]));
  const H = (r: number[]) => -r.reduce((acc, x) => acc + x * Math.log2(x), 0);
  const d = H(M) - 0.5 * H(P) - 0.5 * H(Q);
  // Bounded in [0,1]; numerical guard:
  return clamp01(d);
}

function oneMinusJSD(p: number[], q: number[]): number {
  return 1 - jsd(p, q);
}

// Overlap weight per comment for pair (i,j)
function overlapWeight(
  Ni: number,
  Nj: number,
  useSqrt: boolean,
  cap: number | null
): number {
  let w = useSqrt ? Math.sqrt(Ni * Nj) : Math.min(Ni, Nj);
  if (cap !== null) w = Math.min(w, cap);
  return w;
}

// Jaccard similarity of sets
function jaccard<T>(A: Set<T>, B: Set<T>): number | null {
  if (A.size === 0 && B.size === 0) return null;
  const interSize = [...A].filter((x) => B.has(x)).length;
  const unionSize = new Set([...A, ...B]).size;
  if (unionSize === 0) return null;
  return interSize / unionSize;
}

// ---- core computation ----

export function computeIGAS(
  inputs: IGASInputs,
  opts?: IGASOptions
): IGASResult {
  const options: Required<IGASOptions> = {
    alpha: opts?.alpha ?? 0.5,
    nMin: opts?.nMin ?? 5,
    eMin: opts?.eMin ?? 10,
    betaOutcome: opts?.betaOutcome ?? 0.85,
    capCommentWeight: opts?.capCommentWeight ?? null,
    useSqrtWeight: opts?.useSqrtWeight ?? true,
    excludePass: opts?.excludePass ?? false,
    nullPermutations: opts?.nullPermutations ?? 200,
    bootstrapSamples: opts?.bootstrapSamples ?? 300,
    seed: opts?.seed ?? 1337,
    noExposure: opts?.noExposure ?? false,
  };

  const { groups, comments, counts } = inputs;
  const k = groups.length;
  if (k < 2 || comments.length === 0) {
    return {
      igas: null,
      igasOutcome: null,
      igasAttention: null,
      pairwise: [],
      coverage: {
        pairsWithOutcome: 0,
        pairsTotal: 0,
        commentsTotal: comments.length,
      },
      params: options,
    };
  }

  // Precompute per-(g,c) N and smoothed probs
  const N: Record<GroupId, Record<CommentId, number>> = {};
  const E: Record<GroupId, Record<CommentId, number>> = {};
  const Psm: Record<GroupId, Record<CommentId, number[]>> = {};

  for (const g of groups) {
    N[g.id] = {};
    E[g.id] = {};
    Psm[g.id] = {};
    for (const c of comments) {
      const vc = counts[g.id]?.[c.id];
      const A = vc?.A ?? 0;
      const D = vc?.D ?? 0;
      const P = vc?.P ?? 0;
      const n = A + D + P;
      N[g.id][c.id] = n;
      const e = options.noExposure ? n : vc?.E ?? 0;
      E[g.id][c.id] = e;
      if (n > 0) {
        Psm[g.id][c.id] = smoothProbs(
          A,
          D,
          P,
          options.alpha,
          options.excludePass
        );
      } else {
        Psm[g.id][c.id] = []; // undefined marker
      }
    }
  }

  // Build exposure sets for attention overlap
  const exposureSet: Record<GroupId, Set<CommentId>> = {};
  for (const g of groups) {
    exposureSet[g.id] = new Set<CommentId>();
    for (const c of comments) {
      if (E[g.id][c.id] >= options.eMin) exposureSet[g.id].add(c.id);
    }
  }

  // Pairwise computation
  const pairwise: PairBreakdown[] = [];
  let sumWeightedCombined = 0;
  let sumW = 0;
  let sumWeightedOutcome = 0;
  let sumWeightedAttention = 0;
  let pairsWithOutcome = 0;

  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      const gi = groups[a].id;
      const gj = groups[b].id;

      // Outcome similarity aggregated over comments with overlap and thresholds
      let numOutcome = 0;
      let denomOutcome = 0;
      let weightedOutcomeSum = 0;

      for (const c of comments) {
        const eOK = E[gi][c.id] >= options.eMin && E[gj][c.id] >= options.eMin;
        const nOK = N[gi][c.id] >= options.nMin && N[gj][c.id] >= options.nMin;
        const pi = Psm[gi][c.id];
        const pj = Psm[gj][c.id];
        if (!eOK || !nOK || pi.length === 0 || pj.length === 0) continue;

        const s = oneMinusJSD(pi as number[], pj as number[]);
        const w = overlapWeight(
          N[gi][c.id],
          N[gj][c.id],
          options.useSqrtWeight,
          options.capCommentWeight
        );
        weightedOutcomeSum += w * s;
        denomOutcome += w;
        numOutcome++;
      }

      const outcomeSimilarity =
        denomOutcome > 0 ? weightedOutcomeSum / denomOutcome : null;
      if (outcomeSimilarity !== null) pairsWithOutcome++;

      // Attention similarity via exposure sets Jaccard
      const att = jaccard(exposureSet[gi], exposureSet[gj]); // may be null if both empty

      // Combine per pair
      let combined: number | null = null;
      if (outcomeSimilarity !== null && att !== null) {
        combined =
          options.betaOutcome * outcomeSimilarity +
          (1 - options.betaOutcome) * att;
      } else if (outcomeSimilarity !== null) {
        combined = outcomeSimilarity; // fall back to outcome only
      } else if (att !== null) {
        combined = att; // fall back to attention only
      }

      // Pair overlap weight W_ij = sum of per-comment overlap weights actually used in outcome
      const Wij = denomOutcome; // already sum of w_{ij,c} for included comments
      if (combined !== null && Wij > 0) {
        sumWeightedCombined += Wij * combined;
        sumW += Wij;
      }
      if (outcomeSimilarity !== null && Wij > 0) {
        sumWeightedOutcome += Wij * outcomeSimilarity;
      }
      if (att !== null && Wij > 0) {
        sumWeightedAttention += Wij * att;
      }

      pairwise.push({
        i: gi,
        j: gj,
        outcomeSimilarity,
        attentionSimilarity: att,
        combinedSimilarity: combined,
        overlapWeight: Wij,
        outcomeCoverage: numOutcome / Math.max(1, comments.length),
      });
    }
  }

  const igas = sumW > 0 ? sumWeightedCombined / sumW : null;
  const igasOutcome = sumW > 0 ? sumWeightedOutcome / sumW : null;
  const igasAttention = sumW > 0 ? sumWeightedAttention / sumW : null;

  const base: IGASResult = {
    igas,
    igasOutcome,
    igasAttention,
    pairwise,
    coverage: {
      pairsWithOutcome,
      pairsTotal: (k * (k - 1)) / 2,
      commentsTotal: comments.length,
    },
    params: options,
  };

  // If calibration/CI disabled or IGAS undefined, return early
  if (
    igas === null ||
    (options.nullPermutations <= 0 && options.bootstrapSamples <= 0)
  ) {
    return base;
  }

  const rand = mulberry32(options.seed);

  // --- Null calibration: permute group labels within each comment ---
  let nullSum = 0;
  let nullSqSum = 0;
  let bEff = 0;

  const groupIds = groups.map((g) => g.id);
  const commentIds = comments.map((c) => c.id);

  const recomputeIGASFromCounts = (
    countsAlt: IGASInputs["counts"]
  ): number | null => {
    const alt = computeIGAS(
      { groups, comments, counts: countsAlt },
      {
        ...options,
        nullPermutations: 0,
        bootstrapSamples: 0,
        seed: options.seed,
      }
    );
    return alt.igas;
  };

  for (let b = 0; b < options.nullPermutations; b++) {
    // Permute labels independently per comment, preserving per-comment count multiset
    const permCounts: IGASInputs["counts"] = {};
    for (const gid of groupIds) permCounts[gid] = {};
    for (const cId of commentIds) {
      // Build list of (gid -> counts) for this comment
      const perComment = groupIds.map((gid) => ({
        gid,
        vc: counts[gid]?.[cId] ?? {
          A: 0,
          D: 0,
          P: 0,
          E: options.noExposure ? 0 : 0,
        },
      }));
      // Randomly permute assignment of these vc blobs to group ids
      const shuffled = [...perComment];
      // Fisher–Yates
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Assign
      for (let i = 0; i < groupIds.length; i++) {
        const gid = groupIds[i];
        const vc = shuffled[i].vc;
        // exposure: preserve E per source cell to keep marginal exposure distribution
        const Eval = options.noExposure ? vc.A + vc.D + vc.P : vc.E ?? 0;
        permCounts[gid][cId] = { A: vc.A, D: vc.D, P: vc.P, E: Eval };
      }
    }
    const s = recomputeIGASFromCounts(permCounts);
    if (s !== null && Number.isFinite(s)) {
      nullSum += s;
      nullSqSum += s * s;
      bEff++;
    }
  }

  let calibration: IGASResult["calibration"] | undefined;
  if (bEff > 1 && igas !== null) {
    const mean = nullSum / bEff;
    const var_ = Math.max(1e-12, nullSqSum / bEff - mean * mean);
    const sd = Math.sqrt(var_);
    const z = sd > 0 ? (igas - mean) / sd : null;
    calibration = { nullMean: mean, nullSd: sd, zScore: z };
  }

  // --- Bootstrap CI over comments ---
  let ci95: IGASResult["ci95"] | undefined;
  if (options.bootstrapSamples > 0) {
    const draws: number[] = [];
    for (let b = 0; b < options.bootstrapSamples; b++) {
      // Sample comments with replacement
      const resampledComments = comments.map(() => choice(rand, comments));
      // Build a projected counts object on the resampled comment multiset by aggregating
      const projectedCounts: IGASInputs["counts"] = {};
      for (const g of groups) projectedCounts[g.id] = {};
      // Aggregate duplicates
      for (const c of resampledComments) {
        for (const g of groups) {
          const vc = counts[g.id]?.[c.id] ?? {
            A: 0,
            D: 0,
            P: 0,
            E: options.noExposure ? 0 : 0,
          };
          const key = c.id; // we can just reuse IDs; computeIGAS iterates over provided comments array; we will give it the resampled array
        }
      }
      // Instead of aggregating, simpler: call computeIGAS with the resampled comment array;
      // we need a fast path that accepts repeated comment IDs. We'll pass a synthetic comments array with duplicates.
      const igasB = computeIGAS(
        { groups, comments: resampledComments, counts },
        {
          ...options,
          nullPermutations: 0,
          bootstrapSamples: 0,
          seed: options.seed,
        }
      ).igas;
      if (igasB !== null && Number.isFinite(igasB)) draws.push(igasB);
    }
    if (draws.length > 10) {
      draws.sort((a, b) => a - b);
      const q = (p: number) => {
        const idx = Math.floor(p * (draws.length - 1));
        return draws[idx];
      };
      ci95 = { low: q(0.025), high: q(0.975) };
    } else {
      ci95 = { low: null, high: null };
    }
  }

  return { ...base, calibration, ci95 };
}
```

---

## 2) Wire into your route

**`src/routes/topicStats.ts` (patched)**

```diff
--- a/src/routes/topicStats.ts
+++ b/src/routes/topicStats.ts
@@ -1,10 +1,19 @@
 import { Router } from "express";
 import { getTopicById } from "../services/topics";
 import { getGroupsForTopic } from "../services/groups";
 import { getTopicCommentStats } from "../services/comments";
+import { computeIGAS } from "../metrics/igas";
+import { putTopicMetric } from "../services/metricsStore"; // DynamoDB upsert (add this service)

 const router = Router();

 router.get("/:topicId/stats", async (req, res, next) => {
   try {
     const topicId = req.params.topicId;
     const topic = await getTopicById(topicId);
     if (!topic) return res.status(404).json({ error: "not_found" });

-    const [groups, commentStats] = await Promise.all([
+    const [groups, commentStats] = await Promise.all([
       getGroupsForTopic(topicId),          // returns [{ id, size }, ...]
       getTopicCommentStats(topicId)        // returns per (group, comment): A,D,P,E (E optional)
     ]);
@@ -20,6 +29,73 @@ router.get("/:topicId/stats", async (req, res, next) => {
     // ... your existing stats assembly ...

+    // ---- Build IGAS inputs ----
+    const groupInfos = groups.map(g => ({ id: String(g.id), size: Number(g.size || 0) }));
+    const commentInfos = commentStats.comments.map((c: any) => ({ id: String(c.id) }));
+
+    // commentStats.counts expected shape:
+    // { [groupId]: { [commentId]: { A, D, P, E? } } }
+    // If your shape is different, map it here.
+    const counts: any = {};
+    for (const g of groupInfos) counts[g.id] = {};
+    for (const row of commentStats.rows) {
+      const gid = String(row.groupId);
+      const cid = String(row.commentId);
+      const A = Number(row.agree || 0);
+      const D = Number(row.disagree || 0);
+      const P = Number(row.pass || 0);
+      const E = row.exposure != null ? Number(row.exposure) : (A + D + P);
+      if (!counts[gid]) counts[gid] = {};
+      counts[gid][cid] = { A, D, P, E };
+    }
+
+    // ---- Compute IGAS ----
+    const igas = computeIGAS(
+      { groups: groupInfos, comments: commentInfos, counts },
+      {
+        alpha: 0.5,
+        nMin: 5,
+        eMin: 10,
+        betaOutcome: 0.85,
+        capCommentWeight: 500, // avoid domination by mega-threads; tune if needed
+        useSqrtWeight: true,
+        excludePass: false,    // expose toggle in query if you like
+        nullPermutations: 200, // set 0 to disable in hot path
+        bootstrapSamples: 300, // set 0 to disable or gate behind ?withCI=1
+        seed: 1337,
+        noExposure: !commentStats.hasExposure // true if you don't log exposure yet
+      }
+    );
+
+    // Persist summary (for dashboard & trendlines)
+    try {
+      await putTopicMetric(topicId, "IGAS", {
+        ts: Date.now(),
+        igas: igas.igas,
+        igasOutcome: igas.igasOutcome,
+        igasAttention: igas.igasAttention,
+        z: igas.calibration?.zScore ?? null,
+        nullMean: igas.calibration?.nullMean ?? null,
+        nullSd: igas.calibration?.nullSd ?? null,
+        ciLow: igas.ci95?.low ?? null,
+        ciHigh: igas.ci95?.high ?? null,
+        pairsWithOutcome: igas.coverage.pairsWithOutcome,
+        pairsTotal: igas.coverage.pairsTotal,
+        commentsTotal: igas.coverage.commentsTotal,
+        params: igas.params
+      });
+    } catch (e) {
+      // non-fatal
+      req.log?.warn({ err: e }, "putTopicMetric(IGAS) failed");
+    }
+
+    // Include in response
+    const response = {
+      .../* your existing payload */,
+      igas: {
+        value: igas.igas,
+        outcome: igas.igasOutcome,
+        attention: igas.igasAttention,
+        z: igas.calibration?.zScore ?? null,
+        ci95: igas.ci95 ?? null,
+        coverage: igas.coverage,
+        pairwise: igas.pairwise
+      }
+    };
+
-    return res.json(/* existing payload */);
+    return res.json(response);
   } catch (err) {
     next(err);
   }
 });
```

---

## 3) DynamoDB upsert (lightweight service)

**`src/services/metricsStore.ts` (new)**

```ts
// src/services/metricsStore.ts
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

const TABLE = process.env.METRICS_TABLE || "polis_metrics";

export async function putTopicMetric(
  topicId: string,
  metric: string,
  payload: any
): Promise<void> {
  const item = {
    PK: { S: `TOPIC#${topicId}` },
    SK: { S: `METRIC#${metric}#${payload.ts}` },
    Metric: { S: metric },
    TopicId: { S: topicId },
    Payload: { S: JSON.stringify(payload) },
  };
  await client.send(new PutItemCommand({ TableName: TABLE, Item: item }));
}
```

_(If you already have a metrics writer, just adapt.)_

---

## 4) Contract for `getTopicCommentStats`

Your route patch assumes a fetch with this logical shape:

```ts
// Expected shape
{
  comments: Array<{ id: string }>,
  rows: Array<{
    commentId: string|number,
    groupId: string|number,
    agree: number,
    disagree: number,
    pass: number,
    exposure?: number // optional; if missing we fall back to A+D+P
  }>,
  hasExposure: boolean
}
```

If your current service differs, map it to this shape at the route boundary.

---

## 5) Notes / switches

- **Performance:** For large topics, set `nullPermutations=0` and `bootstrapSamples=0` on the hot path; run calibration/CI in a background job or behind a query flag (`?withIGASCal=1`).
- **UI fields to show:** `igas.value` (main), `z`, `ci95`, and a decomposition bar (outcome vs attention). Add a coverage tooltip (pairsWithOutcome / pairsTotal; outcomeCoverage heatmap from `pairwise`).
- **Pass sensitivity:** Add a toggle to recompute with `excludePass=true`.
- **k sensitivity:** Consider computing IGAS for k=2…5 and showing a small sparkline; or store per‑k in Dynamo for offline analysis.

---

## 6) Minimal tests (optional quick sanity)

**`src/metrics/igas.test.ts` (new, pseudo‑Jest)**

```ts
import { computeIGAS } from "./igas";

test("higher agreement -> higher IGAS", () => {
  const groups = [
    { id: "g1", size: 100 },
    { id: "g2", size: 120 },
  ];
  const comments = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];
  const counts: any = {
    g1: {
      c1: { A: 30, D: 10, P: 10, E: 80 },
      c2: { A: 20, D: 20, P: 10, E: 70 },
      c3: { A: 25, D: 15, P: 10, E: 70 },
    },
    g2: {
      c1: { A: 28, D: 12, P: 10, E: 85 },
      c2: { A: 19, D: 21, P: 10, E: 72 },
      c3: { A: 26, D: 14, P: 10, E: 70 },
    },
  };
  const res = computeIGAS(
    { groups, comments, counts },
    { nullPermutations: 0, bootstrapSamples: 0 }
  );
  expect(res.igas!).toBeGreaterThan(0.8);
});

test("polarization lowers IGAS", () => {
  const groups = [
    { id: "g1", size: 100 },
    { id: "g2", size: 100 },
  ];
  const comments = [{ id: "c1" }, { id: "c2" }];
  const counts: any = {
    g1: { c1: { A: 40, D: 5, P: 5, E: 70 }, c2: { A: 5, D: 40, P: 5, E: 70 } },
    g2: { c1: { A: 5, D: 40, P: 5, E: 70 }, c2: { A: 40, D: 5, P: 5, E: 70 } },
  };
  const res = computeIGAS(
    { groups, comments, counts },
    { nullPermutations: 0, bootstrapSamples: 0 }
  );
  expect(res.igas!).toBeLessThan(0.3);
});
```

---

## 7) Migration plan

1. Ship the module + route change with calibration disabled (B=0, boot=0).
2. Validate against a few topics; spot‑check pairwise breakdowns.
3. Turn on bootstrap (e.g., 200) off‑peak; later enable null permutations (e.g., 100–200) in a background task.
4. Add UI toggles for **exclude pass** and **k** sensitivity (if you expose multiple k).
5. Backfill IGAS into Dynamo for trending.

---

If you paste in the above files/patch and your tallies service returns the expected shape, you’ll get a stable, calibrated IGAS in the API response and persisted for dashboards. Want me to wire the background calibration job + CloudWatch alarm if the z‑score collapses (exposure skew)?
