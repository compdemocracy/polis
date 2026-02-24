# Representativeness (Repness) Analysis

## 1. Overview

The representativeness module determines which comments best characterize each opinion group. For each (group, comment) pair, it computes:

1. **Proportion test**: Is this group's agreement on this comment significantly different from 50%?
2. **Representativeness ratio**: Does this group agree/disagree more than other groups?
3. **Two-proportion test**: Is the difference between group and others statistically significant?
4. **Composite metric**: Final ranking score combining the above.

---

## 2. Vote Counting

### 2.1 Clojure (`repness.clj:comment-stats-graphimpl`)

```clojure
;; CRITICAL: Vote signs are INVERTED in Clojure repness
;; na counts votes == -1   (which is AGREE in Postgres convention)
;; nd counts votes == 1    (which is DISAGREE in Postgres convention)
;; Comment in code: "Change when we flip votes"
na = count of votes == -1 in group
nd = count of votes == 1 in group
ns = na + nd   ;; total directional votes (excludes pass/nil)
```

### 2.2 Python (`repness.py:comment_stats`, line 133)

```python
n_agree = np.sum(group_votes == AGREE)      # AGREE = 1
n_disagree = np.sum(group_votes == DISAGREE)  # DISAGREE = -1
n_votes = n_agree + n_disagree
```

### 2.3 DISCREPANCY: Vote Sign Convention

This is a **critical semantic difference**. In Clojure, `na` counts votes equal to `-1`, which in the Postgres convention IS the agree vote. In Python, `na` counts votes equal to `+1` (AGREE constant).

Since Delphi flips signs at the Postgres boundary (`postgres_vote_to_delphi()`), AGREE becomes `+1` internally. So both are counting "agrees" — just detecting them with different numeric values. **This is consistent** as long as the sign flip is correctly applied at the boundary.

**Status: CONSISTENT** (but confusing and fragile)

---

## 3. Pseudocount Smoothing (Bayesian Prior)

### 3.1 Clojure (`repness.clj`)

```clojure
pa = (1 + na) / (2 + ns)
pd = (1 + nd) / (2 + ns)
```

This is equivalent to adding 1 virtual agree and 1 virtual disagree to the counts (a Beta(2,2) prior, or equivalently Laplace smoothing with pseudocount=2).

### 3.2 Python (`repness.py`, lines 138–139)

```python
PSEUDO_COUNT = 1.5
pa = (n_agree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT)
   = (n_agree + 0.75) / (n_votes + 1.5)
pd = (n_disagree + PSEUDO_COUNT/2) / (n_votes + PSEUDO_COUNT)
   = (n_disagree + 0.75) / (n_votes + 1.5)
```

### 3.3 DISCREPANCY: Pseudocount Values

| | Clojure | Python |
|---|---------|--------|
| Numerator add | +1 | +0.75 |
| Denominator add | +2 | +1.5 |
| Effective prior | Beta(2,2) | Beta(1.75,1.75) |

**Impact**: Python's weaker prior pulls probabilities less strongly toward 0.5. For small sample sizes (e.g., n=3 votes, 2 agrees):
- Clojure: pa = (1+2)/(2+3) = 0.60
- Python: pa = (2+0.75)/(3+1.5) = 0.611

The effect diminishes with larger samples but matters for small groups.

---

## 4. Proportion Test (p-test)

### 4.1 Clojure (`stats.clj:prop-test`)

```clojure
(defn prop-test [succ n]
  (* 2 (Math/sqrt (inc n)) (+ (/ (inc succ) (inc n)) -0.5)))
```

Expanding: `z = 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)`

This is a **custom formula** that:
- Adds 1 to both `succ` and `n` (pseudocount)
- Tests departure from 0.5
- Uses `2*sqrt(n+1)` as the scaling factor instead of standard error

### 4.2 Python (`repness.py:prop_test`, lines 64–86)

```python
def prop_test(p, n, p0):
    se = math.sqrt(p0 * (1 - p0) / n)
    return (p - p0) / se
```

This is the **standard one-proportion z-test**: `z = (p - p0) / sqrt(p0*(1-p0)/n)`

When `p0 = 0.5`: `z = (p - 0.5) / sqrt(0.25/n) = (p - 0.5) / (0.5/sqrt(n)) = 2*sqrt(n)*(p - 0.5)`

### 4.3 DISCREPANCY: Proportion Test Formula

| | Clojure | Python |
|---|---------|--------|
| Formula | `2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)` | `(p - 0.5) / sqrt(0.25/n)` |
| Pseudocount | +1/+1 built into test | None (uses pre-smoothed p) |
| Denominator | `1/(2*sqrt(n+1))` | `0.5/sqrt(n)` |

For n=10, succ=8:
- Clojure: `2*sqrt(11)*((9/11)-0.5) = 2*3.317*0.318 = 2.11`
- Python (with pa from Clojure's smoothing): p=9/12=0.75, `(0.75-0.5)/sqrt(0.25/10) = 0.25/0.158 = 1.58`

**Impact**: Clojure's test is more liberal (produces larger z-scores), making it easier to reach significance.

### 4.4 Note: Python has TWO different prop_test functions

There is also `stats.py:prop_test` which uses yet another formula:
```python
# stats.py version (NOT used by repness)
succ_adjusted = succ + 1
n_adjusted = n + 2
p = succ_adjusted / n_adjusted
se = math.sqrt(p * (1 - p) / n_adjusted)
z = (p - 0.5) / se
```

This third variant is not used in the repness pipeline. It exists in `stats.py` but is **dead code** relative to repness computation.

---

## 5. Two-Proportion Test (Representativeness Test)

### 5.1 Clojure (`stats.clj:two-prop-test`)

```clojure
(defn two-prop-test [succ1 n1 succ2 n2]
  (let [succ1 (inc succ1) n1 (inc n1)
        succ2 (inc succ2) n2 (inc n2)
        p1 (/ succ1 n1) p2 (/ succ2 n2)
        p  (/ (+ succ1 succ2) (+ n1 n2))]
    (/ (- p1 p2)
       (Math/sqrt (* p (- 1 p) (+ (/ 1 n1) (/ 1 n2)))))))
```

Key: Increments ALL four inputs by 1 before computing.

### 5.2 Python (`repness.py:two_prop_test`, lines 89–115)

```python
def two_prop_test(p1, n1, p2, n2):
    p = (p1 * n1 + p2 * n2) / (n1 + n2)  # pooled proportion
    se = math.sqrt(p * (1 - p) * (1/n1 + 1/n2))
    return (p1 - p2) / se
```

Key: Takes proportions directly (already smoothed), no additional pseudocount.

### 5.3 DISCREPANCY: Two-Proportion Test

Clojure adds pseudocounts (+1 to each of 4 parameters) to prevent division by zero and stabilize estimates. Python takes pre-smoothed proportions and raw counts without additional adjustment.

**Impact**: Different z-scores for the same data, especially at small sample sizes. Clojure is more conservative (z-scores pulled toward 0 by the +1 adjustments).

---

## 6. Representativeness Ratio

### 6.1 Clojure (`repness.clj:add-comparitive-stats`)

```clojure
ra = pa_group / ((1 + sum(na_rest)) / (2 + sum(ns_rest)))
rd = pd_group / ((1 + sum(nd_rest)) / (2 + sum(ns_rest)))
```

The denominator for "others" uses the same pseudocount formula as group stats.

### 6.2 Python (`repness.py:add_comparative_stats`, lines 172–173)

```python
ra = pa_group / other_pa   # other_pa already computed with PSEUDO_COUNT smoothing
rd = pd_group / other_pd
```

**Status: STRUCTURAL MATCH** — Both compute the ratio of group probability to "other" probability. The numeric values differ due to different pseudocount formulas (see Section 3).

---

## 7. Repness Metric (Composite Score)

### 7.1 Clojure (`repness.clj:repness-metric`)

```clojure
(defn repness-metric [{:keys [repness repness-test p-success p-test]}]
  (* repness repness-test p-success p-test))
```

This is a **PRODUCT of 4 values**:
- `repness` = representativeness ratio (ra or rd)
- `repness-test` = two-proportion z-score (rat or rdt)
- `p-success` = agreement probability (pa or pd)
- `p-test` = proportion z-score (pat or pdt)

### 7.2 Python (`repness.py:repness_metric`, lines 189–210)

```python
def repness_metric(stats, key_prefix):
    p = stats[f'p{key_prefix}']         # pa or pd
    p_test = stats[f'p{key_prefix}t']   # pat or pdt
    r = stats[f'r{key_prefix}']         # ra or rd (unused!)
    r_test = stats[f'r{key_prefix}t']   # rat or rdt
    p_factor = p if key_prefix == 'a' else (1 - p)
    return p_factor * (abs(p_test) + abs(r_test))
```

This is `p_factor * (|p_test| + |r_test|)` — a **weighted SUM of 2 absolute z-scores**.

### 7.3 DISCREPANCY: Repness Metric Formula

| | Clojure | Python |
|---|---------|--------|
| Formula | `ra * rat * pa * pat` | `pa * (|pat| + |rat|)` |
| Combination | Product of 4 | Weighted sum of 2 |
| Uses ratio | Yes (as multiplier) | No (only ratio's z-test) |
| Uses abs | No | Yes |

**Impact**: SEVERE — These produce fundamentally different rankings. The Clojure product heavily penalizes any factor near zero, while Python's sum is more forgiving. Additionally, Python takes absolute values of z-scores, meaning it doesn't distinguish direction.

---

## 8. Finalize Comment Stats (Agree vs Disagree)

### 8.1 Clojure (`repness.clj:finalize-cmt-stats`)

```clojure
;; Simple comparison: which representativeness test is larger?
(if (> rat rdt)
    ;; agree is more representative
    {:repful :agree, :repness ra, :repness-test rat, ...}
    ;; disagree is more representative
    {:repful :disagree, :repness rd, :repness-test rdt, ...})
```

Decision criterion: `rat > rdt` — whichever direction has a larger representativeness z-score wins.

### 8.2 Python (`repness.py:finalize_cmt_stats`, lines 213–243)

```python
if pa > 0.5 and ra > 1.0:
    result['repful'] = 'agree'
elif pd > 0.5 and rd > 1.0:
    result['repful'] = 'disagree'
else:
    if agree_metric >= disagree_metric:
        result['repful'] = 'agree'
    else:
        result['repful'] = 'disagree'
```

Decision criterion: Priority to agree if `pa > 0.5 AND ra > 1.0`, then disagree if `pd > 0.5 AND rd > 1.0`, then fallback to comparing metrics.

### 8.3 DISCREPANCY: Agree/Disagree Selection

Clojure uses a simple `rat > rdt` comparison. Python adds threshold checks (`pa > 0.5`, `ra > 1.0`) that can override the metric-based decision.

**Impact**: Comments near the boundary between agree and disagree may be classified differently.

---

## 9. Significance Thresholds

### 9.1 Clojure (`stats.clj`)

```clojure
(defn z-sig-90? [z-val] (> z-val 1.2816))   ;; one-tailed 90%
(defn z-sig-95? [z-val] (> z-val 1.6449))   ;; one-tailed 95%
```

These are **one-tailed** z-values (P(Z > z) < alpha).

### 9.2 Python — INTERNAL INCONSISTENCY

**`repness.py`** (line 19):
```python
Z_90 = 1.645   # two-tailed 90% (or one-tailed 95%)
Z_95 = 1.96    # two-tailed 95%
```

**`stats.py`** (used elsewhere, not in repness):
```python
z_sig_90 threshold = 1.2816  # matches Clojure
```

### 9.3 DISCREPANCY: Z-score Thresholds

| | Clojure | Python repness.py | Python stats.py |
|---|---------|------------------|-----------------|
| 90% threshold | 1.2816 (one-tailed) | 1.645 (two-tailed) | 1.2816 (one-tailed) |
| 95% threshold | 1.6449 (one-tailed) | 1.96 (two-tailed) | — |

**Impact**: Python's `repness.py` requires MUCH higher z-scores to pass significance tests. Many comments that would be "significant" in Clojure will fail significance in Python, leading to fewer representative comments being selected.

---

## 10. Representative Comment Selection

### 10.1 Clojure (`repness.clj:select-rep-comments`)

Single-pass algorithm:
```
For each (group, comment) pair:
    If repful == :agree:
        If beats-best-by-test? OR (passes-by-test? AND beats-best-agr?):
            Add to best-agrees
    If repful == :disagree:
        Similar logic for best-disagrees
Final: Take top 5 (agrees before disagrees)
```

### 10.2 Python (`repness.py:select_rep_comments`, lines 315–392)

Separate lists:
```python
agree_comments = sorted(best_agree(all_stats), key=agree_metric, reverse=True)
disagree_comments = sorted(best_disagree(all_stats), key=disagree_metric, reverse=True)
selected = top 3 agrees + top 2 disagrees
```

### 10.3 DISCREPANCY: Selection Algorithm

| | Clojure | Python |
|---|---------|--------|
| Agree count | Up to 5 total | 3 agrees + 2 disagrees |
| Algorithm | Single-pass with replacement | Sort-and-take |
| Criteria | beats-best-by-test?, passes-by-test? | pa > pd, significance tests |

---

## 11. Consensus Comments

### 11.1 Clojure (`repness.clj:consensus-stats` + `select-consensus-comments`)

```clojure
;; consensus-stats: For each comment, compute pa with Bayesian smoothing
;; select-consensus-comments:
;;   - format-stat adds test scores
;;   - Takes top 5 agrees (pa > 0.5) and top 5 disagrees (pd > 0.5)
;;   - Filtered by mod-out
```

### 11.2 Python (`repness.py:select_consensus_comments`, lines 413–454)

```python
# Group by comment
# Check if ALL groups have pa > 0.6
# Sort by average agreement
# Take top 2
```

### 11.3 DISCREPANCY: Consensus Selection

| | Clojure | Python |
|---|---------|--------|
| Criterion | Per-comment pa > 0.5 | ALL groups pa > 0.6 |
| Output | Top 5 agree + 5 disagree | Top 2 overall |
| Smoothing | Bayesian (same as repness) | Same |

**Impact**: Python is much more restrictive (requires all groups to agree at 60%+) and returns fewer consensus comments.
