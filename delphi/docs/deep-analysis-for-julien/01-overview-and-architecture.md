# Polis Math Pipeline: Overview and Architecture

## Document Index

This analysis is split across multiple files for manageability:

1. **01-overview-and-architecture.md** (this file) — High-level architecture, data flow, storage
2. **02-pca-analysis.md** — PCA implementations (Clojure vs Python), mathematical formulas
3. **03-clustering-analysis.md** — K-means clustering, silhouette, k-selection
4. **04-repness-analysis.md** — Representativeness metrics, statistical tests, consensus
5. **05-participant-filtering.md** — In-conv logic, comment priorities, vote structures
6. **06-comment-routing.md** — TypeScript comment routing, topical vs prioritized
7. **07-discrepancies.md** — All Clojure vs Python discrepancies (THE KEY DOCUMENT)
8. **08-dead-code.md** — Dead/unreachable code identified
9. **09-fix-plan.md** — Plan to bring Python to Clojure parity

---

## 1. High-Level Architecture

The Polis math pipeline takes raw participant votes on comments and produces:

- **PCA projections**: 2D coordinates for each participant in opinion space
- **Clusters**: Hierarchical grouping (base clusters → group clusters → optional subgroups)
- **Representativeness**: Which comments best characterize each group
- **Consensus**: Comments that all groups broadly agree on
- **Comment priorities**: Scores used to route the next comment to a participant

### 1.1 Two Implementations

| Aspect | Legacy (Clojure) | Delphi (Python) |
|--------|-----------------|-----------------|
| Location | `math/src/polismath/math/` | `delphi/polismath/` |
| Framework | Plumbing Graph (DAG computation) | Imperative class methods |
| Matrix repr | Custom `NamedMatrix` | pandas `DataFrame` |
| PCA method | Power iteration (custom) | sklearn SVD |
| Status | **CORRECT reference** | Has behavioral gaps |

### 1.2 Computation Flow

**Clojure** (`conversation.clj` lines 136–702):
```
votes → customs (cap ptpts/cmts)
      → raw-rating-mat (NamedMatrix)
      → rating-mat (zero out mod-out columns)
      → mat (replace nil with column means)
      → pca (power iteration)
      → proj (sparsity-aware projection)
      → proj-nmat
      → in-conv (filter participants)
      → base-clusters (k-means, k=100)
      → base-clusters-proj → bucket-dists
      → group-clusterings (k=2..max-k)
      → group-clusterings-silhouettes
      → group-k-smoother (buffer before switching k)
      → group-clusters
      → subgroup-clusterings → subgroup-clusters
      → votes-base → group-votes → subgroup-votes
      → comment-priorities
      → group-aware-consensus
      → repness, subgroup-repness
      → consensus
      → ptpt-stats, subgroup-ptpt-stats
```

**Python** (`conversation.py`, `Conversation` class):
```
update_votes() → raw_rating_mat (DataFrame)
              → _apply_moderation() → rating_mat
              → _compute_vote_stats()
              → recompute():
                  → _compute_pca()
                  → _compute_clusters()
                  → _compute_repness()
                  → _compute_participant_info()
```

### 1.3 Key Architectural Differences

1. **Plumbing Graph vs Imperative**: Clojure uses a declarative computation graph where each node declares its dependencies. Python uses sequential method calls.

2. **Immutability**: Clojure's pipeline is functionally pure — each step produces new data. Python's `Conversation` class mutates `self` attributes.

3. **Missing in Python**: subgroup clustering, comment priorities computation, large-conv mini-batch PCA, k-smoother buffer, proper consensus selection (Clojure's `consensus-stats` + `select-consensus-comments`).

---

## 2. Data Storage

### 2.1 PostgreSQL (Source of Truth)

**Read by both implementations:**

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `votes` | Individual vote records | `zid, pid, tid, vote, created` |
| `comments` | All comments | `zid, tid, txt, mod, active, is_seed` |
| `math_main` | Serialized math results | `zid, data, math_tick, caching_tick` |
| `math_ticks` | Update tracking | `zid, math_env` |
| `worker_tasks` | Task queue | `zid, math_env, task_type` |

**Vote sign convention at the boundary:**
- Postgres stores: `AGREE = -1`, `DISAGREE = 1` (historical Polis convention)
- Delphi internal: `AGREE = 1`, `DISAGREE = -1` (standard convention)
- `postgres.py` line ~: `postgres_vote_to_delphi()` flips signs at the boundary

### 2.2 DynamoDB (Delphi Output)

Delphi writes results to these DynamoDB tables (`dynamodb.py`):

| Table | Content |
|-------|---------|
| `Delphi_PCAConversationConfig` | PCA config (center, components) |
| `Delphi_PCAResults` | Summary results per conversation |
| `Delphi_KMeansClusters` | Cluster assignments and centers |
| `Delphi_CommentRouting` | Comment priority scores for routing |
| `Delphi_RepresentativeComments` | Per-group representative comments |
| `Delphi_PCAParticipantProjections` | Per-participant 2D projections |

### 2.3 Clojure Math Storage

Clojure serializes its entire conversation state (including all computed fields) into the `math_main` table as a single large JSON blob under the `data` column. The TypeScript server reads this blob via `getPca(zid, 0)` to extract `comment-priorities` for routing.

---

## 3. Pipeline Entry Points

### 3.1 Clojure

- **`conv_man.clj`**: Conversation manager, polls for new votes
- **`conversation.clj:conv-update`** (line 766): Dispatches to `small-conv-update` or `large-conv-update` based on:
  - `ptpt-cutoff = 10000` participants
  - `cmt-cutoff = 5000` comments
- `small-conv-update` = `eager-profiled-compiler(small-conv-update-graph)`
- `large-conv-update` = same graph but with mini-batch PCA override

### 3.2 Python (Delphi)

- **`polismath/poller.py`**: DELETED in #2423 (commit 0ff8e3e52). The current entry point is `scripts/job_poller.py`, which polls the DynamoDB `Delphi_JobQueue` and dispatches the math/UMAP/narrative scripts.
- **`run_math_pipeline.py`**: CLI tool for one-shot processing
- **`manager.py`**: Thread-safe management of multiple `Conversation` objects
- **`conversation.py:Conversation.update_votes()`**: Main entry, calls `recompute()`

### 3.3 Default Configuration (Clojure)

From `conversation.clj` lines 142–152:
```clojure
{:n-comps 2
 :pca-iters 100
 :base-iters 100
 :base-k 100
 :max-k 5
 :group-iters 100
 :max-ptpts 100000
 :max-cmts 10000
 :group-k-buffer 4}
```

Python matches `BASE_K=100`, `MAX_K=5`, but is missing `group-k-buffer` entirely.
