# Supported legacy schema contract

This release accepts the documented legacy schema without changing its data or
rewriting old migrations. The live schema is authoritative for the named legacy
variant; the existing bootstrap is a separately supported installation variant.
The immutable numbered files are execution history, not a claim that every
installation ran every file. Adoption predicates describe the supported states.

The concrete admission changes are bounded: `worker_tasks.task_type` accepts
`text` or `varchar(99)`; renamed `pwreset_tokens.token` accepts `varchar(100)`
or `varchar(250)`; absent `conversations.branding_type` and
`math_ticks.caching_tick` are valid, but existing columns must have their known
integer/bigint types. Contributor agreement tables are outside this release's
adoption scope. M2 requires enforced owner/xid uniqueness and preserves an
optional enforced, nonpartial owner/uid unique index in either key order.
Other lengths, arbitrary text alternatives, invalid indexes and partial unique
owner/uid indexes remain refused.

Six math payloads accept `json` alongside bootstrap `jsonb`: `math_bidtopid`,
`math_cache`, `math_exportstatus`, `math_main`, `math_profile`, `math_ptptstats`.
`math_report_correlationmatrix.data` remains `jsonb`; no observed legacy JSON
contract was established for it. This narrows an earlier broad helper.

The file contract below records the rest of the reviewed live differences.
It does not add new global core-default, routine-body or ACL adoption checks.
These documentary contracts must not be mistaken for an exhaustive schema
certifier. Existing modern M3/M8–18 predicates continue to enforce the properties
introduced by those migrations; unsupported/partial schemas stop for review.

## Named live attributes

| Attribute | Legacy contract | Bootstrap alternative |
| --- | --- | --- |
| comments.uid | integer NOT NULL, default 0 | no default |
| comments.velocity | nullable real, default 1 | NOT NULL real |
| conversations.auth_needed_to_vote | default false | no default |
| conversations.auth_needed_to_write | default true | no default |
| conversations.auth_opt_fb | default true | no default |
| conversations.auth_opt_tw | default true | no default |
| conversations.auth_opt_allow_3rdparty | default true | no default |
| contexts/context_id, conversations/zid, courses/course_id, participant_metadata_answers/pmaid, participant_metadata_questions/pmqid, users/uid sequences | bigint sequence, maximum 9223372036854775807, integer owning column | integer sequence, maximum 2147483647 |

Sequence configuration is not current sequence state. Never reset, narrow or
advance a live sequence to match bootstrap. Reviewed implementations of
`get_times_for_most_recent_visible_comments()`, `pid_auto()`, `tid_auto()`,
`random_string(integer)` and `random_polis_site_id()` are executable equivalents
of the public historical sources; formatting fingerprints differ. This release
never replaces those routines. Their exact historical source bindings are in
the deployment's private reconciliation record.

Optional probe provisioning grants SELECT on comments, conversations, math_main,
math_ticks, participants and votes, plus public schema USAGE, to the configured
read-only probe role. It is separate from application and migration authority;
no role identity or grant is imposed on other deployments by this contract.
M19's actual migration session needs role creation/SET authority, public schema
USAGE/CREATE grant authority, conversations SELECT plus topic UPDATE and zid
REFERENCES grant authority. M23/M24 continue as the queue owner. Verify the
actual session; a superuser-only test is insufficient evidence for that session.

## Other live attributes and scope

| Attribute | Type | Nullability |
| --- | --- | --- |
| comments.curation | smallint | NOT NULL |
| participants_extended.encrypted_ip_address | character varying(9999) | nullable |
| participants_extended.encrypted_x_forwarded_for | character varying(9999) | nullable |
| suzinvites.modified | bigint | nullable |
| suzinvites.uid | integer | nullable |
| users.pwhash | character varying(128) | nullable |

Existing `suzinvites.uid` references users.uid; no field/constraint is added,
dropped or backfilled during reconciliation. Legacy callers and generated
schema descriptions may observe these fields; fresh bootstrap does not acquire
them merely because the legacy contract documents them. Whole-tree generated
schema modernization is a separate change.

The following complete research-triage list records the stable scope. These are
research dispositions, not claims that bootstrap or generated ORM declarations
were rewritten in this patch. The explicit adoption changes and separate legacy
file contract described above are implemented here; references below to canonical
files/ORM or generated-reader changes remain broader modernization obligations.
“Before
stable” means a file/adoption contract, never authorization for production DDL.
Ancillary objects are retained. No extension removal, name rewrite, course-invite
unique constraint addition, contributor rename or data cleanup is selected.

| Difference | Scope | Contract disposition |
| --- | --- | --- |
| contributor | SET ASIDE | Defer ancillary file spelling repair for stable; preserve live correct table and working endpoint, scoped non-gating exclusion and graceful503 for absent schemas. No production operation. |
| branding | SYNC BEFORE STABLE | Canonical files omit branding_type to match production; reconcile required generated mappings, preserve exact downstream variants without DROP. |
| caching | SYNC BEFORE STABLE | Canonical files/ORM omit math_ticks.caching_tick to match production; preserve math_main active cursor and existing downstream variants. |
| course | SET ASIDE | Record production absence of invite uniqueness; set aside for narrow stable because M0 adoption does not test it. Later complete canonical files omit the invariant; no production constraint changes. |
| xids | SYNC BEFORE STABLE | Canonical files/adoption preserve both production XID unique invariants; revise prior M2 guard, no drop-owner/uid action. |
| worker_tasks.task_type text versus varchar(99) | SYNC BEFORE STABLE | Actual adoption refusal: align exact production type and preserve reviewed downstream variants. |
| pwreset_tokens.token varchar(100) versus varchar(250) | SYNC BEFORE STABLE | Actual adoption refusal: align exact production type and preserve reviewed downstream variants. |
| math_bidtopid.data json versus jsonb | SYNC BEFORE STABLE | Named JSON exception already admits this type. Record production JSON and supported JSONB variant; no conversion. |
| math_cache.data json versus jsonb | SYNC BEFORE STABLE | Named JSON exception already admits this type. Record production JSON and supported JSONB variant; no conversion. |
| math_exportstatus.data json versus jsonb | SYNC BEFORE STABLE | Named JSON exception already admits this type. Record production JSON and supported JSONB variant; no conversion. |
| math_main.data json versus jsonb | SYNC BEFORE STABLE | Named JSON exception already admits this type. Record production JSON and supported JSONB variant; no conversion. |
| math_profile.data json versus jsonb | SYNC BEFORE STABLE | Named JSON exception already admits this type. Record production JSON and supported JSONB variant; no conversion. |
| math_ptptstats.data json versus jsonb | SYNC BEFORE STABLE | Named JSON exception already admits this type. Record production JSON and supported JSONB variant; no conversion. |
| comments.uid default zero versus absent | SYNC BEFORE STABLE | Record exact live default/nullability in the file contract and reconcile affected generated readers. Existing M0 does not reject it. Defer behavior changes, backfill, or production DDL. |
| comments.velocity nullable versus NOT NULL | SYNC BEFORE STABLE | Record exact live default/nullability in the file contract and reconcile affected generated readers. Existing M0 does not reject it. Defer behavior changes, backfill, or production DDL. |
| conversations.auth_needed_to_vote default literal versus absent | SYNC BEFORE STABLE | Record exact live default/nullability in the file contract and reconcile affected generated readers. Existing M0 does not reject it. Defer behavior changes, backfill, or production DDL. |
| conversations.auth_needed_to_write default literal versus absent | SYNC BEFORE STABLE | Record exact live default/nullability in the file contract and reconcile affected generated readers. Existing M0 does not reject it. Defer behavior changes, backfill, or production DDL. |
| conversations.auth_opt_fb default literal versus absent | SYNC BEFORE STABLE | Record exact live default/nullability in the file contract and reconcile affected generated readers. Existing M0 does not reject it. Defer behavior changes, backfill, or production DDL. |
| conversations.auth_opt_tw default literal versus absent | SYNC BEFORE STABLE | Record exact live default/nullability in the file contract and reconcile affected generated readers. Existing M0 does not reject it. Defer behavior changes, backfill, or production DDL. |
| conversations.auth_opt_allow_3rdparty default literal versus absent | SYNC BEFORE STABLE | Record exact live default/nullability in the file contract and reconcile affected generated readers. Existing M0 does not reject it. Defer behavior changes, backfill, or production DDL. |
| contexts_context_id_seq | SYNC BEFORE STABLE | Record exact bigint sequence with integer owning column; preserve current state and consumers, no setval/ALTER. Existing adoption does not check its bounds. |
| conversations_zid_seq | SYNC BEFORE STABLE | Record exact bigint sequence with integer owning column; preserve current state and consumers, no setval/ALTER. Existing adoption does not check its bounds. |
| courses_course_id_seq | SYNC BEFORE STABLE | Record exact bigint sequence with integer owning column; preserve current state and consumers, no setval/ALTER. Existing adoption does not check its bounds. |
| participant_metadata_answers_pmaid_seq | SYNC BEFORE STABLE | Record exact bigint sequence with integer owning column; preserve current state and consumers, no setval/ALTER. Existing adoption does not check its bounds. |
| participant_metadata_questions_pmqid_seq | SYNC BEFORE STABLE | Record exact bigint sequence with integer owning column; preserve current state and consumers, no setval/ALTER. Existing adoption does not check its bounds. |
| users_uid_seq | SYNC BEFORE STABLE | Record exact bigint sequence with integer owning column; preserve current state and consumers, no setval/ALTER. Existing adoption does not check its bounds. |
| random_polis_site_id(integer) | SET ASIDE | Retain unused integer overload as ancillary legacy state; no current direct caller established. |
| get_times_for_most_recent_visible_comments() | SYNC BEFORE STABLE | Record reviewed production routine body/fingerprint for live trigger/caller contract. Executable equivalence established; no CREATE OR REPLACE and no existing body-hash adoption refusal. |
| pid_auto() | SYNC BEFORE STABLE | Record reviewed production routine body/fingerprint for live trigger/caller contract. Executable equivalence established; no CREATE OR REPLACE and no existing body-hash adoption refusal. |
| tid_auto() | SYNC BEFORE STABLE | Record reviewed production routine body/fingerprint for live trigger/caller contract. Executable equivalence established; no CREATE OR REPLACE and no existing body-hash adoption refusal. |
| random_string(integer) | SYNC BEFORE STABLE | Record reviewed production routine body/fingerprint for live trigger/caller contract. Executable equivalence established; no CREATE OR REPLACE and no existing body-hash adoption refusal. |
| random_polis_site_id() | SYNC BEFORE STABLE | Record reviewed production routine body/fingerprint for live trigger/caller contract. Executable equivalence established; no CREATE OR REPLACE and no existing body-hash adoption refusal. |
| comments | SYNC BEFORE STABLE | Bind existing optional probe provisioning contract; exact six SELECT/public-USAGE grants already have a source. No role/grant changes. |
| conversations | SYNC BEFORE STABLE | Bind existing optional probe provisioning contract; exact six SELECT/public-USAGE grants already have a source. No role/grant changes. |
| math_main | SYNC BEFORE STABLE | Bind existing optional probe provisioning contract; exact six SELECT/public-USAGE grants already have a source. No role/grant changes. |
| math_ticks | SYNC BEFORE STABLE | Bind existing optional probe provisioning contract; exact six SELECT/public-USAGE grants already have a source. No role/grant changes. |
| participants | SYNC BEFORE STABLE | Bind existing optional probe provisioning contract; exact six SELECT/public-USAGE grants already have a source. No role/grant changes. |
| votes | SYNC BEFORE STABLE | Bind existing optional probe provisioning contract; exact six SELECT/public-USAGE grants already have a source. No role/grant changes. |
| public | SYNC BEFORE STABLE | Bind existing optional probe provisioning contract; exact six SELECT/public-USAGE grants already have a source. No role/grant changes. |
| portable ownership and selected-release privileges | SYNC BEFORE STABLE | Use role parameters/capabilities, not hosted dbUser ownership in public bootstrap. Prove actual migration-session M19 grants/role authority and M23/M24 SET ROLE; reject partial conflicting installs. No role reassignment. |
| comments.curation | SYNC BEFORE STABLE | Record exact live/script-visible field in supported legacy file contract; reconcile generated declarations without changing live values. delphi/scripts/generate_cold_start_clojure.py:293–296 explicitly copies curation; client test hits are unrelated prose/UI. Fresh installs currently lack the script field. |
| conversations.dataset_explanation | SET ASIDE | No literal field reference at any scanned current pin; conversation-wide SELECT * and dynamic JSON remain indirect possibilities. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| conversations.is_curated | SET ASIDE | No literal field reference at the scanned current pins; generic conversation readers can expose it. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| conversations.need_suzinvite | SET ASIDE | No literal field reference at the scanned current pins; do not confuse auth handlers for suzinvites with this dormant flag. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| participants_extended.country_iso_code | SET ASIDE | No literal field reference in the scanned current pins. M7 removes country_code_iso (different spelling), NOT this field. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| participants_extended.encrypted_ip_address | SYNC BEFORE STABLE | Record exact live/script-visible field in supported legacy file contract; reconcile generated declarations without changing live values. server/src/participant.ts:291–300 and db/sql.ts:96–103 conditionally write/declare this field only for applicationName PolisWebServer. |
| participants_extended.encrypted_x_forwarded_for | SYNC BEFORE STABLE | Record exact live/script-visible field in supported legacy file contract; reconcile generated declarations without changing live values. server/src/participant.ts:291–300 and db/sql.ts:96–103 conditionally write/declare this field only for applicationName PolisWebServer. |
| suzinvites.modified | SYNC BEFORE STABLE | Record exact live/script-visible field in supported legacy file contract; reconcile generated declarations without changing live values. server/src/invites/suzinvites.ts:17,68 uses SELECT *; INSERTs at 40 and 167 omit modified. Whole-row consumers can observe it; bare modified inventory includes unrelated tables. |
| suzinvites.uid | SYNC BEFORE STABLE | Record exact live/script-visible field in supported legacy file contract; reconcile generated declarations without changing live values. server/src/invites/suzinvites.ts:17,68 SELECT *; normal INSERTs omit uid. Bare uid matches are broad; table-specific paths are the relevant indirect contract. |
| users.pwhash | SYNC BEFORE STABLE | Record exact live/script-visible field in supported legacy file contract; reconcile generated declarations without changing live values. bin/anonymize_users.sh: updates pwhash; generated Rust users row/catalog retains pwhash; M0 comments it out. No current password-login consumer established. |
| users.test | SET ASIDE | Bare test appears throughout test tooling and is not a users.test consumer; generic users SELECT * can expose it. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| conversation_invite_codes | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.conversation_invite_codes usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| conversation_subscriptions | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.conversation_subscriptions usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| error_reports | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.error_reports usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| math_results_dev01 | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.math_results_dev01 usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| minvites | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.minvites usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| moderators | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.moderators usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| nyt_users | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.nyt_users usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| polismath_mod_claims | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.polismath_mod_claims usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| queue | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.queue usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| slack_participants_waiting_for_comments | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.slack_participants_waiting_for_comments usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| slack_state_heap | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.slack_state_heap usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| slack_state_stack | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.slack_state_stack usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| slack_team_tokens | SET ASIDE | No current literal SQL consumer established; whole-tree locations/zero-results and historical SQL pickaxe are retained. Generic queue/moderators hits are not proof of public.slack_team_tokens usage. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| animals_id_auto | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| oid_auto | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| oid_auto_unlock | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| ptpt_id_auto | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| ptpt_id_auto_unlock | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| to_zinvite.integer | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| votes_foo.integer | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| votes_lastest_unique.integer | SET ASIDE | No current literal routine call established; votes_lastest_unique appears only as a bootstrap comment. All SQL snapshot bodies are available historically; current production body fingerprints are compared below. Dynamic/external SQL and trigger dependencies need the aggregate census. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| foobar | SET ASIDE | The four literal foobar hits are unrelated Clojure visualization/Rust child fixtures; no sequence user established. Historical dump contains it. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| animal_grp | SET ASIDE | No current literal consumer in tracked trees; historical animals_id_auto body references NEW.grp/enum_range. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| auth_tokens.auth_tokens_token_idx | SET ASIDE | Index planner use is implicit through auth_tokens queries; table-name inventory lists indirect consumers. No application can be declared independent solely because it does not name the index. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| participants.participants_uid_index | SET ASIDE | Index planner use is implicit through participants queries; table-name inventory lists indirect consumers. No application can be declared independent solely because it does not name the index. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| pwreset_tokens.pwreset_tokens_token_idx | SET ASIDE | Index planner use is implicit through pwreset_tokens queries; table-name inventory lists indirect consumers. No application can be declared independent solely because it does not name the index. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| votes.votes_zid_idx | SET ASIDE | Index planner use is implicit through votes queries; table-name inventory lists indirect consumers. No application can be declared independent solely because it does not name the index. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| postgis | SET ASIDE | server/Dockerfile-pdb:1 retains postgis image; bin/remove_postgis.sh is a destructive cleanup helper, NOT permission to run it. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| tablefunc | SET ASIDE | No literal current tree consumer; historical dump declares CREATE EXTENSION tablefunc. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| pg_stat_statements | SET ASIDE | server/src/ops/database.ts:4 explicitly says pg_stat_statements is NOT used (ruling R5: extension creation is a database change); the two unit-test hits do not establish a runtime consumer. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| unattributed_extension_members | SET ASIDE | Exact extension ownership remains unproven: 794 routine and 109 parent-object count mappings ready. Retain all candidates. No selected migration alters these objects; classification and any cleanup stay separate. |
| constraint_index_identity | SET ASIDE | Catalog generator and runner use semantic definitions. Exact alias-name consumers require a separate identifier search before any optional rename. Retain observed state; no dependency on M19/23/24 established. Ancillary cleanup does not gate this release. |
| social_settings.social_settings_uid_key | SET ASIDE | No current live uniqueness consumer established; generated declarations and historical usage alone do not gate queue migrations. Preserve existing unique constraint. |
| suzinvites.suzinvites_uid_fkey | SYNC BEFORE STABLE | Record existing live uniqueness/FK in file contract; no constraint creation or deletion. |
| conversations.conversations_zid_index | SET ASIDE | Redundant index variant does not block selected migrations. Retain current indexes, document optional shape; no rebuild. |
| users.users_uid_idx | SET ASIDE | Redundant index variant does not block selected migrations. Retain current indexes, document optional shape; no rebuild. |
