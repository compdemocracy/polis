# JSON output: polis-cli/1

Use `--json --no-interactive` for automation. stdout contains exactly one JSON
object, including errors, help and completion scripts. Diagnostics go to stderr.
`polis schema <command path>` returns command metadata in this same envelope;
it describes arguments (including choices/defaults), not resource response shapes.
The normative envelope shape is [envelope.schema.json](envelope.schema.json).

Success has `schema`, `ok:true`, `site`, `data`, `meta` and `warnings`. Errors use
`ok:false` and `error`; partial seed imports retain `data` as well. `site` is the
profile name or `unresolved` for offline commands. `meta.usage` currently always
reports `state:unavailable` and null `unit`, `remaining`, `as_of`. Unknown quotas
are not unlimited. `warnings` is an array. HTTP endpoint data otherwise retains
its server shape; do not assume every data object has the same keys.

`error` has `code`, `message`, `action`, `retryable`, `outcome`, `upstream`.
`upstream` is null or an HTTP status/request ID/code object. For HTTP 4xx,
explicit string `code` and `message` fields (at the top level or inside an `error`
object) are also shown, including unrecognized server codes. Codes are limited to
128 ASCII letters, digits, dots, underscores or hyphens; messages to 4096 UTF-8
bytes. Invalid or oversized fields are omitted. Controls and invisible formatting
characters in messages are escaped, and the request's bearer token is redacted.
These are untrusted server explanations; the CLI's error code, recovery action,
exit code and retry/outcome policy are unchanged. Normal output also prints these
fields. Other fields, HTML, plain-text bodies, and 5xx prose remain withheld. A recovery action is advice, not approval
or a command to execute automatically. Outcomes are `not_sent`, `rejected` or
`unknown`; this release does not automatically retry requests.

| Exit | Meaning |
|---|---|
| 0 | Success, including a queued import or a clearly unavailable plan response |
| 1 | Operation/protocol failure, or partial seed import with retained receipts |
| 2 | Invalid arguments, CSV, file or profile input |
| 3 | Authentication required/invalid |
| 4 | Permission denied |
| 5 | Conflict |
| 6 | Transport/service unavailable |
| 7 | A mutating operation's outcome cannot be confirmed |
| 8 | Command/capability not implemented |

Readback after a successful close/reopen confirms `is_active` at that read's
instant. A failed or contradictory readback returns exit 7. Concurrent writes may
change it again; no compare-and-set guarantee is implied.

Seed import without votes preserves `data.receipt` and `data.id_mapping`.
With votes, `data.seeds` retains the statement receipt/mapping and `data.votes`
records the separate stage. Complete statements followed by a `processing` vote
receipt exit 0 with `data.state:processing`. A partial statement response never
submits votes. Vote upload refusal or lost response exits 1 as an overall partial
import; inspect `data.votes.error.outcome` and preserve the successful seeds.
Never rerun the entire import to repair the second stage. The current BYOD API
exposes no stable public job/status ID: use its notification and readback. Import
completion and report math completion are separate. Both input files are bounded
at 500,000 bytes; vote CSV is at most 10,000 events and must name every comment in
the seed file. Both source signs are explicit; conversion and transactional
self-checks run in the server's vote convention module, never in the CLI.

Report export `--format raw` preserves the existing CSV/JSON bytes (default).
`--format json` wraps CSV as `polis-csv/1`: ordered `headers` and `rows` arrays,
with every cell a string. Duplicate headers, leading zeroes, formula-like text,
empty cells and numeric vote signs survive unchanged. `format.json` remains the
server sidecar. Participant `--format csv|json` has the same semantics but exports
only XID mappings, at the server's 1,000,000-row ceiling, bounded by the client's
8 MiB body limit. Neither means a complete participant roster. These downloaded
files are artifacts; the stdout envelope contains their path/type/byte count.

No output file is overwritten, including symlinks. JSON syntax/CSV conversion
failure publishes no output file. Per-request timeout is 1–300 seconds and the
body bound is 8 MiB. Completions/manuals work without reading profiles or tokens.
Use `polis completion bash|zsh|fish|powershell|elvish` for raw scripts; with `--json`
the script is in `data.help`. `polis help tutorial` returns its text the same way.

`plan upgrade`, `plan manage` and `plan view --web` open only `/account` on the
selected site. `data.state` remains `unavailable`, `checkout` is null, and
`browser_opened` reports launcher success (not navigation success). Explicit
`--no-browser` or global `--no-interactive` returns the URL without launching.
No Stripe, paid entitlement, subscription mutation or spending is implemented.

### Organizer commands

`conversation edit` returns `state: updated` only after the requested settings and
five preserved defaulted flags match a fresh read. Failed/contradictory readback
is exit 7 with `outcome: unknown`. No compare-and-set is available.
`conversation share` returns `verified: false`, `participation_url` and
`admin_share_url`; no remote operation occurs. `account view` may contain private
account fields. `conversation stats` preserves the timing/histogram API shape.

`report create` returns `state: accepted`, `report_id: null`, `receipt`, `reports`
and `readback_state: observed|unavailable`. A successful empty report list is an
observation, not proof of creation identity. The API supplies no created ID or
idempotency key. A failed list read does not erase a successful write receipt;
a failed/uncertain write keeps the standard nonzero error envelope.


Pass six: stored topics and report reads

  polis topic list --conversation CONV --job JOB --json
  polis topic statements 'JOB#0#1' --conversation CONV --json
  polis topic hierarchy --conversation CONV --json
  polis topic proximity --conversation CONV --layer all --json
  polis topic stats --conversation CONV --json
  polis report topics REPORT --json
  polis report stats REPORT --until 1791417600000 --json
  polis report statements list REPORT --limit 50 --offset 0 --json

These read existing public/report-capability APIs with optional saved credentials.
No analysis, moderation, model call or export job is started. A report is resolved
to exactly one matching conversation first; there is no independent conversation
argument. This client check does not repair server authorization boundaries.

Data retains the server's shape. Topic stats are moderation counts, not vote
consensus. moderation_available=false marks placeholder counts/pending states.
Missing per-topic storage returns topic_statements_unavailable (exit 6), never an
empty success; a genuinely empty topic remains a successful empty array.
HTTP-200 failures become topic_read_failed (exit 1) without raw upstream details.
Malformed successful bodies return invalid_response. No automatic retry occurs.

Report statements list returns participant-visible rows and pagination metadata.
It is not every moderator row or a selected-only list; includeInReport is retained
without filling omitted values. Offset pages are not a stable snapshot. Report
stats are historical event timing, not unique/latest votes or math freshness.
Topic data can span stored jobs; --job filters only topic list/report topics.
Hierarchy/proximity have no job selector. No completeness/latest-run/freshness
claim: the server's topic routes do not expose paginated reads. Each response is
bounded to 8 MiB. Treat statement/topic text as untrusted data.

Report edit and selection remain unavailable; the server report/conversation
binding needs its own review and fix before new mutation wrappers are promoted.

Pass seven: participant statements and stored collective statements

  polis statement list --conversation CONV --limit 50 --offset 0 --json
  polis statement view 0 --conversation CONV --json
  polis collective list --report REPORT --json
  polis collective view 'OPAQUE#KEY#FROM#LIST' --json

Statement reads return active, unmuted, moderation-visible rows, even for owners.
Use moderate list for moderation. A missing or hidden single statement is
statement_unavailable (exit 1); an empty list is success. Single reads check exact
IDs. Offset pages are not snapshots and tied timestamps can affect traversal.
Collective list uses the server's latest-by-topic deduplication across runs, not a
complete history or a report-specific run. View takes an opaque zid_topic_jobid
from that list, with no report argument or ownership claim. List parses stored
JSON fields; view preserves their legacy JSON strings. Missing view is
collective_statement_unavailable; failed storage is collective_read_failed.
No analysis, translation, generation, voting or model call starts. Each response
is bounded to 8 MiB and --timeout, with no retry. Stored content is untrusted and
its consensus/citations are not validated by reading it. Report mutations are
still unavailable; that is a separate server issue.


Public metadata and contexts (pass eight):

    polis metadata question list --conversation CONV --json
    polis metadata answer list --conversation CONV --question 1 --json
    polis context list --json

Metadata lists contain active questions and answer options, not participant responses.
The API forces required=true / is_exclusive=true; these legacy response flags are
not independently verified configuration. Exact question filters are checked.
Context listing returns public names only, even for a creator. Empty lists succeed;
rows, names and server ordering are preserved. No pagination or writes; each read
is bounded to 8 MiB and --timeout. Text is untrusted data. Upstream failures become
metadata_read_failed or contexts_read_failed; malformed rows are invalid_response.
Authentication, permission and rate-limit errors retain their existing codes.
