# Polis CLI

A Rust terminal client for Polis. Start with `polis --help`: the whole
product command tree is discoverable, including commands planned for later passes.
Every planned command returns `capability_unavailable` (exit 8) without making a request.

This is an **independent workspace** with three crates: `polis-contracts` (versioned
output/errors), `polis-client` (bounded HTTP), and `polis` (commands and local profiles).
It does not change or depend on the queue/coordinator workspaces or server code.

```sh
cargo build --release --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all --check
./target/release/polis --help
```

The tested release target is macOS arm64. Rust 1.99 built the delivered binary.
`Cargo.lock` pins the reviewed build inputs. Other platforms and older toolchains
have not been verified; credentials use macOS Keychain with an owner-only file fallback.

## Start here

```sh
polis auth login
polis auth status
polis conversation list --json
polis conversation create --topic 'Our next chapter' --json
polis conversation view <public-id> --json
polis seed add --conversation <public-id> --text 'An idea to consider' --json
polis seed csv preview seeds.csv --json
polis seed import seeds.csv --conversation <public-id> --json
polis api '/api/v3/comments?conversation_id=<public-id>' --json
```

A fresh install connects to **pol.is**. `polis auth login` works with no flags,
config file, or environment setup. The public issuer, native client ID, audience
and registered callback port are shipped in `defaults.json` and embedded in the
binary as configuration. Authentication and credentials stay bound to that origin.

Developer overrides for local servers and preproduction are documented in
[development configuration](docs/development.md).

## Authentication

On a fresh install, sign in without configuration:

```sh
polis auth login                    # browser PKCE on this machine
polis auth login --device           # approve in a browser on another device
polis auth status                   # server-verified status, no secret output
polis auth token                    # prints the ACCESS TOKEN: treat stdout as secret
polis auth logout                   # erase local access and refresh credentials
```

Browser login uses Authorization Code + S256 PKCE with a state-bound loopback
callback. Device login displays a verification URL and user code on stderr and
polls the issuer at its requested interval; pending, slow-down, expiry and denial
are handled. Neither flow prints access/refresh/device credentials. `auth token`
is the explicit exception: raw access token on stdout, or the usual envelope with
`data.access_token` under `--json`. It never prints a refresh token or ID token.

Both flows request `openid profile email offline_access`, validate the access token
against `GET /api/v3/users`, then atomically save a plaintext **0600** credential
file under a **0700**, owner-only directory. No ID token is stored or trusted as
identity. Files bind the session to the profile, origin, issuer, public client ID
and audience. Changing auth settings requires login again; environment access
tokens override storage without touching refresh credentials. No real tenant
mutation is needed to install or configure the CLI.

Access tokens refresh silently within 30 seconds of expiry, before an API request.
Rotated refresh credentials are saved before the API request; an omitted replacement
retains the prior refresh token. A file lock prevents concurrent refresh and logout
from overwriting each other (`credential_busy` asks the caller to rerun). If the
issuer returns `invalid_grant`, saved credentials are cleared and login is required.
A transient refresh failure returns an error without an API request or automatic
retry. Interrupted/ambiguous refresh exchanges can require sign-in again, especially
with rotating credentials. No refresh credential returned means expiry requires login.
The CLI does not retry an API mutation after a 401 or decode JWTs for authorization.

Credential reads refuse symlinks, nonregular/multiply linked files, other owners,
group/world permissions and mismatched bindings. Keep the credential directory
out of repositories and shared backups. Profiles contain configuration only.
On macOS an interactive sign-in (browser, device or `--token-stdin`) saves the
credential record in the login Keychain; the credential file then holds only a
secret-free pointer, the lock and logout tombstones. The owner-only file holds the
record itself only as a fallback: when the Keychain cannot be written, under
`--no-interactive`, on other platforms, and for an older file sign-in until the next
interactive sign-in moves it. A refresh rotation stays in the backend that holds the
session, falling back to the file if the Keychain write fails. `login` reports the
backend used in `storage`. `--with-token` explicitly uses the file backend;
`--token-stdin --no-store` validates without persistence. Manual access tokens have
no issuer refresh credential or tracked lifetime.

`--no-interactive` never shows browser or Keychain dialogs; it still reads and
rotates a Keychain sign-in when macOS needs no unlock or access approval, and
otherwise fails with `credential_store_unavailable`. Device login still needs
approval in another browser. `--no-browser` prints the PKCE URL for opening on the
same machine. `POLIS_TOKEN` overrides saved access tokens for pol.is (the older
`POLIS_TOKEN_PROD` still works; `POLIS_TOKEN` wins if both are set), and
`POLIS_TOKEN_<UPPERCASE_PROFILE>` does so for developer profiles;
unset it separately after logout. Logout clears local access/refresh credentials
and leaves a token-free tombstone suppressing older Keychain entries; Keychain
deletion is best effort. It does **not** revoke the issuer grant or end the provider
browser session. No provider logout/revocation request is sent.

Run the local-only OAuth acceptance suite after building:
`python3 tests/oidc_flows.py target/debug/polis`. The simulator covers PKCE, device
polling, refresh rotation/revocation, storage isolation and explicit token output.
An operator performs the first real tenant sign-in; local tests do not prove the tenant's
client-specific Actions, API offline-access policy or account permissions.

## Seed imports

CSV is UTF-8 (optional BOM), at most 500,000 bytes and 1,000 records, with exactly
`comment_text` and `original_id` headers in either order. `original_id` may be an
external identifier (1–200 bytes, nonblank, no control characters). UUID inputs
are preserved in canonical spelling; other IDs become deterministic UUIDv5 values
from the normalized origin, conversation ID and exact external ID. Text is unchanged.
`data.id_mapping` retains external and submitted IDs alongside `data.receipt`.
The database UUID contract is unchanged; stable mapping is not a server idempotency
or automatic-retry guarantee. Statement text must be nonblank, contain
no NUL, and fit 997 UTF-16 units. Duplicate text/IDs, blank records, malformed quoting,
and unknown columns are rejected before HTTP. Text, whitespace, and embedded line
breaks are preserved. No normalization or silent row dropping occurs.

```csv
comment_text,original_id
A generated example statement,00000000-0000-4000-8000-000000000001
```

Both `seed add` and `seed import` use `POST /api/v3/comments-bulk` with `is_seed=true`.
This endpoint enforces moderator permission; the ordinary statement endpoint's
seed-flag permission gap is deliberately not used. `seed add` generates a UUID.

Imports are neither atomic nor assumed idempotent. `data.receipt` preserves the
server's per-row results. Skipped, failed, or missing results produce `ok:false` and
exit 1 with the receipt retained. Save `--json` output as your receipt and read back
before retrying; an automatic resume/reconciliation manifest is not implemented.

## Moderation and stored reads

```sh
polis moderate list --conversation <id> --status pending --limit 100 --offset 0
polis moderate accept --conversation <id> --tid 0
polis moderate reject --conversation <id> --tid 0
polis participant status --conversation <id>
polis participant list --conversation <id>
polis participant xid list --conversation <id>
polis vote list --conversation <id> --pid 0
polis report list --conversation <id>
polis report view <report-id>
polis report export <report-id> --type votes.csv --output votes.csv
polis report export <report-id> --type format.json --output format.json
polis delphi status --report <report-id> --job <job-id>
polis delphi results --report <report-id> --job <job-id>
polis delphi narrative view --report <report-id>
polis delphi visualization view --report <report-id>
polis plan view
```

Moderation requires a server-authorized moderator. Accept/reject reads the current
moderation row, preserves `is_meta` and `velocity`, and preserves `active` on rejection
(accept sets it true, like the admin client). The current server ignores `tids` in
moderation reads, so the CLI selects the matching row from the returned list, capped
by the HTTP 8 MiB limit. There is no server compare-and-set: avoid concurrent edits
to the same row. A failed pre-read sends no PUT; an uncertain PUT is never retried.
List pagination is the server's limit/offset contract, not a snapshot guarantee.

`participant status` and `participant list` read **only the authenticated account's
participation record**; the list labels this scope and does not pretend to be a
roster. `participant xid list` reads the existing moderator-authorized XID mapping.
`vote list` reads latest votes for the supplied PID, including PID zero; without a
PID it first resolves the account's participant record. No join or vote is written.
The wire sign is agree -1 / disagree +1 / pass 0; nulls and rows are preserved.

Report view reads configuration, not generated prose. Export fetches exactly one
existing server CSV/JSON route, bounded to 8 MiB and the selected request timeout,
without enqueuing an export job. Files are published without overwriting an existing
path or following a destination symlink. CSV bytes are preserved, including cells
that spreadsheets may interpret as formulas. Treat downloaded content as untrusted.
CSV vote exports use their own signs (agree +1); read the `format.json` sidecar.
No sign conversion or automatic artifact-URL/redirect following is performed.

Delphi results/narrative view reads only `/delphi/reports`; it never calls the
on-demand `/reportNarrative` generator. Status/visualization reads use stored
`/delphi/visualizations` data (the existing API also lists S3 objects). Job status,
`workLive` and supersession are preserved. Empty job metadata is not proof that
no jobs exist because the legacy server can mask a failed metadata read; the CLI
labels it `no_jobs_returned`. Missing `workLive` stays missing. No paid submit,
refresh, polling, download from signed URLs, or cleanup action is inferred.

Plan view verifies the account through `/users` and reports plan, entitlements and
quota as **unavailable**, never unlimited or zero. This API has no authoritative
billing contract. Paid commands remain planned and return exit 8.

## Automation and errors

Use `--json --no-interactive`. Every invocation, including help and parser errors,
produces one `polis-cli/1` envelope. `polis schema [command ...]` exposes the command
tree, implementation status, and arguments. Help/schema do not need a working profile
file or credentials. `polis agent guide` describes the automation contract.
Human-readable network results currently use pretty JSON too.

Network waits default to 30 seconds, configurable from 1 to 300. Responses are bounded
to 8 MiB. Redirects and **all automatic HTTP retries** are disabled. Requests cannot
escape the selected origin's `/api/v3/` prefix. Non-JSON responses, malformed JSON,
HTTP-200 error envelopes, partial seed imports, and 304 responses are not successes.
Arbitrary upstream error bodies and credential-store errors are not echoed into
normal diagnostics. Raw API successes return their requested data, so choose raw
endpoints deliberately when retaining output.

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Operation/protocol failure or partial import (read retained receipt) |
| 2 | Invalid input or unconfigured site |
| 3 | Authentication or credential-store failure |
| 4 | Permission denied |
| 5 | Conflict |
| 6 | Rate limit, read/server or transport failure |
| 7 | Mutation outcome unknown; read back before retry |
| 8 | Planned capability unavailable |

`conversation list` uses the current API's bounded limit (default 100, maximum 9999).
There is no offset or cursor: when the site returned `--limit` rows,
`pagination.truncated` is `true`, conservatively; raise `--limit` to read more. No
invented pagination or exhaustive-list claim is made. Raw GETs may cause work, so
`api` transport failures conservatively use mutation outcome handling. Quota/usage
always reports `unavailable`; this client does not infer billing authority from roles.

## Scope and evidence

Working: auth login/status/logout/token,
conversation list/view/create, seed add/import/CSV validate/preview, moderation
list/accept/reject, scoped participant status/list/XID reads, latest vote list,
report list/view/export, stored Delphi status/results/narrative/visualization reads,
plan view (explicitly unavailable billing), raw API and help/schema/agent guide.
Other mapped commands remain explicitly planned.
No payment, paid analysis, automatic deployment or Docker management is
implemented by the binary. The wider local acceptance harness is kept
separately; it is not part of the installed CLI.

## Browser sign-in and owned conversations

The shipped `defaults.json` and optional `profiles.example.json` contain the
registered native public client settings. A fresh install needs no profile file;
existing profile files are respected. Domain and issuer defaults live in
configuration. No client secret is needed or accepted.
The first real pol.is sign-in is made by an operator, never by the tests.

```sh
polis auth login
polis conversation list --mine --recent --limit 25
polis conversation list --limit 500 --active true --draft false --search 'Topic'
```

The registered production callback is `http://127.0.0.1:53147/oauth/callback`.
The configured issuer's standard OIDC metadata supplies authorization/token
endpoints; there is no Polis discovery route. For local simulators and preproduction,
see [development configuration](docs/development.md). TLS verification stays enabled.

Login opens the system browser. `--no-browser` or `--no-interactive` prints a URL on
stderr for opening on the **same machine**; stdout remains the final JSON envelope.
It uses Authorization Code with S256 PKCE and state, receives a loopback callback,
and verifies the access token with `/api/v3/users` before saving a plaintext **0600**
file in a **0700** directory. Refresh credentials are retained when provided,
with issuer/client/audience binding and silent renewal. No ID token is stored.
Logout erases local credentials but does not end the issuer browser session. Without OAuth configuration, existing token/env login remains available; with a configured issuer, login starts a fresh browser flow. A failed forced login
leaves a previously saved credential unchanged.

Conversation listing reads the current `GET /api/v3/conversations`, which answers
with an array of the conversations the account owns or shares a site with, newest
created first, at most `--limit` rows; it has no offset, cursor, owner filter or
search parameter. The CLI keeps only rows whose server-set `is_owner` is `true`, so
`pagination.returned` can be below `pagination.server_rows`; `pagination.truncated`
is `true` when the site returned `--limit` rows. `--mine` and `--recent` name the
defaults. `--active` and `--draft` are applied by the site; `--search` is a literal,
case-insensitive topic substring (including `%` and `_`) applied to the rows read.
An answer that is not an array of rows with a boolean `is_owner` is refused as
`invalid_response`, never shown as a list.

Moderation, report view/export and stored Delphi reads retain the previous pass's
semantics. Plan view verifies the account and reports billing/quota unavailable.
No paid job is submitted. Native simulator 0.10.2 does not enforce the PKCE verifier;
the real-stack proof is supplemented by independent issuer/callback controls.

### Use an existing admin web session

As an alternative to native login, an admin can sign in to the admin web app, open
Developer Tools → Network, and select an authenticated `/api/v3/users` request
(reload if needed). Copy only the bearer access token from its Authorization request
header, not an ID token. Configure the matching site origin, then on macOS:

```sh
pbpaste | polis auth login --with-token
```

`--with-token` reads stdin, validates `/api/v3/users`, and **always** saves to the
0600 file, even without `--no-interactive`. It never prints the token or takes it
as a command argument. No native client registration is needed for this import.
The admin supplies their own token; the tests never use a production login.

## Pass four

`conversation close|reopen <id>` uses owner-protected endpoints and confirms the
stored state. `participant export` / `participant xid export` downloads the
moderator-authorized XID mapping as CSV or JSON; this is not a full roster.
`report export --format json` converts CSV to ordered string-cell arrays while
`--format raw` preserves bytes. Existing `--type` lists all direct server formats.

`seed import seeds.csv --conversation <id> --votes votes.csv --source-agree=+1`
adds optional votes through the server's sign-aware importer. Declare the actual source
sign (+1 or -1); no default or CLI sign conversion. Statement and vote operations
are separate: keep their receipts, and treat `processing` as queued, not complete.
The importer requires a target with no votes and a configured import worker.

`plan upgrade|manage` and `plan view --web` open the existing site account page;
plan/checkout remain unavailable. Use `--no-browser` or `--no-interactive` for URLs
only. This neither changes a plan nor starts a payment.

`polis help tutorial` is the getting-started manual. `polis completion` generates
Bash, Zsh, Fish, PowerShell or Elvish scripts from the same command tree. See
[JSON output](docs/json-output.md) and [envelope schema](docs/envelope.schema.json).

## Organizer settings and sharing

`account view` reads the authenticated profile. `conversation edit ID` supports
topic, description, draft, public-data and strict-moderation settings, with explicit
booleans. It requires a complete moderator read, preserves five legacy defaulted
flags, and verifies the requested and preserved settings. There is no server
compare-and-set; coordinate concurrent edits. `conversation share ID` returns
unverified links without a request or message. `conversation stats ID [--until MS]`
reads moderator event statistics, bounded to 8 MiB, without a report-ID fallback.

`report create --conversation ID` creates configuration only. The API returns no
created ID: the CLI keeps `report_id: null` and an accepted receipt, plus an
uncorrelated readback list or `readback_state: unavailable`. Repeated creation can
create duplicate reports. Report edits and statement selection remain planned.


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


Agent collective statements and public configuration:
  polis delphi statement export CONV --report REPORT --topic 'JOB#0#1' --output NEW_DIR
  polis delphi statement import CONV result.json --report REPORT --json
  polis metadata question add --conversation CONV --key 'Where do you live?' --json
  polis context create --name 'Our community' --json

Statement export/import uses the server's statement exchange: owner/report/topic binding,
fresh input digest, cited results and external-agent provenance. No model is called.
The existing collective export/import command paths remain compatible. Treat all
exported comment text as untrusted evidence. Use the exported schema; never retarget
an input. Consensus decimals remain text. Read stored results with collective list.
This does not adopt the held TopicPage generation-on-view change.

Question creation requires exact ownership and unique text within the conversation,
including deleted questions. Duplicate text can return the legacy HTTP 500;
the CLI conservatively reports an unknown outcome and directs you to read back. Context
creation requires sign-in and always creates a public, site-wide name. Both reject
surrounding ASCII spaces rather than silently accepting the server's trimming.
Readback is an observation; an accepted receipt survives readback failure. Inspect
lists before retrying an uncertain write. Neither command retries automatically.
Answer-option writes and metadata deletion remain unavailable.

Metadata cleanup (pass ten):

```sh
polis metadata question delete --conversation CONV --question 7 --yes --json
polis metadata answer delete --conversation CONV --question 7 --answer 9 --yes --json
```

Both require sign-in, exact conversation ownership at the server, and explicit
`--yes`. The CLI checks active question/option membership before one DELETE.
A missing, deleted, mismatched or malformed target sends no write. Question
deletion also soft-deletes its options using two non-atomic server updates.
There is no compare-and-set; concurrent changes can occur after preflight.
The accepted receipt survives failed readback. `readback_state=observed` means
absence from active lists only, not physical erasure or deletion of participant
responses. Text may remain reserved. Inspect both lists before retrying an
unknown/partially applied operation; there are no automatic retries. Answer
creation remains unavailable; no server authorization behavior changes.


Metadata answer options

  polis metadata answer add --conversation CONV --question 7 --value "Local resident" --yes --json

This creates an option under an active question, or reactivates a deleted option
with exactly the same text, possibly retaining its ID. The receipt does not
distinguish those outcomes. Active exact-text duplicates are refused before POST.
Options are not participant responses. Requires sign-in and exact conversation
ownership; accepts 1–999 UTF-16 code units without trimming, surrounding ASCII
spaces or controls. It preserves accepted receipts if readback fails. Inspect BOTH
metadata lists before retrying any uncertain result; no automatic retry.
Preflight and readback are not atomic or compare-and-set. The existing server
does not independently bind question ID to conversation; the CLI membership
check is not a server authorization boundary. Concurrent deletion can make
readback not_confirmed. Required/exclusive settings and participant responses
are unchanged.

## Stored math presentation

`polis math view --conversation CONV --json` reads public `/math/pca2` without
submitting a worker task. Repeat `--key` for exact top-level fields. Whole gzip
and subset JSON responses have 8 MiB compressed and decoded limits; no cache,
conditional headers or automatic retry. The output is a parsed served
presentation, not a raw checkpoint or a freshness/computation certificate. The
server can synthesize defaults even with math_tick zero. Missing selected fields
remain absent. Inherited JSON float roundoff remains; use an independent
raw archive for exact numerical bytes. `math correlation` remains unavailable
because its legacy GET can enqueue work; `math refresh` is also unavailable.

Base-cluster membership reads (pass thirteen):

    polis participant group-members --conversation CONV --json

Reads the public `/bidToPid` presentation once, preserving `data.bidToPid`,
member order, empty clusters and unknown response fields. Array positions are
base-cluster indices, not opinion-group IDs. This is not a full participant
roster. Requires HTTP 200 JSON and unique nonnegative PostgreSQL participant IDs;
response size is bounded to 8 MiB and waits obey `--timeout`.
Missing math is `membership_unavailable`; the legacy route also hides storage
failures behind 304, so unavailability cannot prove an empty conversation.
An empty stored map is valid. No generation is returned: do not join this map
to a separate math read or infer freshness/coherence. No cache, conditional
request, computation, refresh or automatic retry; optional site credentials
remain subject to server validation.


Participant profile reads:

    polis participant highlight list --conversation CONV --json
    polis participant highlight list --conversation CONV --mod 1 --json

Reads existing profile-image-backed XIDs, with optional exact participant moderation
filter. Omit --mod for all stored values. Empty can mean withheld access; only the
exact owner, a Polis developer or an open-data conversation exposes rows. This is
not a complete roster or paginated traversal; the API caps candidates at 99999
before profile filtering. Rows and untrusted profile text/URLs remain
unchanged; URLs are not fetched. No write, computation or automatic retry.

### Stored participant locations

`polis participant locations --conversation CONV --group 0 --json` reads the
existing public location route once. `--group` is the opinion-group array index
in the site's math, not the group's stored ID or a base-cluster index. Each
row has `lat`, `lng`, `n=1`; duplicate points, order and extension fields survive.
Optional saved credentials apply. No external map or geocoding request is made.

Empty also covers absent/refused math and absent groups; it is not proof of no
participants. Math can be cached and locations are read separately. There is no
generation, population-completeness, freshness or cross-read coherence claim.
Responses are bounded to 8 MiB and `--timeout`; invalid geographic coordinates
are refused, never clipped or silently removed. No retry or write occurs.

### Participant translation preferences

```sh
polis participant preferences --conversation CONV --translations true --json
polis participant preferences --conversation CONV --translations false --json
```

Sets only the signed-in account's stored `show_translation_activated` preference.
One bounded PUT; no participant target, implicit boolean, join, translation job or
automatic retry. The empty legacy receipt also succeeds when no preference row
exists: output is `state=acknowledged`, `affected_rows=null`, `persistence=unverified`.
It never claims the value changed. No preference readback route exists; participant
status does not return it. For an uncertain response, ask the site operator to inspect the stored preference before retrying. Requires sign-in; response bound 8 MiB
and `--timeout` apply.

### Conversation ID allocation

The legacy route fails on a fresh database: its zid=0 registration violates the
conversation foreign key unless a row-zero sentinel already exists. This is a known
server limitation; the CLI does not create the sentinel or repair it.

`polis conversation reserve --json` sends one authenticated POST and returns the
server's ten-character ID and receipt. `state=allocated`, `conversation_created=false`
and `owner_bound=false` describe the legacy registration at zid=0. This is not
a conversation, ownership grant or exclusive claim. No reservation lookup, release,
expiry or idempotency contract exists. Preserve the receipt for a later explicit
API creation request; `conversation create` does not yet accept a reserved ID.
Each call can allocate another ID. Incompatible or lost replies retain exit 7,
`conversation_reservation_outcome_unknown`, and operator-inspection guidance.
No automatic retry/readback; 8 MiB and `--timeout` bounds apply.

### Invite reads and the conversation download key

```sh
polis invite code list --conversation CONV --json
polis invite wave list --conversation CONV --wave 1 --json
polis invite list --conversation CONV --status unused --limit 50 --offset 0 --json
polis invite export --conversation CONV --output invites.csv --json
polis invite status --conversation CONV --json
polis conversation uuid CONV --json
```

These commands use the existing site routes and saved sign-in. Code listing is
strictly owner-only on the current server; other routes enforce their site's
permissions. The CLI does not add an authorization boundary to an older server.
Code listing preserves the unspecified server order and exposes only the code
and creation time. Wave listing preserves the server's rows and order, projecting
only the documented fields. Decimal BIGINT IDs and creation times are normalized
to exact JSON-safe integers; out-of-range values are refused. Invite listing supports `--wave-id` and the statuses
`unused`, `used`, `revoked`, and `expired`; numeric wire statuses become names.
The output includes `invite_only` from a separate conversation read, even when
false. Pagination retains the server's `limit`, `offset`, `total`, and `hasMore`.

Status reads conversation settings, waves, and four status-filtered pages. Counts
come from each page's total, never its row count. These are separate reads, so the
result is not an atomic snapshot. Participant-owned codes are excluded. A failed
or malformed read fails the command without reporting partial counts.

CSV export downloads all owner codes without filtering or pagination. It preserves
bytes, including formula-like cells, and creates a private file without replacing
an existing file or symlink. Treat CSV as untrusted data and keep codes private.
The existing 8 MiB response bound, request timeout, no-redirect and no-retry rules
apply. Invite creation and revocation remain unavailable (exit 8).

`conversation uuid` deliberately prints a **secret**: anyone holding this key can
download participant XIDs. Without `--json`, stdout contains only the raw key and
a newline; JSON puts it in `data.conversation_uuid`. The server can mint a key on
the first GET. A lost or malformed success is therefore an uncertain operation
(exit 7); no automatic retry is made. Error responses never echo the upstream
body or key. Do not capture successful key output in shared logs.
