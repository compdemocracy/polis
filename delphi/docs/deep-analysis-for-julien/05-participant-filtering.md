# Participant Filtering, Comment Priorities, and Vote Structures

## 1. Participant Filtering (in-conv)

The "in-conv" filter determines which participants have voted enough to be included in clustering. This is critical because participants with too few votes produce unreliable PCA projections.

### 1.1 Clojure (`conversation.clj` lines 240–266)

```clojure
:in-conv (plmb/fnk [conv user-vote-counts n-cmts]
  (as-> (or (:in-conv conv) #{}) in-conv
    ;; Step 1: Include anyone with >= min(7, n-cmts) votes
    (into in-conv
      (map first
        (filter
          (fn [[rowname cnt]]
            (>= cnt (min 7 n-cmts)))
          user-vote-counts)))
    ;; Step 2: If fewer than 15 participants, greedily add top voters
    (let [greedy-n 15
          n-in-conv (count in-conv)]
      (if (< n-in-conv greedy-n)
        (->> user-vote-counts
          (remove (fn [[k v]] (in-conv k)))
          (sort-by (comp - second))
          (map first)
          (take (- greedy-n n-in-conv))
          (into in-conv))
        in-conv))))
```

**Algorithm**:
1. Start with previous in-conv set (once in, always in)
2. Add any participant with `vote_count >= min(7, n_comments)`
3. If result has fewer than 15 participants, greedily add the highest-voting participants until reaching 15

**Key property**: Monotonic — once a participant is in-conv, they stay in-conv forever (across updates).

### 1.2 Python (`conversation.py` lines 1225–1248)

```python
def _get_in_conv_participants(self) -> Set[str]:
    n_cmts = len(self.rating_mat.columns)
    threshold = 7 + np.sqrt(n_cmts) * 0.1
    vote_counts = self._compute_user_vote_counts()
    in_conv = {pid for pid, count in vote_counts.items() if count >= threshold}
    return in_conv
```

**Algorithm**:
1. Threshold = `7 + sqrt(n_comments) * 0.1`
2. Include any participant with `vote_count >= threshold`
3. No greedy fallback
4. No persistence (recomputed from scratch each time)

### 1.3 DISCREPANCY: In-Conv Filtering

| Property | Clojure | Python |
|----------|---------|--------|
| Threshold | `min(7, n_cmts)` | `7 + sqrt(n_cmts) * 0.1` |
| Greedy fallback | Yes (top-15 voters) | No |
| Persistence | Monotonic (once in, always in) | Recomputed each time |
| At 100 comments | 7 votes needed | 8 votes needed |
| At 1000 comments | 7 votes needed | 10.2 votes needed |

**Impact**: HIGH
- Python's threshold is HIGHER and GROWS with comment count, excluding more participants
- Python lacks the greedy fallback, so small conversations may have too few participants for clustering
- Python recalculates from scratch, so participants can drop OUT of in-conv if new comments are added (increasing the threshold)

### 1.4 Note on to_dict() In-Conv

Interestingly, `conversation.py:to_dict()` (lines 1637–1644) has a DIFFERENT in-conv calculation for the serialized output:

```python
min_votes = min(7, self.comment_count)
for pid, count in result['user-vote-counts'].items():
    if count >= min_votes:
        in_conv.append(pid)
```

This matches Clojure's threshold formula but is only used for serialization output, NOT for the actual clustering computation. The clustering uses `_get_in_conv_participants()` with the different formula.

---

## 2. User Vote Counts

### 2.1 Clojure (`conversation.clj` lines 217–225)

```clojure
:user-vote-counts
  (->> (mapv
         (fn [rowname row]
           [rowname (count (remove nil? row))])
         (nm/rownames raw-rating-mat)
         (nm/get-matrix raw-rating-mat))
       (into {}))
```

Counts non-nil entries per row of the **raw** rating matrix (before moderation).

### 2.2 Python (`conversation.py:_compute_user_vote_counts`, lines 1179–1223)

```python
# Uses self.rating_mat (AFTER moderation, not raw)
non_nan_mask = ~np.isnan(self.rating_mat.values)
row_sums = np.sum(non_nan_mask, axis=1)
```

### 2.3 DISCREPANCY: Raw vs Moderated Matrix

Clojure counts votes on the **raw** matrix; Python counts on the **moderated** matrix. If comments are moderated out, Python undercounts participant votes.

**Impact**: A participant who voted on 8 comments (including 2 moderated-out) would have count=8 in Clojure but count=6 in Python, potentially dropping below the in-conv threshold.

---

## 3. Customs (Participant/Comment Caps)

### 3.1 Clojure (`conversation.clj` lines 164–186)

```clojure
:customs (plmb/fnk [conv votes opts']
  (reduce
    (fn [{:keys [pids tids] :as result} {:keys [pid tid] :as vote}]
      (let [pid-room (< (count pids) (:max-ptpts opts'))  ;; 100000
            tid-room (< (count tids) (:max-cmts opts'))   ;; 10000
            pid-in (pids pid)
            tid-in (tids tid)]
        (if (and (or pid-room pid-in)
                 (or tid-room tid-in))
          ;; Accept vote
          ...
          ;; Reject vote
          result)))
    ...))
```

This enforces hard caps: max 100,000 participants, max 10,000 comments. A vote is accepted only if:
- The participant is already known OR there's room for new participants
- AND the comment is already known OR there's room for new comments

### 3.2 Python

**No customs/cap mechanism exists.** All votes are accepted regardless of conversation size.

**Status: MISSING in Python** — Could be a problem for very large conversations, but less critical than other discrepancies.

---

## 4. Comment Priorities

### 4.1 Clojure (`conversation.clj` lines 308–669)

Comment priorities determine which comments are shown next to participants. The pipeline computes:

**Step 1: Votes Base** (`votes-base`, lines 583–590)
```
For each comment tid:
    For each base cluster:
        A[bid] = count of agree votes from cluster members
        D[bid] = count of disagree votes from cluster members
        S[bid] = count of total votes from cluster members
```

**Step 2: Group Votes** (`group-votes`, lines 278–305)
```
For each group:
    For each comment:
        A = sum of A[bid] for base clusters in this group
        D = sum of D[bid] ...
        S = sum of S[bid] ...
```

**Step 3: Importance Metric** (lines 308–312)
```
importance_metric(A, P, S, E) = (1 - p) * (E + 1) * a
where:
    p = (P + 1) / (S + 2)    ;; pass probability (Bayesian)
    a = (A + 1) / (S + 2)    ;; agree probability (Bayesian)
    P = S - A - D             ;; pass count
    E = comment extremity     ;; L2 norm of comment's PCA projection
```

**Step 4: Priority Metric** (lines 318–327)
```
priority_metric(is_meta, A, P, S, E) =
    if is_meta:
        meta_priority^2 = 7^2 = 49
    else:
        (importance_metric(A, P, S, E) * (1 + 8 * 2^(S/-5)))^2
```

The `(1 + 8 * 2^(S/-5))` factor is a **novelty boost** that gives high priority to comments with few total votes (S). As S increases:
- S=0: factor = 1 + 8*1 = 9
- S=5: factor = 1 + 8*0.5 = 5
- S=10: factor = 1 + 8*0.25 = 3
- S=20: factor = 1 + 8*0.0625 = 1.5
- S=∞: factor → 1

The squaring amplifies differences between priorities.

**Step 5: Comment Priorities** (lines 638–669)
```
For each tid:
    Sum A, D, S, P across all groups
    Get extremity from PCA
    priority = priority_metric(is_meta, total_A, total_P, total_S, extremity)
```

### 4.2 Python

**Comment priorities are NOT computed in the main pipeline.** The `_compute_votes_base()` method exists (lines 1047–1093) but:

1. It has a **BUG** on line 1076: `self.rating_mat[:, 'tid']` is invalid pandas syntax (should be `self.rating_mat[tid]`)
2. It is marked with `TODO(julien): why is that not called anywhere?`
3. The `recompute()` method does NOT call it
4. No `importance_metric` or `priority_metric` functions exist in Python
5. Comment extremity is not computed (no comment projection)

**Status: MISSING in Python** — Comment priorities are critical for the TypeScript server's comment routing. Without them, all comments get equal weight (default priority = 1).

---

## 5. Group-Aware Consensus

### 5.1 Clojure (`conversation.clj` lines 614–636)

```clojure
:group-aware-consensus
  ;; For each (group, comment):
  ;;   prob = (A + 1.0) / (S + 2.0)     ;; Laplace-smoothed agree probability
  ;; For each comment:
  ;;   consensus = product of all group probabilities
  ;; Result: {tid → consensus_value}
```

Mathematical formula for comment `j`:
```
consensus(j) = Π_{g ∈ groups} [ (A_g(j) + 1) / (S_g(j) + 2) ]
```

This is a product of Bayesian-smoothed agreement probabilities across all groups. High consensus means ALL groups agree.

### 5.2 Python (`conversation.py:_compute_group_aware_consensus`, lines 1291–1349)

```python
# Same formula: consensus_value *= (agree_count + 1.0) / (total_count + 2.0)
```

**Status: MATCH** — Both compute the same product of Laplace-smoothed probabilities.

Also implemented inline in `to_dict()` (lines 1596–1631) with identical logic.

---

## 6. Votes-Base Structure

### 6.1 Clojure

```clojure
;; {tid {:A [a0 a1 a2 ...], :D [...], :S [...]}}
;; where indices correspond to base cluster IDs (sorted)
;; a0 = number of agree votes from base cluster 0 for this comment
```

This per-base-cluster granularity enables efficient group-level aggregation.

### 6.2 Python (`to_dict()`, lines 1497–1521)

```python
# {tid: {'A': total_agree, 'D': total_disagree, 'S': total_votes}}
# NOT per-base-cluster — just global totals
```

### 6.3 DISCREPANCY: Granularity

Clojure's votes-base has per-base-cluster arrays; Python's has only global totals. This means Python cannot efficiently recompute group-level vote statistics when group assignments change. Python works around this by recomputing from the raw vote matrix each time.
