# POST votes contract coverage

Source pin: `050dd04e7e6d9154e259a8addaa1e2229a768489`. This is a compatibility
catalog and a bounded recording profile, not authority to serve a Rust writer.
The production Node handlers, authentication code, pools and schema are unchanged.
Every valid vote is submitted over HTTP using `semanticToWire`; stored values
are inspected through `storageToSemantic`. Storage agree remains owned by the
convention module. No new vote insert helper or allowlist exception is introduced.

## Response producers

| Branch | Source | Evidence and contract |
| --- | --- | --- |
| Ordinary success | `server/src/routes/votes.ts:250–284`; `server/src/nextComment.ts:100–110,170` | Original bodies plus additional identities; `NextCommentFields::Ordinary` retains counts/randomN and raw bytes and requires a translations array (never absent or null); `ordinary_translations_require_an_array_and_preserve_bytes` covers both rejections and empty/nonempty arrays. See `server/src/nextComment.ts:420,464–508`. |
| Topical success | `server/src/nextComment.ts:353–357,420,464–508` | `topical-next-comment`; `topical_and_translated_selection_preserve_bytes`. Requires zid/tid/txt/translations, without ordinary counts/randomN. |
| Topical fallback | `server/src/nextComment.ts:325–350,366–370,413–417` | Empty agenda and exhausted pool cases; ordinary response shape. Selection failures also fall back; codec covers that same shape. |
| Translations | `server/src/nextComment.ts:464–508` | Stored nonempty translation case and explicit SQL-read failure; raw translation rows retained. A provider timeout is not recorded: the profile disables translation API calls and sealed egress forbids the real provider. The 300 ms response budget (`server/src/nextComment.ts:501`) can return the same empty/available rows; the topical/translated codec test covers those bodies, not provider timing. |
| No next statement | `server/src/routes/votes.ts:253–259` | `no-next-comment`; omit nextComment, never null. No modOptions: fresh result has no shouldMod. |
| Issued auth | `server/src/auth/ensure-participant.ts:667–671`; `server/src/auth/attach-auth-token.ts:45–64` | Fresh success plus fresh vote/star/next errors. Fixed Bearer and 31536000. `middleware_position_controls_auth_delivery` rejects different metadata. |
| Membership refusals | `server/src/auth/ensure-participant.ts:683–698`; `server/app.ts:1277–1287` | XID required/denied and Treevite 403/401 have no auth: injector is later. Codec rejects auth on every pre-injector failJson. |
| Parameter errors | `server/src/utils/parameter.ts:137,180–270,336` | Original invalid fields yield finalhandler 400; assigner exception 400 polis_err_misc is codec-only because normal JSON fields do not make the assigner throw. No auth on either. |
| Parser size | `server/app.ts:342` | `parser-body-too-large`: 413 and exact `Payload Too Large\n`. `pre_handler_transport_and_auth_envelopes`. |
| Parser media type | `server/app.ts:342` installs Connect JSON parsing | `parser-unsupported-charset` and `parser-unsupported-content-encoding`: real charset and Content-Encoding branches each return 415 and exact `Unsupported Media Type\n`, with no vote or participant added. `pre_handler_transport_and_auth_envelopes` and captured-byte roundtrips. |
| HTTPS policy | `server/src/utils/domain.ts:37–62` | 400 and exact `Please use HTTPS when submitting data.`; codec-only because this profile runs DEV_MODE and forwards HTTPS. No production-policy run is claimed. |
| Hybrid authentication | `server/src/auth/hybrid-jwt.ts:80–83,96–240` | Local expired/signature/issuer/audience variants and original invalid format. Optional missing Bearer continues; required-auth missing-token envelope is rejected by codec. |
| OIDC account errors | `server/src/auth/jwt-middleware.ts:104–160` | Mapping SQL failures record general 500 and both 429 branches through the real middleware, using explicit fault messages/codes. `account_envelopes_follow_their_producers` covers all five labels, exact messages and retry_after=1 only on 429. Details permitted only for user_creation_failed/authentication_error, in development mode. Missing-email is recorded with a provider-signed fixture token lacking email. Only the outer extraction catch is codec-only: plain JWT JSON cannot provoke an outer extraction exception. |
| Vote/star/next failure | `server/src/routes/votes.ts:88–94,244–250,288–307` | Original failures plus fresh-token and saved-star/failed-next cases. 500 polis_err_vote; 406 polis_err_vote_duplicate is SQLSTATE injection, not an ordinary revote. |
| Serialization failure | `server/src/server-helpers.ts:216–237` | Codec-only polis_err_finishing_response 500: normal Postgres/JSON rows cannot supply a cyclic value or throwing serializer without replacing response construction. |
| Unreachable catches | `server/src/routes/votes.ts:253,291–302`; `server/src/server-helpers.ts:197,232` | Fresh result has no zid; addConversationId resolves immediately. finishing_responseA and both legacy catches are cataloged in UNREACHABLE_ERRORS and rejected by codec. |

## Identities and side effects

The original six sequences are pid0, participant, locally issued standard,
signed XID, owner and admin. Each contains new/changed/repeated, moderated-out,
missing-comment and closed outcomes. Standard is not OIDC first contact; the
original foreign token is anonymous only. uid2 is the configured administrator.

| Named gap | Additional evidence / remaining boundary | Source |
| --- | --- | --- |
| Distinct moderator and six outcomes | Site-sharing uid100004 with a database-allocated pid, different from owner/admin, all six outcomes. This route has no moderator bypass. | `server/src/utils/common.ts:89–99`; `server/src/routes/votes.ts:215–307` |
| First reply not retained, retry | Two anonymous successes deliberately discard the first credential before retry. This proves identity recreation, not TCP disconnection or unknown commit. | `server/src/auth/ensure-participant.ts:488–516,620–640` |
| Parser-refusal retry | First malformed star creates membership without delivered auth; retry without token creates another identity. | `server/app.ts:1277–1287` |
| Fresh handler-error token | Fresh anonymous insert, star and next failures; failures after injector carry auth. | `server/src/auth/attach-auth-token.ts:45–64` |
| Missing/revoked membership, valid token | Signed pid70 with no membership; separately mint a token for a database-allocated member, delete its row, then submit that still-valid token. Existing nonnegative token pid is trusted without lookup. | `server/src/auth/ensure-participant.ts:257–258` |
| Foreign standard | Retains uid, discards foreign pid, resolves membership and mints current-conversation token. | `server/src/auth/ensure-participant.ts:156–161,442–450` |
| Foreign XID, same/different owner | Both resolve the XID under the target owner; foreign uid/pid are discarded. | `server/src/auth/ensure-participant.ts:144–156`; `server/src/xids.ts:102` getXidRecord |
| Request XID overrides XID token | Conditional on xid_participant: explicit different XID resolves independently and mints a bound token. | `server/src/auth/ensure-participant.ts:452–459` |
| Blank/space/tab XID | Signed token XID restored after trim; anonymous whitespace has no XID. | `server/src/auth/ensure-participant.ts:424–431` |
| Existing signed XID removed from allowlist | 403 without auth, before membership lookup. | `server/src/auth/ensure-participant.ts:179–204,465` |
| Bare existing XID | Existing target-owner record and membership reused. | `server/src/auth/ensure-participant.ts:488–498` |
| Treevite existing-member lookup | No-pid standard, foreign standard and foreign XID; original case already carried pid and did not prove lookup. | `server/src/auth/ensure-participant.ts:542–549` |
| Treevite pid0 | Existing pid0 is accepted. | `server/src/auth/ensure-participant.ts:519,552` |
| Treevite new XID/standard/OIDC | All three nonmembers refused; newly created identities may remain without membership. | `server/src/auth/ensure-participant.ts:527–556` |
| Treevite owner without participation | Owner's first join in an empty conversation is allowed. | `server/src/auth/ensure-participant.ts:534–560` |
| Fresh privileged join | Owner above and fresh admin join; admin does not gain a Treevite bypass. | `server/src/auth/ensure-participant.ts:534–556,567–577` |
| Ordinary OIDC first account | Simulator-issued ordinary user maps account and joins, distinct from the locally signed standard token. | `server/src/auth/hybrid-jwt.ts:177–199`; `server/src/auth/create-user.ts:53–123` |
| Local expired/invalid/issuer/audience | Each of anonymous, standard and XID; actual hybrid response recorded. | `server/src/auth/jwt-utils.ts:225–244`; `server/src/auth/hybrid-jwt.ts:237–240` |
| OIDC expiry/invalid claims/JWKS rotation, expiry, failure | Provider-signed expired, wrong issuer/audience, bad signature and unpublished-key cases are recorded. Tokens use the isolated simulator’s own signing implementation, with no key copied to artifacts. The unpublished key triggers a real JWKS lookup and validation refusal. Key rotation, cache expiry and network timeout remain unrecorded: the provider has one fixed key, and the profile does not alter the validator cache clock or block provider traffic. The codec covers the resulting 401 envelope; this is not cache/availability qualification. | `server/src/auth/jwt-middleware.ts:36–61`; `server/src/auth/hybrid-jwt.ts:177–199,237–240` |
| Ignored pid/weight | Caller fields do not change pid or stored history weight. | `server/app.ts:1272–1288`; `server/src/routes/votes.ts:219–232` |
| Backdated replacement and existing weight | Future latest.modified is replaced by the new vote timestamp; nonzero latest weight remains 7. No vote value is directly changed by setup. | `server/postgres/migrations/000006_update_votes_rule.sql:8–13` |
| Star then next failure | One committed star and vote despite 500. | `server/src/routes/votes.ts:244–250` |
| Deferred operation failures | Opt-in P027_VOTES_DEFERRED_FAILURE fault cases exercise each of the three promises; failures are retained as failing oracles, never rewritten as successes. Normal corpus does not inject them. No contract response can promise that deferred work succeeded. | `server/src/routes/votes.ts:237–242`; `server/src/server-helpers.ts:425–451` |
| Actual response disconnect / unknown commit | Not recorded: runCase requires a completed response and compares drained effects. No codec can classify an absent response; there is no retry permission in this contract. | `server/src/routes/votes.ts:229–250` |

The contract tests validate response shapes only for the source-only branches;
they do not simulate identity resolution or prove those branches executed.
The JWKS fetch remains a synchronous external dependency before voting. Reading
this contract adds no pool, lock, migration or slow work to participation. These
recordings do not waive participation load guards or prove resource isolation.
