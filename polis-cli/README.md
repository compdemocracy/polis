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

The release build uses the pinned Rust toolchain and `Cargo.lock`.
See [building, installing and updating](docs/releases.md) for native artifacts,
commit identity, platform qualification and explicit installation. Credentials
use an owner-only file store by default on every supported platform.

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

## Sites

One CLI works with pol.is, your local stack, a community's self-hosted installation,
and regional hosts. **pol.is is the default with no setup.** Add a name for another
site, then use `--site NAME` on any command to visit it just for that command:

```sh
polis site add dev http://localhost:5000
polis --site dev conversation list --json
polis conversation list --json              # back on pol.is
polis site list
```

For a self-hosted site, ask its operator for the address and public sign-in
settings. These example.org addresses are placeholders:

```sh
polis site add community https://polis.example.org \
  --issuer https://login.example.org/ --client-id PUBLIC_NATIVE_CLIENT_ID \
  --audience users --callback-port 53147
polis --site community auth login
polis --site community conversation list
```

A local stack with OAuth uses the same options, with its loopback issuer and
native client ID. Otherwise use `polis --site dev auth login --with-token` with a
token issued by that stack. Adding a site never signs in or contacts a server;
pol.is sign-in settings are never copied to other sites. `--callback-port` is
optional; the browser callback defaults to port 53147. Its redirect address must
be registered by the site's operator.

For repeated work on a regional site, save it as your preference. Return to
pol.is with one command:

```sh
polis site add eu https://polis.eu.example.org \
  --issuer https://login.eu.example.org/ --client-id EU_PUBLIC_NATIVE_CLIENT_ID \
  --audience users
polis site use eu
polis auth login
polis conversation list
polis --site default conversation list      # pol.is for just this command
polis site use default                     # pol.is for following commands too
```

`site use NAME` is an explicit sticky preference. Without a flag, commands use
that preference until `site use default` restores pol.is. `default` is reserved
and refers to the built-in `prod` profile; the older `prod` name still works.
The flag works before or after subcommands and never changes your saved preference.
When an operation targets an origin other than pol.is, a **Site: NAME (URL)**
header on stderr identifies it, including a developer override of the prod URL.
JSON mode has no header. Offline help, the questions guide, schema and shell
completion do not select a site and stay independent of configuration.

You sign in separately at each site. Sign-ins and participant credentials are
bound to the **site name and origin**, and account sign-ins also bind the issuer,
client ID and audience. Two aliases never share a login even at the same host.
Credentials stay in the owner-only file store by default. Site management never
accesses credentials or the Keychain.

```sh
polis --site community auth logout
polis site remove community
```

Removal changes only configuration. Log out first to revoke and clear an account
sign-in. Otherwise saved credentials remain; re-adding the same name and origin
can reuse them. Removing the saved preference returns to pol.is. Neither `prod`
nor `default` can be removed. Site commands do not change accounts or conversations.

Aliases are saved in `~/.config/polis/profiles.json`. Names use 1–40 lowercase
letters, digits or underscores; existing names cannot be overwritten. Use a new
name when changing a host or sign-in provider. Only HTTPS origins are accepted,
with HTTP allowed on loopback for local stacks. Origins cannot contain credentials,
paths, query strings or fragments; an OAuth issuer may have a path.

For developers, existing environment overrides still use these same profiles:
**`--site NAME` > `POLIS_SITE` > saved preference > pol.is on a fresh install**.
`site use default` changes the saved preference; an explicitly set `POLIS_SITE`
still wins until unset, or use `--site default`. `POLIS_URL_<PROFILE>` and
`POLIS_AUTH_*_<PROFILE>` still override that profile's origin and sign-in settings,
including prod; they are never written back by site commands. `site list --json`
shows effective origins and both the selected and saved site without reading tokens.
See [development configuration](docs/development.md) for custom certificate
authorities and `POLIS_CONFIG_DIR`.

## Authentication

On a fresh install, sign in without configuration:

```sh
polis auth login                    # browser PKCE on this machine
polis auth login --device           # approve in a browser on another device
polis auth status                   # server-verified status, no secret output
polis auth token                    # prints the ACCESS TOKEN: treat stdout as secret
polis auth logout                   # revoke the refresh token, then clear local credentials
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

Commands that require sign-in, and the raw `api` command, refresh access tokens
silently within 30 seconds of expiry, before an API request. Named public reads
(conversation/report views, report exports, Delphi reads, math and participant
read views) use an explicit token override or a usable saved file token. They
never refresh, lock the owner credential store, create a credentials directory,
or consult the Keychain. An expired, mismatched, unavailable or unsafe saved
credential is left untouched and the public read proceeds anonymously; run
`polis auth login` for a resource that requires a current owner sign-in.
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
Every saved sign-in (OAuth access and refresh tokens, or a manual token) uses the
owner-only file store by default on every supported platform: `credentials/` under
`~/.config/polis/`, or under `POLIS_CONFIG_DIR` when set. The directory is 0700 and
credential files are 0600. Refresh rotation replaces the saved session atomically.
`login` reports the backend used in `storage`.

The CLI never calls the Keychain by default, including reads, migration, replacement
and logout. A sign-in saved only in the Keychain appears **not signed in**: run
`polis auth login` once to save a new session in the file store. Existing Keychain
entries are left alone. No local signing setup or Keychain approval is needed.

`POLIS_KEYCHAIN=on` explicitly opts into the macOS Keychain. Keep it set for commands
that use that sign-in. Unset, `off`, or any other value uses the file store. Opted-in
calls also suppress Keychain dialogs; inaccessible reads return
`credential_store_unavailable`, and failed writes fall back to the file store.
`--with-token` always writes to the file; new `--no-interactive` sign-ins also use
it. Refresh stays in the current backend when opted in, with file fallback if a
Keychain write fails. `--token-stdin --no-store` validates without persistence.
Manual access tokens have no issuer refresh credential or tracked lifetime.

`--no-interactive` never shows browser or Keychain dialogs.
Device login still needs
approval in another browser. `--no-browser` prints the PKCE URL for opening on the
same machine. `POLIS_TOKEN` overrides saved access tokens for pol.is (the older
`POLIS_TOKEN_PROD` still works; `POLIS_TOKEN` wins if both are set), and
`POLIS_TOKEN_<UPPERCASE_PROFILE>` does so for developer profiles;
unset it separately after logout. Logout sends the saved refresh token and the
client ID that obtained it to the `revocation_endpoint` advertised by the saved
issuer's discovery document (after checking the metadata issuer matches exactly),
then clears local access/refresh credentials and writes a tombstone suppressing
stale Keychain values. It uses the saved session even when a token environment
override is set or the profile's issuer/client settings have changed. No access
token refresh or Polis API request is needed. Discovery and revocation requests each obey `--timeout`,
with no redirect or automatic retry, and never print tokens or provider responses.

If revocation fails, local cleanup still runs and the command reports
`oauth_revoke_failed` (exit 7, outcome unknown): the refresh token may still be valid, so revoke the
application's access through your identity provider account or its administrator.
A local storage failure is reported separately and does not claim cleanup succeeded.
Successful JSON reports `refresh_token_revocation: "acknowledged"`, or
`"not_available"` (exit 0) when the issuer advertises no revocation endpoint, or for
a manual token, missing refresh token or absent saved session.
Keychain-only sign-ins remain unread unless explicitly opted in; Keychain deletion
occurs only with `POLIS_KEYCHAIN=on` and is best effort without dialogs. Logout does
not end the provider browser session or revoke an already-issued access token.

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
or automatic-retry guarantee. Comment text must be nonblank, contain
no NUL, and fit 997 UTF-16 units. Duplicate text/IDs, blank records, malformed quoting,
and unknown columns are rejected before HTTP. Text, whitespace, and embedded line
breaks are preserved. No normalization or silent row dropping occurs.

```csv
comment_text,original_id
A generated example comment,00000000-0000-4000-8000-000000000001
```

Both `seed add` and `seed import` use `POST /api/v3/comments-bulk` with `is_seed=true`.
This endpoint enforces moderator permission; the ordinary comment endpoint's
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
polis delphi show <report-id> --model <model-name>
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
billing contract. Billing mutations remain unavailable. Explicitly confirmed analysis requests use the existing site routes and may start paid provider work.

## Automation and errors

Use `--json --no-interactive`. Every invocation, including help and parser errors,
produces one `polis-cli/1` envelope. `polis schema [command ...]` exposes the command
tree, implementation status, and arguments. Help/schema do not need a working profile
file or credentials. `polis agent guide` describes the automation contract.
Without `--json`, `conversation list` prints a table (topic, description, the
conversation URL and its newest report URL); other network results use pretty JSON.

Network waits default to 30 seconds, configurable from 1 to 300. Responses are bounded
to 8 MiB. Redirects and **all automatic HTTP retries** are disabled; a redirected
write reports outcome `unknown` (exit 7), since the site may have stored it. Requests cannot
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

Without `--json` the listing is a table: the topic and description (control and
invisible formatting characters removed, cut with an ellipsis to fit the terminal),
the full conversation URL on the selected site, and the URL of the conversation's
newest report, followed by `+N` when it has N more. URLs are never truncated. The
report column comes from a second, best-effort `GET /api/v3/reports`: if that read
fails (permission, transport, or a site without the route), the table still prints
with an empty column, one warning goes to stderr and the exit code stays 0. With
`--json` only the conversations route is read and the envelope is unchanged.

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
sign (+1 or -1); no default or CLI sign conversion. Comment and vote operations
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
compare-and-set; coordinate concurrent edits.

Admission settings change the same way after creation:
`--invite-only true|false` requires invitation membership, and
`--external-id optional|required|allowlist` uses the setup file's external-ID
model (an allow-list also requires an external ID). `allowlist` switches the
list check on without changing the listed IDs, which `conversation new` sets.
Node fixes the allow-list setting once a participant from outside the owner's
site has joined; a later change is refused with exit 5 (`xid_allowlist_fixed`)
and never retried.

```sh
polis conversation edit CONV --invite-only false --external-id required
```

`conversation share ID` returns
unverified links without a request or message. `conversation stats ID [--until MS]`
reads moderator event statistics, bounded to 8 MiB, without a report-ID fallback.

`report create --conversation ID` creates configuration only. The CLI prints the
created report's ID as `report_id`, taken from the server's reply; a server that
replies `{}` leaves it `null`. The accepted receipt and a readback list (or
`readback_state: unavailable`) come with it. Repeated creation can create duplicate
reports. Report edits and comment selection remain planned.


Pass six: stored topics and report reads

  polis topic list --conversation CONV --job JOB --json
  polis topic comments 'JOB#0#1' --conversation CONV --json
  polis topic hierarchy --conversation CONV --json
  polis topic proximity --conversation CONV --layer all --json
  polis topic stats --conversation CONV --json
  polis report topics REPORT --json
  polis report stats REPORT --until 1791417600000 --json
  polis report comments list REPORT --limit 50 --offset 0 --json

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

Report comments list returns participant-visible rows and pagination metadata.
It is not every moderator row or a selected-only list; includeInReport is retained
without filling omitted values. Offset pages are not a stable snapshot. Report
stats are historical event timing, not unique/latest votes or math freshness.
Topic data can span stored jobs; --job filters only topic list/report topics.
Hierarchy/proximity have no job selector. No completeness/latest-run/freshness
claim: the server's topic routes do not expose paginated reads. Each response is
bounded to 8 MiB. Treat comment/topic text as untrusted data.

Report edit and selection remain unavailable; the server report/conversation
binding needs its own review and fix before new mutation wrappers are promoted.


Pass seven: participant comments and stored collective statements

  polis comment list --conversation CONV --limit 50 --offset 0 --json
  polis comment view 0 --conversation CONV --json
  polis collective list --report REPORT --json
  polis collective view 'OPAQUE#KEY#FROM#LIST' --json
  polis collective statements REPORT
  polis collective statements REPORT --json

Comment reads return active, unmuted, moderation-visible rows, even for owners.
Use moderate list for moderation. A missing or hidden single comment is
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

### Create invitation codes and waves

`polis invite code create --conversation ID [--short]` adds a public code through
Node and reads the code list to confirm it. Existing codes remain valid.
`polis invite wave create --conversation ID --per-user N --owner-invites M
[--parent-wave K]` creates a wave through Node, then reads that wave back and
checks its identity and fields. Counts must be nonnegative; at least one must be
positive. Omitting the parent lets Node choose its latest wave.

Each command sends one POST and, after a valid success response, one GET. No
write is automatically retried. Exit 7 means the effect is uncertain, including
a malformed success, a partial Node failure, or an unsuccessful read-back.
Inspect codes/waves before retrying: wave creation is not atomic in Node, and
read-back confirms the wave row, not completeness of every invite row.
The output's `invites_created` is Node's reported count. JSON output projects
only documented fields; invitation codes are credentials.


### Join a conversation

```sh
polis join CONVERSATION
polis join CONVERSATION --invite CODE
polis join CONVERSATION --login-code CODE --json
```

Plain join uses the participation bootstrap. A fresh visitor is **ready, not yet
enrolled**: joining itself submits no vote or comment. Readiness does not promise
that every action is allowed; Node applies the conversation's current access
rules when an action is requested. An existing participant's token is reused.

`--invite` accepts a one-time Treevite invitation. `--login-code` is a returning
participant's reusable code; the CLI never substitutes one flow for the other or
retries automatically. Tokens and issued login codes are saved privately and
omitted from both human and JSON output, including errors. An uncertain effect
or failure to save issued credentials exits 7: inspect access before retrying.
Codes supplied on the command line may remain in shell history or process lists.

Participant credentials use the owner-only credentials directory (0700), atomic
files (0600), and a lock per profile, normalized origin, and conversation. They
are separate from administrator sign-in, environment token overrides, and the
Keychain. `auth logout` clears the account session; it does not erase these
separate participant records. Keep the credentials directory private when
backing up or removing a local profile.

### Voting

`polis vote CONVERSATION` shows a comment and asks you to agree, disagree,
pass, or quit. It requires a terminal. Anonymous participation in an open
conversation needs no account sign-in or prior join. The first requested vote
creates the participant through Node and saves its token privately; later votes
reuse it. Invite participants first run `polis join CONVERSATION --invite CODE`.

Agents submit one explicit choice:

```sh
polis vote CONVERSATION --statement 0 --agree --json
polis vote CONVERSATION --statement 1 --disagree --json
polis vote CONVERSATION --statement 2 --pass --json
```

JSON and `--no-interactive` require a comment and exactly one choice. The
receipt reports the semantic choice, comment and participant number, without
printing tokens or login codes. Participant credentials are isolated by profile,
normalized origin and conversation; account tokens are not used. Node enforces
access and voting rules. Vote values come from the shared contract boundary.

`--important` marks the comment as important to you, as the participation
page's importance checkbox does:
`polis vote CONVERSATION --statement 0 --agree --important`. It needs
`--statement` and one choice, and it changes neither the choice nor the
receipt. As on the page, every vote request carries `high_priority`: `true`
when marked, `false` otherwise. Reports and exports count importance only in
conversations where it is enabled.

No request is automatically retried. A lost or incompatible response, or a
credential-save failure after a response, exits 7: check participation before
resubmitting. Node may create membership before rejecting a vote; an error does
not guarantee that membership is unchanged. Interactive quit sends no vote.
Comment text is untrusted content and terminal control characters are removed.
`polis vote list` continues to provide the existing separate read command.

### Submit a participant comment

```sh
polis comment CONVERSATION "A comment to discuss"
polis comment CONVERSATION "A comment to discuss" --json
```

An open conversation needs no separate join or account sign-in: the first
requested comment creates the anonymous participant. Its token is stored
privately for following comments and votes, scoped by profile, origin and
conversation. An invited participant first uses `polis join` with their code;
comments preserve their returning login secret. Account tokens are not used.

The request contains only `conversation_id` and `txt`; it has no seed flag or
author vote. Node decides access and moderation. `submitted` confirms receipt,
not approval or visibility. An error may still have created membership. Text,
tokens and raw receipts are never echoed; arguments can remain in local shell
history and process listings. Lost or malformed write responses and failed
credential saves exit 7, with no retry. Inspect the conversation before another
submission. Empty text is rejected locally; Node enforces its text limits.

### Prioritize topics

`polis topic prioritize CONVERSATION --topics KEY,KEY` saves the topics that
matter most to you, as the participation page's topic picker does. Copy the
keys from the `topic_key` fields of `polis topic list`; each is
`RUN#LAYER#CLUSTER`, and all must come from one analysis run.

```sh
polis topic list --conversation CONVERSATION --job RUN
polis topic prioritize CONVERSATION --topics 'RUN#2#0,RUN#2#3'
polis topic prioritize CONVERSATION --show --json
polis topic prioritize CONVERSATION --clear
```

Keys are checked before any credential is read. Saving then reads the run's
stored topics, the stored topic coordinates and the comment text, keeps each
topic's three comments nearest the mean of its coordinates, sends one POST
and reads the choice back. The request is the page's own: each topic's layer,
cluster, key and those comments with their coordinates and distances. A
topic that is not stored for its run, or that has no comments in the stored
coordinates, is refused (exit 5) with nothing sent. A save replaces your whole
previous choice; it never appends.

Anonymous participation in an open conversation needs no account sign-in or
prior join: the first save creates the participant through Node and saves its
token privately, scoped by profile, origin and conversation, for later votes
and comments. Invite participants first run `polis join CONVERSATION --invite
CODE`. Account tokens are not used.

The site, not the CLI, records which analysis run the choice belongs to. The
receipt shows it; when it differs from the run in your keys, the terminal
receipt says so, and `--json` callers compare `readback.data.delphi_job_id`
with their keys. `--show` reads your saved choice and `--clear` deletes it,
then reads back. `--json` returns the site's responses unchanged (`receipt`
and `readback` for writes), with issued tokens removed.

No request is automatically retried. Once the POST or DELETE is sent, a lost
or incompatible response, a failed read-back, or a credential-save failure
exits 7: run `--show` before saving again. Comment and topic text is
untrusted content; the terminal receipt prints topic keys with control
characters removed.

### Start a conversation with a typed setup

```sh
polis conversation new --save setup.json
polis conversation new --from setup.json --dry-run --json
polis conversation new --from setup.json --json
```

The interactive wizard asks about participation, overlapping invitation and
external-ID policies, moderation, visibility, and initial comments, then
shows a summary before asking to apply. Agents use the same typed JSON file.
Dry runs make no HTTP requests. Saved files are private and never overwrite an
existing file.

Setup creates a staged conversation, confirms each settings/wave/allowlist/
comment step, and applies final participation settings last. On partial
failure it exits 7 with the known conversation ID and completed steps, without
retrying. The error says that the conversation exists, closed and invite-only,
and `data.finish` lists the commands that finish it with the requested
settings, for example `polis conversation edit ID --invite-only false
--external-id optional`, then `polis conversation reopen ID`. Inspect that
receipt before trying again: another `new` invocation creates another
conversation. If the site refuses the first create request, nothing was created
and the command exits with that refusal's own code (for example 4, forbidden).
Initial comments use moderator authority, with
no seed bypass flag or automatic vote. No invitation code is printed.

[The complete setting inventory and admission model](../docs/conversation-setup.md)
describe current Node behavior, including restrictions it does not enforce,
and proposed permission improvements. Draft is a listing state, strict
moderation controls visibility, and existing identities can bypass fresh-XID
checks; the wizard does not present nonexistent permissions as working gates.

## Existing-site administrative operations

The client now includes dedicated account, metadata, participant, moderation,
agenda, report, job, notification, invitation and operator operations. See
[the route reconciliation and parameter types](docs/admin-operations.md), or
`polis schema` for the current implementation census. Existing Node permissions
and limitations still apply. Effectful operations require `--yes`; they never
retry automatically and return receipts rather than claims of completion.
Participant operations use conversation-scoped credentials unless `--account`
is explicit. Download paths are private, bounded and never overwritten.

Read the stored collective statements for each topic in a public report:

```sh
polis collective statements REPORT
polis collective statements REPORT --json
```

The text view includes topic and paragraph headings, sentences and citation IDs.
The JSON view preserves the full server response, including metadata and nulls.
This read uses the server's latest statement per topic; it does not generate
statements or call a model.


### Cursor-based owner listing

Use `polis conversation list --sort newest --min-participants 10 --search 'town'`
to call the opt-in Rust owner-list endpoint. `--sort oldest` reverses creation
order. Pass `--cursor` from `data.pagination.next_cursor` and repeat the filters
for the next page. The route requires an OIDC access token, an existing local
user mapping, and both Rust owner-list switches enabled. An unavailable route
never falls back to an unfiltered list.

Supplying `--sort`, `--min-participants` or `--cursor` selects this mode. Its limit
is at most 500; filtering is server-side and pagination uses opaque cursors.
Participant counts are stored counters; pages are not a frozen snapshot.
Without these options, the existing Node list and its owner filtering, local
search, truncation reporting and limit up to 9999 remain unchanged. Neither mode
accepts `--offset`.

If an older or disabled site returns 404 or 502 for the owner-list endpoint,
the CLI returns `capability_unavailable` (exit 8). Authentication, permission
and other server failures retain their existing errors. A gateway outage
returning 502 also means the feature is currently unavailable; this does not
prove it is permanently absent. No unfiltered-list fallback occurs.

### Comment importance

`polis comment list --conversation CONVERSATION --sort importance
--min-important 3` reads the complete participant-visible comment count snapshot, filters
it, orders by important count descending (ties by comment ID), and then applies
`--offset` and `--limit`. With only `--min-important`, order is comment ID.
Plain `comment list` and `comment view` retain their existing behavior.
The new read must be enabled by the site operator. A 404 returns exit 8;
other read failures retain their error codes. No failure invents zero counts. The snapshot is bounded to 10,000 participant-visible comments.
Counts use each participant's latest vote, not every stored vote change. The CLI reads text only for
the selected IDs and checks the exact returned set before printing anything.
A comment that disappears or becomes hidden between reads fails the request;
there is no automatic retry or partial ranking. Repeated offset pages do not
share a snapshot. Each request retains the existing timeout and 8 MiB bound.

`polis report comments list REPORT` adds `important`, `voters`, and the
importance read timestamp. An unavailable read or a comment absent from the
participant-visible snapshot has null counts, never invented zero. A warning and
`importance.state=unavailable` identify failed count reads while preserving the
original comment text and report-selection metadata.

Counts are current reads, not historical analysis inputs. No command starts
analysis, changes comments, casts a vote, or calls a model.

Participant submissions are **comments**; **statements** are collective statements.
Use `comment list`, `comment view`, `comment next`, and `report comments list`.
`polis comment CONVERSATION TEXT` still submits a comment. The other participant
comment operations share that command group. `collective statements` and
`delphi statement export/import` retain their collective meaning. Existing
`--statement` selectors and JSON/API field names retain their wire compatibility;
they select a comment where the command concerns participation.

Comment analysis: `polis comment stats --conversation CONV --sort divisive --by-group`
answers which comments divided the room most. See [the statistics contract](COMMENT-STATS.md)
for denominators, unknown values, bounds and the byte-preserving JSON source envelope.

### Questions to ask about a conversation

Run `polis questions` for ten plain-language analyst questions, the commands for
each, and what to look for. The guide starts with shared ground and divisions,
then covers groups, distinctive beliefs, importance, new comments, vote coverage,
change over time, collective statements, and comparing one participant by XID.
`polis questions --json` returns `data.schema=polis-questions/1`, the introduction,
ordered question entries (`id`, `question`, `commands`, `look_for`) and rendered
help. It works offline without a profile or credentials and runs none of the
listed commands. It distinguishes existing reads from comparisons an analyst
must make and from the consensus timeline the CLI does not yet provide.
