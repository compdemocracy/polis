# Administrative CLI route coverage

This reconciles all 77 initially missing application routes against the current client and existing Node behavior. It lists dedicated operations, earlier client coverage, and retired/excluded behavior separately. It does not change server permissions or promise success for a disabled provider, operator gate, or absent store.

| Method | Route | Command or disposition |
|---|---|---|
| GET | `/api/v3/testConnection` | `polis node doctor` |
| GET | `/api/v3/testDatabase` | `polis node database` |
| GET | `/api/v3/domainWhitelist` | `polis account domain list` |
| GET | `/api/v3/metadata` | `polis metadata view` |
| GET | `/api/v3/metadata/choices` | `polis metadata choices` |
| GET | `/api/v3/conversations/recently_started` | `polis conversation started` |
| GET | `/api/v3/conversations/recent_activity` | `polis conversation activity` |
| GET | `/api/v3/math/pca` | Retired: Node always returns 304; use math view (pca2). |
| GET | `/api/v3/conversations/preload` | `polis conversation preload` |
| GET | `/api/v3/participation` | `polis participant activity` |
| GET | `/api/v3/all_conversations` | `polis ops conversations list` |
| GET | `/api/v3/bid` | `polis participant group` |
| GET | `/api/v3/votes/me` | `polis vote mine` |
| GET | `/api/v3/topicAgenda/selections` | `polis agenda list` |
| GET | `/api/v3/participation/topicPrioritize` | `polis agenda priorities` |
| GET | `/api/v3/treevite/myInvites` | `polis invite mine list` |
| GET | `/api/v3/treevite/me` | `polis participant invitation-status` |
| GET | `/api/v3/treevite/myInvites/csv` | `polis invite mine export` |
| GET | `/api/v3/xid/:xid_report` | `polis participant xid capability-export` |
| GET | `/api/v3/xidAllowList` | `polis participant allowlist view` |
| GET | `/api/v3/xidAllowList/csv` | `polis participant allowlist export` |
| GET | `/api/v3/votes/famous` | `polis vote famous` |
| GET | `/api/v3/einvites` | `polis invite email lookup` |
| GET | `/api/v3/dataExport/results` | `polis report export-results` |
| GET | `/api/v3/delphi` | `polis delphi overview` |
| GET | `/api/v3/delphi/logs` | `polis delphi logs` |
| GET | `/api/v3/topicStats` | `polis report topic-stats` |
| GET | `/feeds/:reportId` | `polis report feed list` |
| GET | `/feeds/:reportId/consensus` | `polis report feed consensus` |
| GET | `/feeds/:reportId/topics` | `polis report feed topics` |
| GET | `/api/v3/ops/whoami` | `polis ops status` |
| GET | `/api/v3/ops/page/:id` | `polis ops page` |
| GET | `/perfStats_9182738127` | `polis ops performance` |
| GET | `/api/v3/snapshot` | Unavailable: Node throws an explicit unimplemented snapshot error. |
| POST | `/api/v3/query_participants_by_metadata` | `polis participant query` |
| GET | `/api/v3/math/correlationMatrix` | `polis math correlation` |
| GET | `/api/v3/dataExport` | `polis report export-start` |
| GET | `/api/v3/notifications/subscribe` | `polis notification subscribe` |
| GET | `/api/v3/notifications/unsubscribe` | `polis notification unsubscribe` |
| GET | `/api/v3/comments/translations` | `polis comment translations` |
| GET | `/api/v3/nextComment` | `polis comment next` |
| GET | `/api/v3/participationInit` | Already covered: `polis join` |
| GET | `/api/v3/reportNarrative` | `polis delphi narrative run` |
| GET | `/api/v3/verify` | `polis account verify` |
| POST | `/api/v3/auth/deregister` | Not an account deletion API: Node only acknowledges client-side JWT logout; auth logout clears the local sign-in. |
| POST | `/api/v3/zinvites/:zid` | Already covered: `polis invite code create` |
| POST | `/api/v3/participants` | Not applicable: unsafe legacy route. Use `polis join` and the first vote or comment. |
| POST | `/api/v3/convSubscriptions` | `polis notification set` |
| POST | `/api/v3/joinWithInvite` | Excluded legacy admission path; modern anonymous/Treevite entry uses join/vote/comment. |
| POST | `/api/v3/domainWhitelist` | `polis account domain replace` |
| POST | `/api/v3/xidAllowList` | `polis participant allowlist import` |
| POST | `/api/v3/comments` | Already covered: `polis comment` |
| POST | `/api/v3/delphi/jobs` | `polis delphi run` |
| POST | `/api/v3/delphi/batchReports` | `polis delphi batch` |
| POST | `/api/v3/topicMod/moderate` | `polis topic moderate` |
| POST | `/api/v3/collectiveStatement` | `polis collective generate` |
| POST | `/api/v3/topicAgenda/selections` | `polis agenda add` |
| PUT | `/api/v3/topicAgenda/selections` | `polis agenda replace` |
| DELETE | `/api/v3/topicAgenda/selections` | `polis agenda remove` |
| POST | `/api/v3/votes` | Already covered: `polis vote` |
| POST | `/api/v3/ptptCommentMod` | `polis comment flag` |
| POST | `/api/v3/upvotes` | `polis conversation upvote` |
| POST | `/api/v3/stars` | `polis comment star` |
| POST | `/api/v3/trashes` | `polis comment trash` |
| POST | `/api/v3/reportCommentSelections` | `polis report comments select` |
| PUT | `/api/v3/users` | `polis account edit` |
| POST | `/api/v3/mathUpdate` | `polis math refresh` |
| PUT | `/api/v3/reports` | `polis report edit` |
| POST | `/api/v3/sendCreatedLinkToEmail` | `polis conversation email-link` |
| PUT | `/api/v3/ptptois` | `polis participant highlight set` |
| POST | `/api/v3/treevite/waves` | Already covered: `polis invite wave create` |
| POST | `/api/v3/treevite/acceptInvite` | Already covered: `polis join --invite` |
| POST | `/api/v3/treevite/login` | Already covered: `polis join --login-code` |
| POST | `/api/v3/einvites` | `polis invite email send` |
| POST | `/api/v3/users/invite` | `polis account invite` |
| POST | `/api/v3/contributors` | `polis support contribute` |

Counts: 65 dedicated operations in this packet, 7 already covered routes, and 5 retired/excluded routes. The dedicated `comment next` command supplements the existing interactive vote loop. A route is not marked implemented merely because generic `api` can reach it.

## Request and output rules

Account operations use the selected profile’s sign-in. Participant operations use only that profile/origin/conversation’s participant credential by default; `--account` explicitly selects the account instead. No participant action silently falls back to an administrator identity. An issued participant token is saved privately and removed from the receipt. Plain anonymous join and voting retain their existing meanings.

Every effectful operation requires `--yes`, including effectful GETs. The site still decides authority. A write receipt reports `response_received`, not completion or a confirmed readback; errors and lost responses must be inspected before retrying. Report edits and report comment selection resolve the conversation from the report, so the CLI never submits independently chosen report/conversation pairs. No automatic retry is made.

Downloads require `--output`, create a private file, and refuse overwrite. HTML/RSS is stored as untrusted bytes, never evaluated or opened. Public feed/performance reads have a separate exact path allowlist, never send credentials or follow redirects, and do not widen the raw API command’s prefix restriction. API responses and files are bounded to 8 MiB; input files to 500,000 bytes, secret files to 4,096 bytes.

Email-verification and signed notification capabilities come from files, not command arguments. Their HTML bodies can contain new signed links, so only an acknowledgment is emitted. Email-invitation lookup also removes the supplied capability from its JSON receipt. Error bodies, correlation headers and invalid argument values are not reflected by these operations. An explicitly requested invitation/code list remains sensitive data; save exports privately.

Wire vote projections are labeled with the existing shared vote contract; no reader guesses a storage sign. Participant feedback flags, conversation upvotes, report inclusion and moderation codes are different operations from semantic votes.

## Current behavior and limitations

- `agenda add` and `agenda replace` each save an entire selection array; neither appends. `agenda remove` deletes the participant’s whole selection record.
- Allowlist import adds to an owner-global list, not a conversation-private replacement.
- Upvote applies to the conversation and can be submitted once by an account.
- Export results requires the complete export filename and saves the returned signed HTTPS URL to `--output`. It does not follow the redirect or verify that the object exists; the receipt and saved JSON explicitly say `artifact_verified: false`.
- Provider/job commands may start paid work when a site enables them; their receipt is not a completed analysis. No provider or worker is started by the CLI itself.
- Topic moderation can partially apply explicit comment IDs before a missing topic store fails.
- Recent-conversation feeds and the global conversation list require Node developer authority; ordinary account ownership does not grant it.
- Operator API access uses the site’s operator gate. The legacy performance route is public today; this client adds no gate or claim that it is private.
- The XID capability export downloads the participant-to-XID map and requires the selected account’s bearer token. Sign in as an owner or moderator. The server must enforce that authority; older servers may still accept possession of the UUID. This CLI requires sign-in even on those servers. A UUID file alone is insufficient for this command. The command never uses a participant token or anonymous fallback.
- Unsafe legacy participant creation and legacy invite joining are unavailable, including through raw `api`. Participant comments never send `is_seed`; seed imports remain separate administrator operations.
- Metadata, subscriptions, account fields, flags, and report labels preserve the existing route contracts. This packet does not repair current permission anomalies.

## Observed server limitations and follow-up proposals

The generated fixture tests current behavior without changing Node policy:

- Comment star can persist its row then fail because the handler expects `result.rows` from a rows-returning helper. Exit 7 is intentional; inspect the resource before retrying. The handler SHOULD consume the actual result shape.
- `as_unsure` is accepted by route middleware, while the current flag handler reads `unsure`; this choice does not persist as intended. The handler SHOULD use the parsed field. Other flags retain their existing behavior.
- The translations GET route does not move query parameters into the parsed body. Its standard GET query is rejected; the route SHOULD use the same query parsing as other GET endpoints. The CLI does not send a nonstandard GET body to hide that defect.
- Contributor agreement submission has no backing table in the repository migrations and returns unavailable. The server SHOULD explicitly retire it or provide its declared storage.
- Signed notification routes can acknowledge zero affected rows. Receipts do not claim a subscription was changed unless separately read back.
- Email writes can persist invitation state before a delivery failure. No automatic retry or delivery claim is made. Provider generation is not verified by queue admission.

## Dedicated operation parameters

Use `polis help <command>` or `polis schema <command>` for parser discovery. The table below states the data types; strings are sent unchanged, and omitted optional fields are omitted. Explicit booleans accept `true` or `false`; comma lists are nonempty and bounded to 1,000 entries; JSON-array files contain arrays, not wrapper objects. Effectful operations also take `--yes`; participant operations also take `--account`; downloads take `--output`.

| Command | Parameters |
|---|---|
| `node doctor` |  |
| `node database` |  |
| `account domain list` |  |
| `account domain replace` | `--domains` text (max 999) required |
| `metadata view` | `--conversation` id required |
| `metadata choices` | `--conversation` id required |
| `conversation started` | `--since` text (max 99) optional |
| `conversation activity` | `--since` text (max 99) optional |
| `conversation preload` | `--conversation` id required |
| `participant activity` | `--conversation` id required; `--strict` bool optional |
| `ops conversations list` | `--limit` uint (max 9999) optional; `--offset` uint (max 99999999) optional; `--sort-by` text (max 50) optional; `--sort-dir` text: asc, desc optional; `--owner-email` text (max 999) optional; `--active` bool optional; `--recently-updated-days` uint (max 36500) optional; `--recently-created-days` uint (max 36500) optional; `--min-comment-count` uint (max 100000000) optional; `--min-participant-count` uint (max 100000000) optional |
| `participant group` | `--conversation` id required |
| `vote mine` | `--conversation` id required |
| `vote famous` | `--conversation` id required |
| `agenda list` | `--conversation` id required |
| `agenda priorities` | `--conversation` id required |
| `invite mine list` | `--conversation` id required |
| `participant invitation-status` | `--conversation` id required |
| `invite mine export` | `--conversation` id required |
| `participant xid capability-export` | `--key-file` uuid_file required |
| `participant allowlist view` | `--conversation` id required; `--limit` uint (max 1000) optional; `--offset` uint optional |
| `participant allowlist export` | `--conversation` id required |
| `participant allowlist import` | `--conversation` id required; `--from` strings_file required |
| `invite email lookup` | `--code-file` secret_file required |
| `report export-results` | `--conversation` id required; `--filename` text (max 1000) required; `--output` private capability destination required |
| `delphi overview` | `--report` id required |
| `delphi logs` | `--job` opaque required |
| `report topic-stats` | `--report` id required |
| `report feed list` | `--report` id required |
| `report feed consensus` | `--report` id required |
| `report feed topics` | `--report` id required |
| `ops status` |  |
| `ops page` | `--page` opaque (max 100) required |
| `ops performance` |  |
| `participant query` | `--conversation` id required; `--answers` uints required |
| `math correlation` | `--report` id required |
| `report export-start` | `--conversation` id required; `--format` text (max 100) optional; `--timestamp` text (max 99) optional |
| `notification subscribe` | `--conversation` id required; `--email` text (max 999) required; `--signature-file` secret_file required |
| `notification unsubscribe` | `--conversation` id required; `--email` text (max 999) required; `--signature-file` secret_file required |
| `notification set` | `--conversation` id required; `--state` mapped: subscribe, unsubscribe required; `--email` text (max 999) required |
| `comment translations` | `--conversation` id required; `--statement` uint optional; `--language` text (max 10) optional |
| `comment next` | `--conversation` id required |
| `delphi narrative run` | `--report` id required |
| `account verify` | `--code-file` secret_file required |
| `delphi run` | `--report` id required; `--type` text: FULL_PIPELINE, CREATE_NARRATIVE_BATCH, AWAITING_NARRATIVE_BATCH optional; `--priority` uint (max 100) optional; `--include-moderation` bool optional; `--idempotency-key` text (max 300) optional |
| `delphi batch` | `--report` id required; `--model` text (max 300) required; `--max-batch-size` uint (max 1000) optional; `--no-cache` bool optional; `--include-moderation` bool optional; `--idempotency-key` text (max 300) optional |
| `topic moderate` | `--conversation` id required; `--action` text: accept, reject, meta required; `--statements` uints optional; `--topic` text (max 1024) optional |
| `collective generate` | `--report` id required; `--topic` text (max 1024) required; `--name` text (max 1000) required; `--statements` uints optional; `--group-consensus` json_file optional |
| `agenda add` | `--conversation` id required; `--from` array_file required |
| `agenda replace` | `--conversation` id required; `--from` array_file required |
| `agenda remove` | `--conversation` id required |
| `comment flag` | `--conversation` id required; `--statement` uint required; `--as-abusive` bool optional; `--as-factual` bool optional; `--as-feeling` bool optional; `--as-important` bool optional; `--as-notfact` bool optional; `--as-notgoodidea` bool optional; `--as-notmyfeeling` bool optional; `--as-offtopic` bool optional; `--as-spam` bool optional; `--as-unsure` bool optional |
| `conversation upvote` | `--conversation` id required |
| `comment star` | `--conversation` id required; `--statement` uint required; `--state` mapped: on, off required |
| `comment trash` | `--conversation` id required; `--statement` uint required; `--state` mapped: on, off required |
| `report comments select` | `--report` id required; `--statement` uint required; `--include` bool required |
| `account edit` | `--email` text (max 999) optional; `--name` text (max 9999) optional |
| `math refresh` | `--conversation` id required; `--type` text: recompute, update required |
| `report edit` | `--report` id required; `--name` text (max 999) optional; `--label-x-neg` text (max 999) optional; `--label-x-pos` text (max 999) optional; `--label-y-neg` text (max 999) optional; `--label-y-pos` text (max 999) optional; `--label-group-0` text (max 999) optional; `--label-group-1` text (max 999) optional; `--label-group-2` text (max 999) optional; `--label-group-3` text (max 999) optional; `--label-group-4` text (max 999) optional; `--label-group-5` text (max 999) optional; `--label-group-6` text (max 999) optional; `--label-group-7` text (max 999) optional; `--label-group-8` text (max 999) optional; `--label-group-9` text (max 999) optional |
| `conversation email-link` | `--conversation` id required |
| `participant highlight set` | `--conversation` id required; `--participant` uint required; `--moderation` int required |
| `invite email send` | `--email` text (max 999) required |
| `account invite` | `--conversation` id required; `--emails` strings required |
| `support contribute` | `--agreement-version` uint (max 999999) required; `--name` text (max 746) required; `--email` text (max 256) required; `--github-id` text (max 256) required; `--company-name` text (max 746) required |
