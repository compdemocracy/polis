# Retired DynamoDB tables

Nine DynamoDB tables were removed from Delphi. They had **no live product consumers**:
no API route, report, client surface, moderation path or downstream pipeline stage read
any of them, and fourteen days of production CloudWatch recorded zero reads and zero
writes on all nine. That is a statement about the running product, not merely about
this repository — the audit covered the server, every client, the Delphi pipeline and
the live traffic, and found the tables to be pure write-only output. Removing them
changes nothing a user or an operator can see. This page is the destination for
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
environments, and that script creates any table that is missing.

Whether that actually recreates a deleted table depends on the permissions of the role
the container is running as. It recreates only where the running role holds
`dynamodb:CreateTable`. Locally and in CI it does, so a deleted table comes straight
back. The production instance role does not hold `dynamodb:CreateTable`, so there the
call fails and is swallowed by the per-table `except` — the table stays deleted, but
every start logs a create error against a table nobody wants, and the protection is an
IAM boundary rather than anything the code guarantees. A future role or environment with
that permission would silently repopulate the list.

A recreated table is also not a restored one: it comes back empty and with a different
shape than the original (the live `Delphi_CommentRouting`, for instance, had no GSI while
the script declared a `zid-index`). That looks like a successful rollback and is not.

For both reasons the bootstrap entries had to go, and ship, before anything was deleted
in AWS — the code should not be asking for tables that are meant to be gone, whatever
IAM happens to allow on the day.

`delphi/tests/test_dynamodb_bootstrap_allowlist.py` is the regression guard for that: it
runs the real table constructors against a recording fake and fails if any of the nine
comes back.

## Tables deliberately kept

`Delphi_UMAPGraph` and `Delphi_CommentHierarchicalClusterAssignments` are live and are
deliberately declared `PAY_PER_REQUEST`: both throttled heavily at provisioned 5/5.
Do not pin them back to provisioned capacity. The bootstrap allowlist test asserts their
billing mode.
