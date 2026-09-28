# Roles census job

This implements P-058's private metadata export, without a migration, new grant,
network policy, launch-template change or application-row export. It is separate
from the sampled paired battery. A PASS describes the catalog inventory; it is
never a migration-reversal or engine-equivalence verdict.

`polis-probe-job/2` has exactly the existing required job fields plus `kind` and
mandatory `reader`. Kind is `roles-census`; commands are respectively `read`,
`produce`, `verify`, with three distinct OCI manifest references. Job/1 retains
its existing commands and receipt/1–2 acceptance. Both the supervisor and local
operator bind receipt kind to the admitted job. The 131072-byte limit is shared;
duplicate JSON keys, nonfinite numbers and nesting beyond 16 are rejected before
validation. UTF-8 encoding is consistent across verifier and supervisor.

The reader uses only the existing `polis_probe_reader` service/socket. Its fixed
SQL reads catalogs in one read-only repeatable-read transaction, checks PG17,
identifier width, session user and transaction state, and sets statement, lock
and transaction ceilings. Each fixed query returns at most 1025 rows so the
1024-row cap can be detected. Limits, missing catalog privileges, broken
references or unsupported major versions produce INCOMPLETE. No credential
fallback or raw error text is exported. The supervisor retains its whole-job
ceiling and disposes the box through the existing lifecycle.

The producer sorts and validates only the permitted reader projection. The
verifier does not import producer code: it reconstructs every typed identity
from the original reader projection, refuses duplicate/omitted/count-mismatched
rows, checks exact equality, source and query-policy bindings, and runs ten
fixed negative controls. Only that verifier writes `/verdict/receipt.json`.
The reader remains trusted for server truth; equality alone cannot prove it.

Receipt/3's top-level keys are `schema`, `kind`, `run_id`, `job_sha256`, `verdict`,
`bindings`, `coverage`, `census`, `controls`. `roles_census.py` is the executable
closed schema. All arrays are sorted by typed identity, limited to 1024 rows per
family and 8192 total, with no duplicate identities or dangling catalog-role or
object references. Role flags below are superuser, inherit, create_role,
create_db, login, replication and bypass_rls.

| Family | Closed row keys |
| --- | --- |
| roles | name, seven flags, connection_limit, valid_until, config_present, config_count |
| memberships | role, member, grantor, admin, inherit, set |
| database | name, owner, allow_connections, connection_limit, acl_state |
| schemas | name, owner, acl_state |
| relations | schema, name, kind, owner, row_security, force_row_security, acl_state |
| columns | relation, name, number, acl_state |
| routines | schema, name, kind, input_types, argument_modes, owner, security_definer, acl_state |
| acls | kind, object, grantor, grantee, privilege, grantable |
| default_acls | owner, scope, kind, acl_state, entries |
| policies | relation, name, command, permissive, roles, using, with_check |
| role_settings | role, scope, rows, config_count |
| role_dependencies | role, scope, dependency_type, count |

Principals are `{kind: PUBLIC, name: null}` or `{kind: ROLE, name: identifier}`.
The schema distinguishes even a hypothetical lowercase `public` role from PUBLIC;
PG17 reserves that literal role name, so the SQL fixture uses quoted `Public`
and the lowercase distinction is a schema-only vector. Object identities are
structured arrays, including input type schema/name pairs for overloads. Only
public-schema objects and the current database are named. Other database/shared
settings and dependencies are aggregated by scope. Exact privilege enums by
object kind live in `PRIVILEGES`; relation grants include PG17 MAINTAIN. Owners
are separate metadata. Null/empty/explicit ACL states are retained; null object
ACLs expand using that object's built-in default, while null column ACLs add no
direct grant. Those defaults are not installation provenance or revocation SQL.

Bindings name source commit, three images, fixed query-policy hash, canonical
permitted-census digest and observed server version. The policy digest covers
both the versioned bounds and the complete generated SQL inventory. The three
reviewed recipes must share source/policy bindings. The verifier compares reader
source to its recipe; the host binds images through the job. The host cannot
independently authenticate a source commit merely from receipt text.

Coverage has a fixed status per family, public/current scope, qualification
counts, and fixed NOT_COLLECTED password/provenance/data and NOT_EVALUATED
reversal fields. Settings export presence/count only. Expressions export only
ABSENT, TRUE, FALSE or UNSUPPORTED_EXPRESSION. No nonconstant policy template is
admitted yet; unknown expressions make the census incomplete. Routine bodies,
raw settings, policy text, passwords, comments, application rows and their
withheld-value hashes never enter the projection. Limits produce an empty
INCOMPLETE census, not truncated PASS. Empty policy/default-ACL families are
valid after successful reads; an empty entire census cannot PASS.

## Local validation

Use public fixtures only and an unused project/port:

```sh
python3 -B -m unittest discover -s ci/probe_box -p 'test_*.py'
python3 -B -m unittest discover -s ci/private_cert -p 'test_*image*.py'
COMPOSE_PROJECT_NAME=p027census-example POLIS_RECOVERY_PG_PORT=56886 RECOVERY_PG_PORT=56886 \
  python3 -B ci/private_cert/images/roles_rehearsal.py
```

The rehearsal owns only its Compose project. It compares the restricted login
with an administrative catalog oracle over a fixture seeded layout, including
unreadable tables, an information_schema omission, all twelve families, overloads,
partitions, sequence and column privileges, null/empty/explicit ACLs, global and
public default grants, RLS constants, and withheld settings/body/comment/policy
markers. Unknown policies and a revoked catalog permission must be incomplete.
`--write-fixture` regenerates only the public JSON vector from that seed.

## Review and release boundary

The source is not yet an admitted image or deployed AMI. `stage.py` requires
committed reviewed source; it intentionally rejects these uncommitted files.
Claude must review and commit before producing the three recipes with
`roles_recipe.py`, staging with the unchanged `stage.py`, and building/exporting
three images through the existing offline workflow. The verifier source must be
independently reviewed. `roles_registry.py` verifies the complete OCI closure,
recipe/action/policy/source bindings and review before emitting the concrete job
and evidence. Its output job belongs at `jobs.roles-census-v1` in
`ci/probe_box/jobs.json`. No placeholder digest or fabricated review is admitted.
The old registry entry remains unchanged until actual reviewed image digests
exist. Bake a new worker with both census modules before activating job/2;
publishing new archives alone cannot make the old AMI admit receipt/3.

Keep metadata receipts private under the existing operator/reviewer encryption,
access and 90-day retention boundary; only run ID/coarse status may appear in
public output. No remote run, real down rehearsal, capacity, alarm, migration or
retirement activation is authorized by these local results. The fixture does
not recreate hidden passwords, settings semantics, routine definitions,
installation provenance or other databases' object layouts.
