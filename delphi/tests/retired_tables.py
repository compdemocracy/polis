"""The nine DynamoDB tables retired from Delphi, named once.

This is the only list of these names in executable code. Two tests assert
against it: `test_dynamodb_bootstrap_allowlist.py` proves nothing recreates
them, and `test_math_pipeline_runs_e2e.py` proves a real math run neither needs
nor creates them.

Background: `delphi/docs/RETIRED_DYNAMODB_TABLES.md`.
"""

# Written by the Python PCA stage's DynamoDB export (`DynamoDBClient`), which
# also created these six itself on every run.
RETIRED_PCA_TABLES = (
    "Delphi_PCAConversationConfig",
    "Delphi_PCAResults",
    "Delphi_KMeansClusters",
    "Delphi_CommentRouting",
    "Delphi_RepresentativeComments",
    "Delphi_PCAParticipantProjections",
)

# Written elsewhere in the pipeline, or never written at all.
RETIRED_OTHER_TABLES = (
    "Delphi_CommentExtremity",          # stage 501, read only by stage 502
    "Delphi_TopicAgendaSelections",     # never written; selections live in PostgreSQL
    "Delphi_CommentClustersFeatures",   # cluster characteristics; reader had no callers
)

RETIRED_TABLES = RETIRED_PCA_TABLES + RETIRED_OTHER_TABLES

# The tables `create_dynamodb_tables.py` must still create, and nothing more.
EXPECTED_BOOTSTRAP_TABLES = frozenset({
    "Delphi_JobQueue",
    "Delphi_NarrativeReports",
    "Delphi_UMAPConversationConfig",
    "Delphi_CommentEmbeddings",
    "Delphi_CommentHierarchicalClusterAssignments",
    "Delphi_CommentClustersStructureKeywords",
    "Delphi_UMAPGraph",
    "Delphi_CommentClustersLLMTopicNames",
    "Delphi_CollectiveStatement",
})

# Throttled at provisioned 5/5 in production, so they must stay on-demand.
ON_DEMAND_REQUIRED_TABLES = (
    "Delphi_UMAPGraph",
    "Delphi_CommentHierarchicalClusterAssignments",
)
