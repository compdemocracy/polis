# Collective statements written by an outside agent

The conversation owner exports a topic's inputs, any agent (any model, any
prompt, run anywhere) writes the candidate collective statement, and the owner
imports it. The server stores it with its provenance and serves it on the topic
page. No model is called by these routes or commands.

```sh
polis collective export CONVERSATION --report REPORT --topic 'JOB#0#1' --output new-inputs
polis collective import CONVERSATION statement.json --report REPORT --json
polis collective list --report REPORT --json
```

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/v3/delphi/collective/inputs?conversation_id=&report_id=&section=` | the conversation owner | one topic's consensus evidence, the allowed citations, an input digest and the result schema |
| `POST /api/v3/delphi/collective/results` (JSON) | the conversation owner | a statement for one export, validated and stored with its provenance |
| `GET /api/v3/delphi/collective/results?report_id=[&section=]` | anyone with the report link | every stored statement for the report, or for one topic, newest first |

**Who may submit.** Only the signed-in owner of the conversation, and only for
a report of that conversation. Moderators, other signed-in accounts and
participants are refused (`403 OWNER_REQUIRED`); an unsigned request is refused
(`401 AUTH_REQUIRED`). Ownership is checked before any read and again just
before the write.

`section` is the exact topic key, `job#layer#cluster`. The request and response
shapes are the ones `polis collective export` and `import` send and parse
(`polis-cli/crates/polis/src/collective.rs`). The CLI treats HTTP 404 on these
routes as "this site does not serve the agent path", so a served route never
answers 404: an unknown topic or report is `422 TOPIC_NOT_FOUND` /
`422 REPORT_NOT_FOUND`.

## Export

The manifest carries `schema_version`, `conversation_id`, `report_id`, a fresh
`export_id`, `section`, the export vote convention (+1 agree), the eligibility
`policy`, `math_tick`, a `source_digest`, its `limitations`, one section (topic
name, `citation_ids`, the eligible comments with their counts and consensus,
and the writing instructions), `input_digest` and `result_schema`.

Eligibility is the existing report gate: the mean of Laplace-smoothed group
agree rates at least 0.8, participation at least 0.05 in every group, and at
least three such comments (`409 INSUFFICIENT_CONSENSUS` otherwise). Participation
keeps the inherited A+D+S rule (S includes seen); changing it is a separate
decision. A conversation with no committed math, or no topic membership, is
refused (`409 NO_MATH`, `409 NO_TOPIC_INPUTS`). Counts come from
`votes_latest_unique` through the vote convention module. Consensus is decimal
text so JSON parsers cannot round it. Participant text is evidence for the
writer, never instructions to it.

## Import

The writer copies `schema_version`, the public IDs, `export_id`, `input_digest`
and `section` from the manifest, names its `model`, and supplies one cited
document in `results`. Every clause needs at least one citation from the
section's `citation_ids`. Optional provenance:

- `prompt_sha256`: hex SHA-256 of the exact prompt text the model was given;
- `runner`: who ran the writer, as they want it shown (same characters as `model`).

The server re-prepares the inputs and refuses the import if their digest no
longer matches (`409 STALE_COLLECTIVE_INPUTS`: export again). Unknown fields,
malformed documents, out-of-set citations, a different conversation or report,
and bodies over 1 MiB (bounded on the wire, before the shared parser; JSON only)
are refused. Retrying the identical file returns the same receipt with
`deduplicated: true`; a different result for the same export is
`409 IMPORT_CONFLICT`. Nothing is retried or overwritten automatically.

The response is `{status, id, imported, deduplicated, provenance}`. `id` is the
stored statement's key, `${zid}#${section}#${export_id}`.

## Provenance and versions

Each import is stored as its own row, so a topic holds one version per import:
different models, prompts and points in time side by side. Each row carries
`provenance: "external agent"`, `model`, `prompt_sha256` and `runner` (null when
not stated), `math_tick` (the math the inputs were read from), `created_at`
(when it was imported), `export_id`, `input_digest`, `policy`, the statement and
a snapshot of the cited comments. The server attests only that the conversation
owner's account imported it; that account is kept in a private receipt, never
in a public response.

`GET /api/v3/delphi/collective/results` lists every version.
`GET /api/v3/collectiveStatement?report_id=` (the existing reader, used by the
topic page and the collective statements page) still returns the newest per
topic. Statements from the server's own generation route are listed too; they
carry no `provenance` field.

## Topic page

The topic page (`/topicStats/<report>/<topic>`) shows the newest stored
statement for the topic, labelled "Imported" with its model when it came from
an agent. When none is stored it says that no candidate collective statement
has been published for the topic yet. A failed read says so. Opening the page
never requests generation (`POST /api/v3/collectiveStatement`, which calls a
paid model); that route and the topic-stats modal are unchanged.

## Storage

No new table and no migration. Under `DELPHI_RESULT_BACKEND=postgres` the import
publishes through `pd_result_mutate` in one transaction (receipt first, then
the statement) into the conversation's served results: the
`Delphi_CollectiveStatement` family for the statement and the
`Delphi_NarrativeReports` family for the receipt, whose key has no report index
entry. Each put must create a new key; an existing key rolls the whole import
back. Under `dynamodb` the same two items are one conditional transaction on
the tables of those names. Topic names and assignments are read from the
`Delphi_CommentClustersLLMTopicNames` and
`Delphi_CommentHierarchicalClusterAssignments` results of the selected backend.

## The participation path

These routes never use a participation pool. The owner routes' SQL
(ownership, math, comment counts and the import transaction) runs on a
two-connection primary pool of its own (`db/pg-query.ts`); the public versions
list reads on the report/export pool. When the owner pool is busy a request is
refused with `503 COLLECTIVE_STORAGE_UNAVAILABLE` after five seconds rather
than waiting on, or borrowing, a vote, comment or next-statement connection,
and each statement is capped at 60 seconds. Result-family reads take the same
short per-call snapshots as every Delphi reader and hold nothing across other
work. The import takes only the conversation's Delphi result writer lock, never
a lock on votes, comments, participants or conversations.

## Limits

The digest binds the exact topic, the observed assignments, comment text and
counts, the complete math and its tick. Topic results and math are not one
atomic snapshot: re-validation detects observed changes but cannot lock them
against concurrent edits, or prove the assignments belong to the named job.
Moderation filtering is unchanged from the existing collective statement input
path. Reads are bounded to 100 pages and 6 MiB per family, exports to 1 MiB.
