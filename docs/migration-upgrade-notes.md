# Migration runner upgrade notes

The first selected legacy upgrade records the supported existing schema, then
applies only M19, M23 and M24. They create the job-system tables and routines.
They do not enable any worker or application feature flag. Production is never
changed merely to match old bootstrap files.

## Choose the installation path

| Starting state | Required path | Expected outcome |
| --- | --- | --- |
| Empty PostgreSQL 17+ | `apply`, then `check` | 20 executed files, three retirement ADOPTED receipts, 23 ready |
| Supported legacy schema through M18 plus valid M22, no queue/history | first-deploy report, `reconcile --through 000022`, `apply`, `check` | 20 ADOPTED; exactly M19/M23/M24 APPLIED |
| Supported legacy schema through M18, missing M22 | `reconcile --through 000018`, `apply`, `check` | 19 ADOPTED; M19, concurrent M22, M23/M24 APPLIED |
| Existing queue /1, /2 or /3 | exact installed catalog/receipts review, reconcile through actual installed version, then apply/check | compatible installed queue retained; only pending selected files execute |
| Modern valid runner history | `apply`, `check` | existing APPLIED/ADOPTED receipts retained; rerun executes zero |
| Legacy ledger with known filenames | bounded reconcile after catalog review | timestamps preserved, no fictional execution receipts |
| Retained M4/M5/M7 targets | stop for separately reviewed completion/retention plan | no automatic destructive migration or fake adoption |
| Partial/conflicting schema, unknown ledger/file, later queue variant | stop for explicit reviewed reconciliation | no blind replay, manual history insertion or source rewriting |

The historical bootstrap and named legacy schema are distinct supported variants.
See [their exact contract](migration-legacy-contract.md). A successful limited
adoption contract is not an exhaustive certification of every custom object,
extension, historical routine implementation, data invariant or application path.

## Deprecated removal files

M4 historically removed `waitinglist`. M5 removed Slack OAuth/users/invites/bot
events, Stripe accounts/subscriptions, free-upgrade coupons, LTI users/context
memberships/OAuth credentials, Canvas callback/conversation tables, and the
`conversations.is_slack`, `conversations.lti_users_only`, `users.plan` columns.
M7 removed `geolocation_cache` and participants_extended's `country_code_iso`,
`encrypted_maxmind_response_city`, `ip_address`, `latitude`, `location`,
`longitude` and `x_forwarded_for` fields.

All three files remain immutable historical evidence. Ordinary upgrades never
execute them. Absence of the exact named objects allows an ADOPTED receipt;
retained targets block without deletion. Other Slack tables, the differently
named `participants_extended.country_iso_code`, encrypted network fields, and
`facebook_users.location`/`twitter_users.location` are not removal targets.
A composite type's `location` attribute is not a participants_extended column.

## Report-only first-deploy check

`server/postgres/migrations/report/first-deploy.sql` is the first-deploy report.
Its SQL predicates are generated directly from the reviewed adoption sources,
with helper expressions inlined. It uses one bounded REPEATABLE READ READ ONLY
transaction followed by ROLLBACK, creates no temporary functions/tables, reads
no application rows, and returns only migration names, booleans and outcomes.
`python3 server/bin/build-migration-report.py --check` verifies its exact source
binding; regeneration is a reviewable file change.

The operator sends the entire SQL file through **one connection** of the existing
server's database client, with existing connection/TLS settings. Do not deploy
the new runner or restart the app just to report. For a local or controlled
operator session, `psql -X -v ON_ERROR_STOP=1 -f <report>` is equivalent, using
the normal secret connection environment without a credential argument. On any
query error, ROLLBACK or close that same client before returning it to a pool.

Expected initial-schema results: 20 `WOULD_ADOPT`, three `WOULD_APPLY`, and four
`OUTSIDE_RELEASE` entries. The report conservatively flags any existing queue
role for migration-session review rather than guessing inherited ADMIN/SET
authority. Existing ledgers/queues report review-required; they need the exact
normal reconciliation catalog verifier and a separate read-only examination.
A mismatch in any required predicate blocks the aggregate adoption forecast.
A runtime read-only role can report schema but cannot predict privileged DDL
success; check the intended migration session separately.

The report proves no future lock acquisition, available capacity, successful
DDL or application health. Its snapshot expires; reconcile and apply recheck
their actual contracts when executed. M22 presence in the initial report is
required; missing M22 uses the explicit shorter-bound path above.

## Privileges, interruption and deployment

Use the intended migration session, including M19 role provisioning and grant
authority. Owning only the database or having normal app SELECT/INSERT access
is insufficient. M23/M24 SET ROLE to the queue owner. Never grant broad rights
to a runtime login just to satisfy startup; startup needs metadata SELECT.

Each ordinary file and its history receipt commit together. If M23 fails after
M19 commits, M19 remains applied while all M23 changes and its receipt roll back.
Do not describe that as a rollback of the whole release. M22 is the documented
concurrent-index exception; interrupted valid indexes may persist and be reused.
Check invalid/conflicting index recovery in [migrations.md](migrations.md).
Two runners serialize using the database advisory lock; they do not double-apply.
Lost commit connections require history inspection, not an assumed rollback.

On the first deployment, an old successful revision's stop hook may have already
stopped the old application before the new migration hook runs. New deferred-stop
hooks protect old containers only after that transition. A later API startup
failure may occur after old containers have been removed. This patch supplies
no automatic rollback, previous-image fallback or CodeDeploy health guarantee.
Verify actual HTTP/application health after replacement and preserve a reviewed
recovery procedure. A detached Compose launch is insufficient evidence.

Keep a per-deployment [reconciliation record](migration-reconciliation.md),
including exact source hashes, schema report, actual session authority, observed
receipts, supported variants, backup evidence and health result. Do not publish
credentials, application records or real conversation/report identifiers.
