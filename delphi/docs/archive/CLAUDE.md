# Archived Delphi documentation — read this first

Nothing in this folder describes the current system. These documents are
**historical raw material** from the initial build-out of Delphi (2025,
largely written with LLM assistance in the Claude Sonnet 3.5/3.7 era). They
were moved here on 2026-06-11 (PR #2573) after an audit verified that each
one no longer matches the code.

**If you are an AI agent working on this codebase: do not use these files as
documentation.** Do not follow their instructions; do not trust their table
names, script names, formulas, file paths, or architecture descriptions.
Current documentation lives one level up in `delphi/docs/` (start with
`DOCUMENTATION_DIRECTORY.md`); the canonical references are the code itself,
`docs/PLAN_DISCREPANCY_FIXES.md`, and `docs/CLJ-PARITY-FIXES-JOURNAL.md`.

**Why these files are kept:** they capture the *original research and design
intent* behind the system — goals, abandoned directions, and the reasoning of
the first build — which is an independent deliverable in its own right.
Extracting intent, requirements, or design history from them is the
legitimate use of this folder.

## Index — what each file was, and why it was archived

| File | What it was | Why archived |
|------|-------------|--------------|
| `702_CONSENSUS_DIVISIVE_README.md` | Usage notes for the standalone 702 consensus/divisive visualization script | The 702 step is disabled in the pipeline (its invocation is commented out) |
| `algorithm_analysis.md` | Pre-port analysis of the Clojure algorithms and Python porting choices | Describes custom power-iteration PCA and hand-rolled k-means since replaced by sklearn (#2416) |
| `ANTHROPIC_BATCH_API_GUIDE.md` | Guide to the narrative batch-API flow | Documents the dead `802_process_batch_results.py` / `Delphi_BatchJobs` path; the live flow is 801/803 |
| `architecture_overview.md` | Overview of the *Clojure* math service internals | Superseded by `deep-analysis-for-julien/01-overview-and-architecture.md` |
| `BATCH_API_BUGFIX.md` | Session memo for a job_poller batch-routing bug | Fix applied long ago |
| `BATCH_NARRATIVE_README.md` | README for the 801/802/803 batch workflow | 802 is dead code; references a DynamoDB table that is never created |
| `conversion_plan.md` | Original Clojure→Python conversion plan with status ticks | Statuses are wrong: the poller/server it marks "Completed" were deleted (#2423); PCA is now sklearn |
| `DATABASE_NAMING_PROPOSAL.md` | Migration plan to the `Delphi_` table-name prefix | Migration completed; `create_dynamodb_tables.py` is the canonical reference |
| `DEAD_CODE_CLEANUP_REPORT.md` | Session report of the Jan-2026 dead-code cleanup | Work merged (#2423); the "archived to docs/archive/" it claims never happened at the time |
| `DISTRIBUTED_SYSTEM_ROADMAP.md` | Multi-phase distributed-system roadmap | Unimplemented aspirations; references scripts that don't exist |
| `DOCKER.md` | Eight-line Docker stub | Hardcoded to a developer's machine; superseded by `DELPHI_DOCKER.md` |
| `EVOC_LAYER_HIERARCHY_DEBUG.md` | Debug log of the EVoC layer-hierarchy direction issue | Root cause identified; session closed |
| `GLOBAL_SECTION_TEMPLATE_MAPPING_FIX.md` | Fix memo for narrative global-section template mapping | Fix applied in `801_narrative_report_batch.py` |
| `JOB_ID_MIGRATION_PLAN.md` | Plan to re-key DynamoDB tables on `job_id` | Never implemented; tables remain keyed by zid/conversation_id |
| `JOB_SYSTEM_DESIGN.md` | DAG-based job-stage dependency design | Superseded by the simpler FULL_PIPELINE / narrative-batch job types that shipped |
| `NARRATIVE_DROPDOWN_DESIGN_ANALYSIS.md` | Options analysis for unifying two report dropdown components | Decision deferred and abandoned; only the immediate sorting fix shipped |
| `NARRATIVE_INVERSION_INVESTIGATION.md` | Investigation of the agree/disagree sign inversion in narratives | Fix applied (`postgres_vote_to_delphi`, #2330) |
| `NEXT_STEPS.md` | Next-steps list from the early port | Every item refers to the pre-#2423/#2416/#2282 architecture |
| `project_structure.md` | Proposed package layout | The layout described was never what got built |
| `SIMPLIFIED_TESTS.md` | Guide to the root-level simplified test scripts | Those scripts were deleted (#2126) |
| `SMART_COMMENT_FILTERING_PLAN.md` | Multi-week comment-filtering implementation plan | Never executed; superseded by the simpler 501 extremity step |
| `SPATIAL_TOPIC_PRIORITIZATION_SYSTEM.md` | Spatial topic-prioritization (STPS) design | The endpoints and DynamoDB tables it specifies were never built |
| `summary.md` | Early system summary | Describes a FastAPI server / background-poller architecture that no longer exists |
| `TEST_RESULTS_SUMMARY.md` | Point-in-time test-pass snapshot (2025-06) | Counts and referenced files long stale |
| `TESTING_LOG.md` | Early testing session log | Predates the Clojure-parity campaign entirely |
| `TOPIC_AGENDA_IMPLEMENTATION_SUMMARY.md` | Pre-implementation topic-agenda design memo | Feature shipped (migration 000012, `topicAgenda.ts`, `TopicAgenda.tsx`) |
| `TOPIC_AGENDA_MIGRATION_PLAN.md` | 16-week GraphQL/WASM/CDN topic-agenda migration plan | None of it was adopted; the shipped system is REST + Postgres JSONB + Astro |
| `TOPIC_GROUP_CONSENSUS_METRIC.md` | IGAS topic-consensus metric design (cosine variant) | Never adopted; production uses the group-aware consensus product |
| `TOPIC_GROUP_CONSENSUS_METRIC_REVISED.md` | Revised IGAS design (JSD, bootstrap CIs, calibration) | Never adopted |
| `TOPIC_GROUP_CONSENSUS_o3_stub.MD` | Raw o3-model output behind the REVISED doc | Raw LLM stub; the ~700-line TypeScript it contains was never committed |
| `UMAP_VISUALIZATION_PLAN.md` | Plan for a D3 UMAP scatter card in the topic hierarchy UI | The visualization was never built |
| `usage_examples.md` | API usage examples for `ConversationManager` + a FastAPI wrapper | Several referenced methods don't exist; not a production code path |
| `vulture_analysis_output.txt` | Raw vulture dead-code scan output (March 2026) | Acted on by #2423 and the repness dead-path removal; line numbers stale |
