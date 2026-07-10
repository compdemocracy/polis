# Delphi Documentation Directory

Index of the documentation in `delphi/docs/`, organized by topic.

> **Last cleaned: 2026-06-11.** 33 stale leftover docs (completed fix memos, session
> logs, unimplemented design proposals, docs describing deleted architecture) were
> moved to [archive/](archive/) — kept as raw material capturing the original design
> intent of the 2025 build-out, but **not documentation of the current system** (see
> [archive/CLAUDE.md](archive/CLAUDE.md) for the per-file index). Surviving docs were
> spot-checked against the code on that date; still, when a doc and the code disagree,
> trust the code.

## Canonical / living documents

| Document | Description |
|----------|-------------|
| [PLAN_DISCREPANCY_FIXES.md](PLAN_DISCREPANCY_FIXES.md) | **Canonical plan** for the Clojure-parity fix campaign (D-fixes), statuses, ordering |
| [CLJ-PARITY-FIXES-JOURNAL.md](CLJ-PARITY-FIXES-JOURNAL.md) | **Append-only session journal** of the parity work — findings, decisions, test results |
| [deep-analysis-for-julien/](deep-analysis-for-julien/) | Deep Clojure-vs-Python analysis (architecture, PCA, clustering, repness, routing, discrepancy catalog). Historical reference; see status note in `07-discrepancies.md` |

## Getting started & operations

| Document | Description |
|----------|-------------|
| [QUICK_START.md](QUICK_START.md) | Environment setup (uv/.venv) and standard test invocation |
| [RUNNING_THE_SYSTEM.md](RUNNING_THE_SYSTEM.md) | Operating the pipeline: run_delphi, CLI, job submission |
| [DELPHI_DOCKER.md](DELPHI_DOCKER.md) | Delphi container overview |
| [DOCKER_BUILD_OPTIMIZATION.md](DOCKER_BUILD_OPTIMIZATION.md) | Layered Docker builds, requirements.lock workflow |
| [DELPHI_AUTOSCALING_SETUP.md](DELPHI_AUTOSCALING_SETUP.md) | Instance-size based worker configuration (`configure_instance.py`, `INSTANCE_SIZE`) |
| [RESET_SINGLE_CONVERSATION.md](RESET_SINGLE_CONVERSATION.md) | Removing all Delphi data for one conversation |
| [S3_STORAGE.md](S3_STORAGE.md) | S3/MinIO storage for visualizations |
| [OLLAMA_MODEL_CONFIG.md](OLLAMA_MODEL_CONFIG.md) | Ollama model configuration for topic naming |
| [CLI_STATUS_COMMAND.md](CLI_STATUS_COMMAND.md) | `./delphi status <zid>` CLI command |

## Job system

| Document | Description |
|----------|-------------|
| [JOB_STATE_MACHINE_DESIGN.md](JOB_STATE_MACHINE_DESIGN.md) | Job types (FULL_PIPELINE, CREATE_NARRATIVE_BATCH, AWAITING_NARRATIVE_BATCH) and transitions |
| [JOB_QUEUE_SCHEMA.md](JOB_QUEUE_SCHEMA.md) | `Delphi_JobQueue` schema, GSIs, locking patterns |
| [DELPHI_JOB_SYSTEM_TROUBLESHOOTING.md](DELPHI_JOB_SYSTEM_TROUBLESHOOTING.md) | Diagnosing stuck jobs, DynamoDB gotchas, log locations |
| [DATA_FORMAT_STANDARDS.md](DATA_FORMAT_STANDARDS.md) | DynamoDB key formats (`#` delimiters), reserved keywords, type conversions |

## Math & Clojure parity reference

| Document | Description |
|----------|-------------|
| [CLOJURE_COMPARISON.md](CLOJURE_COMPARISON.md) | Clojure-vs-Python comparison test infrastructure and known differences |
| [CLOJURE_TWO_LEVEL_CLUSTERING.md](CLOJURE_TWO_LEVEL_CLUSTERING.md) | Two-level (base→group) clustering architecture, as implemented |
| [SUBGROUP_CLUSTERING_THIRD_LEVEL.md](SUBGROUP_CLUSTERING_THIRD_LEVEL.md) | Clojure's third clustering level (subgroups) — unported, unused by consumers |
| [regression_testing.md](regression_testing.md) | Golden-snapshot regression testing: recorder, comparer, datasets |
| [INVESTIGATION_K_DIVERGENCE.md](INVESTIGATION_K_DIVERGENCE.md) | K-means k divergence investigation (RESOLVED — kept as record) |
| [SESSION_HANDOFF_KMEANS.md](SESSION_HANDOFF_KMEANS.md) | K-means parity session background (partially historical — see status note) |
| [HANDOFF_PR14_VECTORIZED_REFACTOR.md](HANDOFF_PR14_VECTORIZED_REFACTOR.md) | Repness refactor handoff (14a in open stack; 14b/14c open) |
| [HANDOFF_REGRESSION_TEST_PERF.md](HANDOFF_REGRESSION_TEST_PERF.md) | Regression-test performance (mostly resolved — see status note) |

## Topic pipeline (umap_narrative)

| Document | Description |
|----------|-------------|
| [TOPIC_NAMING.md](TOPIC_NAMING.md) | Topic naming: prompt, sampling, storage in `Delphi_CommentClustersLLMTopicNames` |
| [topic-moderation-system.md](topic-moderation-system.md) | Topic moderation endpoints and `Delphi_TopicModerationStatus` |
| [TOPIC_AGENDA_STORAGE_DESIGN.md](TOPIC_AGENDA_STORAGE_DESIGN.md) | Topic agenda storage (`topic_agenda_selections`); Phase 3 never implemented |
| [VERSIONED_TOPIC_KEYS_IMPLEMENTATION.md](VERSIONED_TOPIC_KEYS_IMPLEMENTATION.md) | Versioned topic/section keys (`report_id#section#model`) |

## Open issues & audits (still unresolved — do not delete until fixed)

| Document | Description |
|----------|-------------|
| [ZID_EXPOSURE_AUDIT.md](ZID_EXPOSURE_AUDIT.md) | **Open security issue**: zid/conversation_id exposed in delphi API responses |
| TOPIC_LABEL_MISALIGNMENT_ANALYSIS.md | **Open bug**: label/cluster sorting misalignment in `700_datamapplot_for_layer.py` (local-only file, in `.git/info/exclude` — not present on fresh clones) |
