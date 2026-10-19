# Conversation setup and current admission behavior

The CLI models the existing Node API. Permissions that are not enforced are not offered as working restrictions. This is a behavior inventory, not a guarantee that current permissions are desirable. All source citations below are relative to `server/src/` unless they name `server/app.ts`.

## Complete create/update parameter inventory

All **33 distinct named parameters** parsed by POST and PUT `/api/v3/conversations` are accounted for. Stored appearance fields are legacy client settings, not server permissions. Operational parameters are distinguished from persisted settings. `owner`, `org_id` and `is_public` are set by the handler, not accepted create/update options. Report creation and site-domain policy are separate endpoints.

| Parameter | Category / values | Parsed at server/app.ts | Current effect / enforcement | Setup exposure | SHOULD proposal |
|---|---|---|---|---|---|
| `is_active` | Participation; Open / closed | POST:1695, PUT:1417 | Both writes check after identity creation. votes.ts:127; comments.ts:483. Reads and invite acceptance continue. | activity | Allow independent vote/comment controls and decide if closed permits enrollment. |
| `is_draft` | Listing; Listed / draft | POST:1696, PUT:1419 | Conversation listing filters is_draft in routes/conversations.ts:129; no participant admission effect. | listing | Make draft semantics explicit; do not present it as privacy. |
| `is_anon` | Visibility; Normal / hide social list | POST:1697, PUT:1418 | server-helpers.ts:360 suppresses famous social list; does not make identities or content private. | visibility | Rename the control to its actual scope. |
| `owner_sees_participation_stats` | Legacy; Boolean | POST:1698, PUT:1421 | Stored by routes/conversations.ts:919; no participant enforcement. | excluded | Specify and enforce the intended statistics access policy. |
| `profanity_filter` | Moderation; Boolean | POST:1699, PUT:1422 | routes/comments.ts:371 filters profanity only inside the pro-conversation moderation branch (:496). Non-pro conversations are unaffected. | profanity_filter | Independent, predictable profanity filtering without a synchronous external model dependency. |
| `short_url` | Identifier; Boolean | POST:1700, PUT:1423 | routes/conversations.ts:1169 invokes generateAndRegisterZinvite; PUT :954 can replace the code. | short_url (creation only) | Code replacement must be explicit; setup never rotates a code on PUT. |
| `spam_filter` | Legacy; Boolean | POST:1701, PUT:1424 | Stored by routes/conversations.ts:864; no consumer enforces spam filtering. | excluded | Either implement a documented filter or retire the flag. |
| `strict_moderation` | Moderation; After submission / before visibility | POST:1702, PUT:1425 | comment.ts:381 only serves approved comments when strict. routes/comments.ts:431-439 approves owner and moderator statements on arrival and honours the seed flag only from them; from anyone else it is ignored. | moderation | Keep participant seed bypass unavailable. |
| `context` | Discovery; String, at most 999 UTF-16 units | POST:1703, PUT:1442 | POST stores context at routes/conversations.ts:1133; GET listing filters it at :108. PUT parses but never copies it. | context (creation only) | Make update behavior explicit or implement it. |
| `topic` | Content; String, at most 1000 UTF-16 units | POST:1704, PUT:1426 | Stored by routes/conversations.ts:1123 / :870 and returned in conversation reads. | topic | Keep one shared length rule across clients. |
| `description` | Content; String, at most 50000 UTF-16 units | POST:1705, PUT:1427 | Stored by routes/conversations.ts:1124 / :873 and returned in conversation reads. | description | Keep one shared length rule across clients. |
| `conversation_id` | Identifier; POST string 6–300; PUT identifies existing conversation | POST:1706, PUT:1416 | routes/conversations.ts:1163 checks an existing code after insert; unknown custom code rejects and known code returns null. No custom-code registration. | excluded on create; returned ID used for later steps | Make custom IDs a validated atomic operation; current failure can leave a conversation. |
| `is_data_open` | Data visibility; Owner / public | POST:1707, PUT:1420 | routes/participantsOfInterest.ts:127 permits the data read when true. This does not gate ordinary comments/votes reads. | data_access | Name precisely which dataset is opened; define a complete report/content access policy. |
| `ownerXid` | Ignored; String 1–999 | POST:1708 | Parsed on POST app.ts:1708; not used by the create handler. | excluded | Remove the misleading parameter or implement it. |
| `treevite_enabled` | Admission; Invitation membership required / optional | POST:1709, PUT:1445 | auth/ensure-participant.ts:499–537 refuses missing memberships except owner. Existing members pass. Invite routes ignore the switch. | join.invitations | Admin should choose invite-only versus invites plus anonymous explicitly, including existing memberships. |
| `topics_enabled` | Legacy; Boolean | POST:1710, PUT:1446 | Stored by routes/conversations.ts:915/:1143; no Node participation consumer. | excluded | Connect it to defined topic behavior before presenting a promise. |
| `importance_enabled` | Ignored; Boolean | PUT:1428 | Stored/echoed via routes/conversations.ts:909 and conversation.ts:113. No client and no export reads it: the "important" checkbox is always shown and the export always carries importance. | excluded | Drop the column in a later migration. |
| `vis_type` | Legacy client presentation; Integer | PUT:1429 | Stored/echoed at routes/conversations.ts:876 and conversation.ts:111. No server permission enforcement. | excluded | Define supported display variants separately from access. |
| `help_type` | Legacy client presentation; Integer | PUT:1430 | Stored/echoed at routes/conversations.ts:879 and conversation.ts:114. | excluded | Version client presentation controls. |
| `write_type` | Legacy client presentation; Integer | PUT:1431 | Stored at routes/conversations.ts:906, echoed by conversation.ts:112; POST comments ignores it. | excluded | Admin should be able to disable new statements with server enforcement. |
| `bgcolor` | Legacy client presentation; String ≤20; default clears to NULL | PUT:1432 | routes/conversations.ts:881–887 stores; conversation.ts:115 echoes. | excluded | Version display styling separately from permissions. |
| `help_color` | Legacy client presentation; String ≤20; default clears to NULL | PUT:1433 | routes/conversations.ts:888–894 stores; conversation.ts:116 echoes. | excluded | Version display styling separately from permissions. |
| `help_bgcolor` | Legacy client presentation; String ≤20; default clears to NULL | PUT:1434 | routes/conversations.ts:895–901 stores; conversation.ts:117 echoes. | excluded | Version display styling separately from permissions. |
| `style_btn` | Legacy client presentation; String ≤500 | PUT:1435 | routes/conversations.ts:902–904 stores; conversation.ts:118 echoes. | excluded | Version display styling separately from permissions. |
| `auth_needed_to_vote` | Ignored; Boolean | PUT:1436 | PUT parses but never copies; preload hard-codes false at conversation.ts:119. | excluded | Admin should be able to require sign-in, enforced on the vote route. |
| `auth_needed_to_write` | Ignored; Boolean | PUT:1437 | PUT parses but never copies; preload hard-codes false at conversation.ts:120. | excluded | Admin should be able to require sign-in, enforced on the comment route. |
| `auth_opt_allow_3rdparty` | Legacy; Boolean | PUT:1438 | Stored at routes/conversations.ts:917; echoed by conversation.ts:100; no enforcement. | excluded | Define which identity providers are admitted and enforce consistently. |
| `verifyMeta` | Operation; Boolean | PUT:1439 | routes/conversations.ts:838 checks metadata answers before updating. A new conversation has no metadata questions. | not applicable to new setup | Make prerequisite validation an explicit operation; metadata currently does not gate direct participation. |
| `send_created_email` | Operation; Boolean | PUT:1441 | routes/conversations.ts:960 sends an owner notification after update. Not a persisted setting. | excluded from automated setup | Provide an explicit notify action rather than hiding an email in settings updates. |
| `link_url` | Legacy client presentation; String 1–9999 | PUT:1443 | Stored routes/conversations.ts:924; echoed conversation.ts:109, no server access enforcement. | excluded | Version display/link behavior separately. |
| `subscribe_type` | Legacy client presentation; Integer | PUT:1444 | Stored routes/conversations.ts:927; no participant route enforces subscriptions. | excluded | Define subscription consent behavior before enabling a client promise. |
| `use_xid_whitelist` | Admission; Allowlisted external ID | PUT:1447 | auth/ensure-participant.ts:182-200 checks every request whose external ID is its identity, on join, vote and comment, before identity is resolved; known identities are rechecked. | join.external_identity.allowlist | Decide whether lists are per owner or per conversation, and whether removal from the list ends existing participation. |
| `xid_required` | Admission; Optional / required external ID | PUT:1448 | auth/ensure-participant.ts:220 checks only new identities. Existing members and OIDC users bypass it. | join.external_identity | State whether sign-in is an alternative or an additional requirement and enforce that choice. |

## Entry paths and overlapping policies

The initial model has independent external-identity and invitation policies. Optional invitations can have zero or more waves; required invitations carry an initial wave. XID policy is optional, required, or allowlisted. All six overlaps are expressible. An allowlist canonically emits both `xid_required` and `use_xid_whitelist`; Node gives the whitelist branch precedence, so the redundant xid_required=false representation belongs to the same behavioral class.

Activity is independent of draft listing: draft does not prevent voting. The only currently enforced participation-rights switch is open/closed, applying to both votes and comments. Strict moderation affects visibility, not admission. No fake sign-in or comment-disable switch is offered.

The live table crosses 25 entry paths × 8 raw flag combinations (6 canonical admission classes) × 2 activity states × 2 moderation states × 3 actions = 2,400 cells. Every vote and comment case uses a fresh conversation and identity setup, so a preceding successful action cannot accidentally turn a new visitor into an existing member. The vote action does not call join first. XID and authenticated token combinations are exercised directly against Node; the simple participant CLI commands currently expose anonymous and invitation identities.

Entry paths: fresh anonymous; same-conversation anonymous member; another-conversation anonymous token; new allowed XID; new denied XID; known XID member; known owner-scoped XID nonmember; same-conversation XID token; another-conversation same-owner XID token; another-owner XID token; fresh signed-in user; existing signed-in member; owner; site moderator without membership; new invite acceptance; returning invite login; matching legacy pc cookie; missing legacy cookie. Combined paths also test anonymous member + XID, cross-conversation anonymous + XID, signed-in + XID, legacy cookie + XID, same-conversation XID token + changed XID, cross-owner XID token + known target XID, and same-owner cross-conversation XID token + unknown XID. These exercise both overwrite and re-resolution branches. The legacy joinWithInvite route is not used. Standard-user participant JWTs are not issued by the current OIDC API (auth/ensure-participant.ts:326–330 and jwt-middleware.ts:85); that dormant directly-minted token path is documented separately from reachable sign-in.

The table records predicted and actual HTTP status plus refusal code, and checks stored vote meaning/participant linkage and comment attribution/visibility. Invite join means acceptInvite, returning join means login; all other joins mean participationInit. Optional anonymous join is readiness only; first requested vote/comment creates membership. Invitation acceptance works even with treevite disabled; that enables invites plus anonymous participation.

Other settings are collapsed only where their consumers are independent of admission: content/identifier/listing metadata, social-list/data-read visibility, display-only fields, and pro profanity filtering. Profanity filtering is conditional on external pro moderation; the isolated admission fixture has no pro provider and does not claim live proof of that provider. Strict/active and both XID gates are never collapsed away. Metadata and domain rules use separate endpoints; domain applies only to participationInit, not vote/comment.

## SHOULD proposals by entry path

- Fresh anonymous: optional readiness should describe the gate honestly; decide whether explicit join should immediately enroll. Refused requests should not leave unnecessary identities.
- Existing anonymous, known XID, and signed-in members: decide which current policy changes should be rechecked for existing membership.
- New and known XIDs: enforce the intended per-conversation list consistently; require proof of external identity rather than treating a public string as authentication.
- Cross-conversation/owner tokens: reject invalid scopes explicitly rather than silently changing identity class.
- Signed-in users and owner/moderators: define whether sign-in substitutes for XID; make bypass authority consistent across invite administration and participation.
- Invite acceptance and returning login: define how closed conversations and disabled invitation policy affect outstanding codes; preserve private recovery credentials.
- Legacy cookies: explicitly retire or migrate their identity binding, including combinations with XID.
- All paths: implement sign-in and statement-submission controls on the server before exposing them as enforceable wizard choices; keep comments pending under strict moderation unless an authorized moderator approves.

A mismatch between model and live behavior remains evidence to investigate. Policy proposals do not block the current-behavior setup flow.


## Live result

Re-run after the external-ID identity and seed-authority changes: the previous
model predicted that known identities bypass the allow-list and that a changed
external ID kept its participant, and 472 of 2,400 cells no longer matched. With
the allow-list checked on every action and a changed or unknown external ID
treated as a new identity, all 2,400 cells match again.
`scripts/test-setup-admission.sh` runs the table and fails on any mismatch; CI
runs it with the CLI comparison.

The 2,400-cell generated-data Node table matched every model prediction (HTTP
status and refusal code), including 25 entry paths and the redundant raw
allowlist flag form. Successful votes were decoded through Node's storage
convention and linked to their participant. Successful comments were checked
for participant attribution and strict/non-strict visibility. Both moderator
bypass and ordinary pending comments were exercised. This is functional
behavior proof, not a production load test or a guarantee about external pro
moderation providers.

The reproducible prediction generator is `setup_predictions` in
`polis-contracts/examples`. The observer is
`server/characterization/setup-admission.cjs`, run against the sealed local
characterization stack with an empty developer-admin allowlist and generated
OIDC accounts. It writes `setup-admission-results.json` and `.jsonl` to the
stack's artifact directory; no token, code, external identity, text or database
identifier is recorded. Each row carries its predicted and observed result and a SHOULD proposal for that entry path.

## Setup flow

`polis conversation new` asks plain questions using the contract's choices,
shows a summary, and requires `yes` before creating anything. `--save FILE`
writes that same typed setup with mode 0600 and refuses an existing destination.
`--from FILE` applies the typed file without a prompt; `--dry-run` validates and
explains the ordered steps with no HTTP requests. Files are bounded to 2 MB.
The model bounds a setup to 100 waves, 1000 invitations per wave count, 1000
external IDs, and 1000 initial statements; these are client operation limits. Derived wave sizes must also fit Node's integer column before any request is made.

Apply creates a closed conversation with its invitation gate on, reads it back,
applies settings while staged, creates each invitation wave, adds the external-ID
allowlist if requested, and submits each initial statement through the moderator
bulk endpoint. Each step is read back, including the stored invitation count for each wave. Initial statements receive moderator
approval without sending `is_seed` or an author vote. Finally it applies and
reads back the requested activity and invitation settings. Staging protects the
modern participation path from accidental early enrollment; it does not repair
legacy admission bypasses in the server.

A partial failure exits 7 and returns the public conversation ID if known,
each completed or response-received step, and the step that failed. It never
retries or automatically deletes the partly created conversation. A malformed
creation response can leave an unknown conversation. Inspect before retrying:
rerunning `new` creates another conversation. The last confirmation can fail
after final settings were already applied, so a failed setup does not always
mean the conversation is still staged.

Invite codes are not printed by setup. Use the existing authorized invite
export to distribute them. The allowlist write adds entries; it never replaces
owner-global entries that could affect other conversations. Its receipt reports
additional visible entries, and current Node membership/XID bypasses remain
explicit in the truth table. Existing participant CLI commands use anonymous or
invitation identities; the table also covers Node's XID and signed-in inputs.
