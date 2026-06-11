# ALL Discrepancies: Clojure (CORRECT) vs Python (Delphi)

> **Status as of 2026-06-11**: D2, D4, D5, D6, D7, D8, D9 are merged on `edge`; D10, D11, D12 are in the open spr stack (PRs #2566–#2568). D3 (k-smoother) and D1/D1b (PCA sign flip / projection source) remain open. See `PLAN_DISCREPANCY_FIXES.md` (canonical) — the analysis below is kept as historical reference and per-discrepancy detail.

This is the critical reference document. Every discrepancy is rated by severity and lists the exact code locations.

---

## SEVERITY LEGEND

- **CRITICAL**: Fundamentally changes mathematical behavior, produces different results
- **HIGH**: Significant behavioral difference visible to users
- **MEDIUM**: Subtle numerical differences, may affect edge cases
- **LOW**: Cosmetic or minor structural difference

---

## D1. PCA Algorithm [MEDIUM]

| | Clojure | Python |
|---|---------|--------|
| File | `math/src/polismath/math/pca.clj` | `delphi/polismath/pca_kmeans_rep/pca.py` |
| Method | Power iteration (100 iters) | sklearn SVD |
| Warm-start | Yes (previous components) | No |
| Large conv | Mini-batch with learning rate 0.01 | Full SVD (no optimization) |

**Why MEDIUM**: Both methods converge to the same eigenspace for well-separated eigenvalues. The main risk is temporal instability in Python (PCA can flip/rotate between updates).

**Fix**: Could switch to incremental PCA (sklearn `IncrementalPCA`) for warm-starting, or accept SVD as equivalent and address stability separately.

### D1b. Projection Input [LOW]

| | Clojure | Python |
|---|---------|--------|
| File | `pca.clj:134–157` | `pca.py:76,96–102` |
| Input | Raw votes (nils skipped) | Imputed matrix (NaN → col mean) |

Clojure projects against raw sparse votes, skipping unvoted entries. Python projects the fully imputed matrix. Since `center ≈ col_mean`, the difference is small but nonzero. See doc 02, Section 3.4 for details.

---

## D2. In-Conv Participant Threshold [CRITICAL]

| | Clojure | Python |
|---|---------|--------|
| File | `conversation.clj:240–266` | `conversation.py:1225–1248` |
| Threshold | `min(7, n_cmts)` | `7 + sqrt(n_cmts) * 0.1` |
| Greedy fallback | Top-15 voters if < 15 qualify | None |
| Persistence | Monotonic (once in, always in) | Recomputed from scratch |
| Matrix used | raw_rating_mat | rating_mat (moderated) |

**Example at 100 comments**:
- Clojure: need 7 votes → most participants qualify
- Python: need 8 votes → slightly fewer qualify

**Example at 1000 comments**:
- Clojure: need 7 votes → most participants qualify
- Python: need 10.2 votes → significantly fewer qualify

**Why CRITICAL**: This is the gatekeeper for clustering. Wrong threshold means different participants are clustered, cascading to different groups, different repness, different everything.

**Fix**: Change Python to `min(7, n_cmts)`, add greedy fallback, add persistence, use `raw_rating_mat`.

---

## D3. K-Smoother Buffer [HIGH]

| | Clojure | Python |
|---|---------|--------|
| File | `conversation.clj:452–468` | `conversation.py:620–641` |
| Buffer | 4 consecutive updates before switching k | None (immediate switch) |
| State | Persisted across updates | None |

**Why HIGH**: Without the buffer, the number of groups can flicker between values on successive updates, causing visible instability in the UI.

**Fix**: Add `group_k_smoother` state to `Conversation` class with `{last_k, last_k_count, smoothed_k}`.

---

## D4. Pseudocount Formula [MEDIUM]

| | Clojure | Python |
|---|---------|--------|
| File | `repness.clj` | `repness.py:35,138–139` |
| Numerator add | +1 | +0.75 (`PSEUDO_COUNT/2`) |
| Denominator add | +2 | +1.5 (`PSEUDO_COUNT`) |
| Prior | Beta(2,2) | Beta(1.75,1.75) |

**Why MEDIUM**: Small numerical differences that diminish with sample size but matter for small groups.

**Fix**: Change `PSEUDO_COUNT = 2.0` in Python (giving +1/+2 to match Clojure).

---

## D5. Proportion Test Formula [CRITICAL]

| | Clojure | Python |
|---|---------|--------|
| File | `stats.clj:prop-test` | `repness.py:prop_test` lines 64–86 |
| Clojure | `2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)` | — |
| Python | — | `(p - 0.5) / sqrt(0.25/n)` (standard z-test) |

**Why CRITICAL**: These are fundamentally different formulas. Clojure's built-in pseudocount in the test produces different z-scores, especially for small samples. Since these z-scores are used in significance tests that gate which comments become representative, different formulas → different representative comments.

**Fix**: Implement Clojure's exact formula in Python.

---

## D6. Two-Proportion Test [MEDIUM]

| | Clojure | Python |
|---|---------|--------|
| File | `stats.clj:two-prop-test` | `repness.py:two_prop_test` lines 89–115 |
| Pseudocount | +1 to all 4 inputs | None (uses pre-smoothed proportions) |

**Why MEDIUM**: The +1 adjustment provides regularization that prevents extreme z-scores when sample sizes are very small. Python's version can produce larger z-scores.

**Fix**: Add +1 adjustment to match Clojure, or apply pseudocount before calling.

---

## D7. Repness Metric Formula [CRITICAL]

| | Clojure | Python |
|---|---------|--------|
| File | `repness.clj:repness-metric` | `repness.py:repness_metric` lines 189–210 |
| Formula | `ra * rat * pa * pat` (product of 4) | `pa * (|pat| + |rat|)` (weighted sum of 2) |
| Uses ratio directly | Yes (`ra`) | No (only `rat`) |
| Abs values | No | Yes |

**Why CRITICAL**: Completely different mathematical formulas for ranking representative comments. The product form zeros out when any factor is near zero; the sum form is more tolerant. They will produce different rankings for the same data.

**Fix**: Replace Python formula with `ra * rat * pa * pat` to match Clojure.

---

## D8. Finalize Comment Stats [MEDIUM]

| | Clojure | Python |
|---|---------|--------|
| File | `repness.clj:finalize-cmt-stats` | `repness.py:finalize_cmt_stats` lines 213–243 |
| Decision | `rat > rdt` (simple comparison) | `pa > 0.5 AND ra > 1.0` (threshold check first) |

**Why MEDIUM**: Different logic for choosing agree vs disagree classification. The threshold checks in Python can override what would be the metric-based choice.

**Fix**: Replace Python logic with simple `rat > rdt` comparison.

---

## D9. Z-Score Significance Thresholds [CRITICAL]

| | Clojure | Python repness.py |
|---|---------|------------------|
| File | `stats.clj` | `repness.py:19` |
| 90% threshold | 1.2816 (one-tailed) | 1.645 (two-tailed) |
| 95% threshold | 1.6449 (one-tailed) | 1.96 (two-tailed) |

**Why CRITICAL**: Python requires 28% higher z-scores to pass significance at 90% confidence. Many comments that would be selected as representative in Clojure will fail to pass significance in Python.

**Additional issue**: Python's own `stats.py` uses 1.2816 (matching Clojure), creating an **internal inconsistency** within the Python codebase.

**Fix**: Change `Z_90 = 1.2816` and `Z_95 = 1.6449` in `repness.py`.

---

## D10. Representative Comment Selection [HIGH]

| | Clojure | Python |
|---|---------|--------|
| File | `repness.clj:select-rep-comments` | `repness.py:select_rep_comments` lines 315–392 |
| Algorithm | Single-pass with beats-best | Sort-and-take-top |
| Max agree | 5 total (agrees first) | 3 agrees |
| Max disagree | (from the 5) | 2 disagrees |
| Total | Up to 5 | Up to 5 |

**Why HIGH**: Different selection counts and algorithm produce different representative comment sets.

**Fix**: Match Clojure's selection logic (5 total, agrees first, single-pass).

---

## D11. Consensus Comment Selection [HIGH]

| | Clojure | Python |
|---|---------|--------|
| File | `repness.clj:consensus-stats` + `select-consensus-comments` | `repness.py:select_consensus_comments` lines 413–454 |
| Criterion | Per-comment `pa > 0.5` | ALL groups `pa > 0.6` |
| Output | Top 5 agree + 5 disagree with test scores | Top 2 overall |
| Test scores | Yes (format-stat adds z-tests) | No |

**Why HIGH**: Python is much more restrictive and returns far fewer consensus comments.

**Fix**: Match Clojure's consensus-stats + select-consensus-comments logic.

---

## D12. Comment Priorities [CRITICAL]

| | Clojure | Python |
|---|---------|--------|
| File | `conversation.clj:308–669` | `conversation.py:1047–1093` (dead code) |
| Status | Fully computed and stored | NOT COMPUTED (dead code with bug) |
| Components | importance × novelty, squared | N/A |
| Comment extremity | Yes (from PCA) | Not computed |
| Meta priority | 7 (squared = 49) | N/A |

**Why CRITICAL**: Without comment priorities, the TypeScript server falls back to uniform random comment selection. This eliminates the information-theoretic comment routing that is core to Polis's design.

**Fix**: Implement `importance_metric`, `priority_metric`, and the full `comment-priorities` computation. Requires first implementing comment projection and extremity in PCA.

---

## D13. Subgroup Clustering [LOW]

| | Clojure | Python |
|---|---------|--------|
| File | `conversation.clj:480–570` | N/A |
| Status | Full implementation with k-smoother | Not implemented |

**Why LOW**: Subgroups are a secondary feature. The primary group clustering is more important.

**Fix**: Implement if needed, but lower priority.

---

## D14. Large Conversation Optimization [LOW]

| | Clojure | Python |
|---|---------|--------|
| Dispatch | `ptpt-cutoff=10000`, `cmt-cutoff=5000` | No dispatch |
| Large PCA | Mini-batch with learning rate | Full SVD |
| Sample size | `interpolate(n, 100..1500, 1500..150000)` | N/A |

**Why LOW**: Only matters for very large conversations. Can be addressed later.

**Fix**: Use `IncrementalPCA` from sklearn for large conversations.

---

## D15. Moderation Handling [MEDIUM]

| | Clojure | Python |
|---|---------|--------|
| Method | `zero-out-columns` (set values to 0, keep structure) | `loc[keep_ptpts, keep_comments]` (remove entirely) |

**Why MEDIUM**: Clojure keeps moderated comments in the matrix with zeroed values; Python removes them entirely. This affects matrix dimensions and potentially vote count calculations.

**Fix**: Consider switching to zero-out approach, but current approach may be acceptable since Python works with DataFrames.

---

## Summary Table

| ID | Discrepancy | Severity | Fix Effort |
|----|-------------|----------|------------|
| D1 | PCA algorithm | MEDIUM | Low (accept or use IncrementalPCA) |
| D2 | In-conv threshold | CRITICAL | Low (change formula) |
| D3 | K-smoother buffer | HIGH | Medium (add state) |
| D4 | Pseudocount formula | MEDIUM | Low (change constant) |
| D5 | Proportion test | CRITICAL | Low (change formula) |
| D6 | Two-proportion test | MEDIUM | Low (add +1 adjustment) |
| D7 | Repness metric | CRITICAL | Low (change formula) |
| D8 | Finalize cmt stats | MEDIUM | Low (simplify logic) |
| D9 | Z-score thresholds | CRITICAL | Low (change constants) |
| D10 | Rep comment selection | HIGH | Medium (change algorithm) |
| D11 | Consensus selection | HIGH | Medium (match Clojure) |
| D12 | Comment priorities | CRITICAL | High (full implementation) |
| D13 | Subgroup clustering | LOW | High (full implementation) |
| D14 | Large conv optimization | LOW | Medium |
| D15 | Moderation handling | MEDIUM | Low |
