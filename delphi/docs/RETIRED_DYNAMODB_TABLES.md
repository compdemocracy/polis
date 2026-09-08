# Retired DynamoDB tables

Nine DynamoDB tables were removed from Delphi. They took zero reads and zero writes
over fourteen days of production CloudWatch, and no server, client or pipeline code
read any of them — they were pure write-only output. This page is the destination for
the "superseded in part" banners on the older design and archive documents, so a reader
who finds one of these names in a historical inventory can tell what happened to it.

The canonical list, and the only place it appears in executable code, is
`delphi/tests/retired_tables.py`. `delphi/tests/test_dynamodb_bootstrap_allowlist.py`
and `delphi/tests/test_math_pipeline_runs_e2e.py` both assert against it.

| Table | What wrote it | Why it went |
|---|---|---|
| `Delphi_PCAConversationConfig` | Python PCA stage, `DynamoDBClient.write_conversation` | No reader anywhere. Everything that renders PCA/repness/projections reads the PostgreSQL `math_main` blob via `/api/v3/math/pca2`. |
| `Delphi_PCAResults` | same | same |
| `Delphi_KMeansClusters` | same | same |
| `Delphi_CommentRouting` | same, plus stage 502 wrote `priority` back into it | Comment routing reads `math_main`, never this table. |
| `Delphi_RepresentativeComments` | same | same |
| `Delphi_PCAParticipantProjections` | same | same |
| `Delphi_CommentExtremity` | stage 501 via `GroupDataProcessor.store_comment_extremity` | Only stage 502 read it, through a GSI that did not exist in the live region, so the read silently returned nothing. The narrative report re-derives extremity from `math_main`. |
| `Delphi_TopicAgendaSelections` | nothing — it only ever had a table constructor | Topic-agenda selections live in the PostgreSQL `topic_agenda_selections` table. |
| `Delphi_CommentClustersFeatures` | `DynamoDBStorage.batch_create_cluster_characteristics` | Its only reader had no callers. Cluster characteristics are still computed and still drive topic naming and hover text; they are simply no longer persisted. |

## What went with them

- `delphi/polismath/database/dynamodb.py` — the whole `DynamoDBClient`, including the
  `_ensure_tables_exist` that created six of these tables on every run.
- `Conversation.export_to_dynamodb`, and the export block at the end of
  `polismath/run_math_pipeline.py`. **The PCA/k-means/repness computation stayed.**
- Pipeline stages `501_calculate_comment_extremity.py` and `502_calculate_priorities.py`,
  their dispatch in `run_delphi.py`, and their `calculate-extremity` /
  `calculate-priorities` package entry points.
- The DynamoDB half of `GroupDataProcessor` (its PostgreSQL reads and the extremity
  computation stayed).
- The cluster-characteristics write path in `run_pipeline.py` and
  `500_generate_embedding_umap_cluster.py`, its three `DynamoDBStorage` methods, the two
  `DataConverter` helpers and the `ClusterCharacteristic` model.

## Why the code had to change before the tables were deleted

`delphi/Dockerfile` runs `create_dynamodb_tables.py` on every container start, in all
environments, and that script creates any table that is missing. Deleting a table while
it is still listed there means the next delphi start recreates it — empty, and with a
different shape than the original. That looks like a successful rollback and is not.
So the bootstrap entry had to go, and ship, before anything was deleted in AWS.

`delphi/tests/test_dynamodb_bootstrap_allowlist.py` is the regression guard for that: it
runs the real table constructors against a recording fake and fails if any of the nine
comes back.

## Tables deliberately kept

`Delphi_UMAPGraph` and `Delphi_CommentHierarchicalClusterAssignments` are live and are
deliberately declared `PAY_PER_REQUEST`: both throttled heavily at provisioned 5/5.
Do not pin them back to provisioned capacity. The bootstrap allowlist test asserts their
billing mode.
