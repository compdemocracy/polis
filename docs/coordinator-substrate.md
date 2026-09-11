# Coordinator ownership substrate, migration 000021

000021 is a schema handoff. It does not activate a coordinator, move a writer,
provision a service login, or migrate DynamoDB. Apply it only after a separate
operator decision. The old prototype migration is incompatible with this schema;
000021 refuses a database carrying its objects or added math metadata columns.

The migration leaves the existing math columns and payloads unchanged. It keeps
ownership and generation identity typed, with three small versioned JSONB
structures retained from the prototype: consumer positions, source probes, and
input checkpoints. This preserves their exact comparison semantics while the
coordinator–poller bridge changes. Original science output remains bytea, not a
re-encoding of JSONB. A database CHECK verifies each original SHA256 against its
bytes. The storage digest is separately named; its numerical normalization stays
an adapter contract, not an assertion that original bytes equal JSONB text.

| Object | Purpose and key |
| --- | --- |
| `polis_coordinator_leases` | Current owner/epoch/expiry, `(math_env,zid)` |
| `polis_coordinator_cursors` | Versioned consumer position, `(math_env,consumer)` |
| `polis_coordinator_failures` | Retry state, `(math_env,zid)`; due index |
| `polis_coordinator_reconciliation` | Source observation time and probe, `(math_env,zid)`; age index |
| `polis_coordinator_generations` | Durable operation/owner/epoch/checkpoint receipt, `(math_env,zid,math_tick)`; unique operation per conversation/namespace |
| `polis_coordinator_payloads` | Exact bytes and original/storage digests, `(math_env,zid,math_tick,payload_kind)`; FK to the generation |
| `polis_coordinator_budgets` | Operator-provisioned namespace count and reserved logical-byte ceilings; no default profile |
| `polis_coordinator_operations` | Durable exact dispatch identity, reservation, state and reconciliation position, `(math_env,zid,operation_id)` |
| `polis_coordinator_references` | Up to 128 independent named holds per admitted operation; FK prevents unreferenced deletion |
| `polis_coordinator_floors` | Monotonic published generation and caching cursor, `(math_env,zid)`; never removed by cleanup |
| `polis_coordinator_caching_tick` | Bounded bigint sequence, initialized above the existing main maximum |
| `polis_coordinator_install` | Singleton migration identity, catalog/provenance seals |
| `polis_coordinator_install_roles` | Created versus adopted role and its original OID |
| `polis_coordinator_install_grants` | Complete typed inventory of required external grants and their pre-install state |

A generation does not FK to the current lease epoch: renewing or transferring a
lease must not destroy the evidence for an older committed operation. Original
payloads reference their generation, so they cannot become independent orphan
receipts. Publishing must atomically insert all three originals plus generation
metadata and the four existing math rows. A table row by itself is not a complete
publication certificate. The publication function verifies original JSON identity/timestamps and hashes,
then writes the four rows and receipts under the final lease check. The bridge
must also perform its science/output-schema validation and verify all companions
and exact operation/checkpoint/owner/epoch on readback.

The per-generation identity leaves room for typed job/run/attempt joins and typed
result-specific child tables when Delphi's queue and results move to Postgres.
There are no speculative nullable job columns or generic JSON result envelopes
in this change. Queue 000019 remains noop-only. Durable math receipts can survive
later publications. Rev4 adds the SQL admission/reconciliation/cleanup boundary
below; runtime scheduling, queue finalization and the D04/D05 transfer rehearsal
remain separate. Installation activates no automatic cleanup or dispatcher.

## Roles and authority boundary

The installer and reversal require a PostgreSQL 17 superuser. This deliberately
uses the same installer class as the down rehearsal instead of introducing a new
non-superuser role-administration protocol in this schema item. Neither script
grants role membership or creates a login/password.

* `polis_coordinator_owner` owns the new state objects. Its external privileges are
  public-schema USAGE/CREATE and conversations SELECT/REFERENCES(zid)/UPDATE(topic)
  for the parent lock/FK boundary, plus SELECT on the four existing math tables
  for admission and current-generation protection. It receives no existing math write grant.
* `polis_coordinator_control` can maintain leases, cursors, failures and
  reconciliation and read receipt tables. It cannot insert receipts or use the
  publication sequence. It executes the fixed admission, reconciliation,
  protection and cleanup functions; direct DELETE of receipts stays denied.
* `polis_coordinator_publication_owner` is the new NOLOGIN owner of the fixed
  `pc_publish` SECURITY DEFINER function and its private `pc_canonical` helper.
  It has SELECT/INSERT/UPDATE on only the four existing math tables, public schema
  USAGE, conversations SELECT/UPDATE(topic), lease SELECT/UPDATE, receipt
  SELECT/INSERT and sequence USAGE. Its function fixes
  `search_path=pg_catalog,pg_temp` and fully qualifies application objects.
* `polis_coordinator_publisher` gets EXECUTE on `pc_publish` and metadata reads.
  It has no direct math, lease, receipt or sequence write privilege. The control
  role cannot execute `pc_publish`. Both can read the installation fingerprint.

These are schema capabilities, **not admitted runtime service credentials**.
The restricted publication API performs the final in-transaction owner/epoch/DB-time
margin check; integrating its Rust/Python callers is the next bridge handoff. Existing Python and Clojure writers
remain unfenced by installation alone. Do not grant these roles to a live login
or enable dispatch as part of this schema installation. Namespace restrictions,
legacy writer exclusion and the complete D05 transfer rehearsal remain required.

Safe pre-existing NOLOGIN roles with unrelated direct grants/settings can be
adopted. Privileged attributes or an outgoing inherited-role membership refuse
installation. Runtime membership provisioning is separate. The down script
preserves adopted roles and their original direct grants/settings; a newly
created role must still be bare before it can be removed.

## Rehearsal and application

Run only against the script's own disposable cluster:

```sh
COMPOSE_PROJECT_NAME=p027-m21-review-unique \
POLIS_RECOVERY_PG_PORT=56132 \
COORDINATOR_DOWN_EVIDENCE_DIR=/private/tmp/000021-review-unique \
bash server/postgres/migrations/down/test_000021_down.sh
```

Choose unused project/port values. The wrapper refuses an existing project,
accepts no target connection string, mounts source SQL read-only, uses tmpfs for
Postgres data, and tears down only its own project. The retained directory holds
full-chain baseline/post-down catalogs, profile, exact case results and source
hashes, startup/cleanup logs and residual-resource counts. The catalog pin uses
PostgreSQL 17 deparse; a different profile needs a reviewed measurement, never
an automatic pin adjustment.

Before any separately approved installation: retain the tested up/down hashes,
target catalog and role/grant preflight, tested backup/restore, publisher
exclusion and concrete reversal commands. Apply **the one up file**, never the
migration directory. There is no automatic migration call in a runtime adapter.
The up takes SHARE on `math_main` while initializing the sequence above its
maximum; it does not update existing math data. Exclusion must continue beyond
COMMIT until the bridge owns publication. Ordinary legacy writers do not honor
this new sequence. Replay leaves sequence state and all provenance unchanged.

Down is a separate operator action using the one file:

```text
psql -X -v ON_ERROR_STOP=1 ... -f server/postgres/migrations/down/000021_drop_polis_coordinator.sql
```

By default it refuses any coordinator data or a used sequence. `-v force=1`
overrides only that refusal. It never overrides drift or missing/malformed
provenance, and never drops unrelated dependencies. It locks data and provenance
before counting, drops only the fixed inventory, revokes only recorded new
external privileges as their original grantor, and removes only recorded created
roles proven to be bare. It does not issue `DROP OWNED` or `CASCADE`.

No grant option is added or upgraded by 000021. A pre-existing plain privilege or
WITH GRANT OPTION privilege remains exactly as it was; identical entries that
coalesced during installation are preserved. Provenance uses typed NOT NULL rows
and a content seal, in addition to the catalog seal; removing or editing a grant
or role entry refuses both down modes and replay. As with 000019, the installer
is trusted: an administrator who deliberately forges all seals is outside this
provenance threat model.

A completely absent schema/roles is an idempotent down no-op. After down preserves
an adopted role, a second down refuses that role-only state rather than guessing
that it owns it. Reapplication can adopt the role again with fresh provenance.

## Bridge integration follows separately

The first schema handoff preserves the prototype and all historical S1/S2
records. The dispatcher records a single operation, expected tick, positive commit
margin and checkpoint SHA256 on the lease, together with the SHA256 of a fresh
32-byte random capability. Only the child receives the capability itself, through
its private process input; it must never be logged or passed as an argv value.
Reading a newer public owner/epoch from the lease does not let a stale child
forge that dispatch. All request bindings are checked by `pc_publish`. Exact
capability/owner/epoch/checkpoint/bytes readback is idempotent even after a newer
publication, because receipts retain the original operation. A mismatched replay
raises `OPERATION_IDENTITY_CONFLICT`. A fresh expected-tick conflict writes nothing.

`pc_publish` prepares and hashes the three original byte streams before locks,
then locks parent → lease → operation → ticks and writes bidtopid → ptptstats → main, followed
by the new receipt rows. It rechecks DB time with the dispatcher's positive
margin while holding the lease lock. Its returned timestamp is recorded before
COMMIT, not the physical commit time. The caller must commit immediately and
reconcile any ambiguous COMMIT; the margin does not promise a bounded COMMIT
round trip. These are fixed SQL statements, with no caller-supplied identifiers
or dynamic SQL in the publication function. Its SQLSTATEs distinguish FENCED,
LEASE-EXPIRED, invalid dispatch, and operation-identity conflict. Numeric storage
hashes use the prototype's normalized numeric JSON convention through
`pc_canonical`; original byte hashes remain independently checked.

No runtime adapter reads 000021 yet; the prototype still reads its
separate prototype SQL. When the bridge's Rust/Python readers are introduced,
each must validate the exact shared 000021 byte pin before consuming its schema
contract. The migration test loader validates the up/down pair now. Any future
schema/API change requires a new reviewed pin and down rehearsal, rather than a
silent alteration of an accepted schema item.

## Recovery after current-row loss

The expected generation is the greater of the current math_ticks pointer and
retained receipt history and the durable floor. The publication function reads this indexed maximum
under the parent/lease locks. Deleting or regressing the latest pointer therefore
advances to a fresh generation instead of reusing an immutable receipt identity.
A caller whose expected tick ignores retained history gets a conflict. Exact
operation readback still proves a past commit without promising that current
math rows have survived; a new repair operation restores those rows.

## Rev4 durable admission and cleanup

A reviewed operator profile inserts one `polis_coordinator_budgets` row per
namespace with `max_operations` and `max_bytes`. Installation inserts none.
The control and publisher roles cannot change the limits. Every retained
operation, including resolved history, consumes one slot and its full byte
reservation until cleanup succeeds. New work is refused at either ceiling;
reconciliation and cleanup remain available. This is a bound on reserved logical
receipt bytes, not PostgreSQL filesystem size: indexes, WAL, MVCC/vacuum and
per-conversation floor rows still need an independently sized storage profile.

The controller arms the lease, calls `pc_admit`, commits that transaction, then
dispatches the child. Publication rejects an admission row written in its own
transaction, so a combined admit/publish cannot bypass this durable boundary. Admission captures namespace/conversation/operation,
owner/epoch, expected tick, capability/checkpoint/source digests and byte ceiling.
It checks the current generation floor and serializes capacity accounting on the
namespace budget row. The source digest is supplied by the trusted controller;
the checkpoint digest binds the exact checkpoint consumed by `pc_publish`.
Reusing an admitted operation with another identity or reservation refuses.
Caller-generated operation identifiers must be unique. A compacted exact retry
cannot bypass the generation floor, but expired history is no longer available
as an exact receipt and must not be represented as verified.

Publication requires the admitted identity. The byte charge is the three
original byte lengths, retained checkpoint text length and 1048576 bytes reserved
for bounded metadata. Request checkpoints are limited to 65536 bytes and cannot
supply the function's reserved receipt fields. Oversized publication raises
`PUBLICATION_BYTE_CAPACITY` before science writes. The full reservation stays
charged after publication; it cannot be reduced to evade capacity accounting.

New operations are `pending`. `pc_reconcile` checks the exact historical receipt,
all identity fields and three companion rows, then records `resolved` and its
exact generation. An absent receipt becomes `unresolved`, even on a replacement
controller connection or after lease takeover. It remains charged and protected;
there is no timeout that converts absence into proof or deletes the reservation.
The partial `(math_env,reconciled_at,zid,operation_id)` index lets the caller
resume oldest-first reconciliation. Commit each bounded pass; no durable scan
cursor depends on process memory. Terminal absence/release is deliberately not
an admitted transition in this schema.

`pc_protect` places or removes the controller's explicit hold on an admitted
operation. `pc_reference` registers/releases an independent named hold, with an
idempotent key and a hard ceiling of 128 names per operation. Releasing one name
does not release another caller's hold; the metadata allowance includes the
bounded reference catalog.
`pc_cleanup` addresses one exact operation, locks parent/lease/budget/operation,
and deletes only a resolved, unprotected, noncurrent receipt with no named hold, pending or
unresolved expected-generation reference and no live lease reference. It keeps
the maximum receipt and the monotonic floor row. It deletes companions before
the generation and operation in one transaction, releasing capacity atomically.
An unsafe cleanup returns false without deletion. These functions are the
control role's scoped DELETE authority; the login has no direct receipt DELETE,
publication permission, arbitrary SQL or identifier input.

The existing math tables receive no columns, triggers or migration-time data
changes. The NOLOGIN state owner gains only recorded SELECT grants on them.
Provenance and both down modes cover the new catalog, functions and grants;
normal down also refuses profiles, operations or floor data. Rev4 is amended in
place because earlier revisions were applied nowhere. Replaying onto an older
installed catalog fails its seal rather than upgrading it implicitly. Any bridge
built against an older byte pin must be reviewed and updated before activation.

### Rev5: independent publications within a namespace

Publication never locks the namespace budget. Its separately committed
reservation has already charged the full count/byte allowance; publication
changes no accounting. It locks its own parent, lease and operation and checks
that the serialized result fits that reservation. Admission keeps the short
namespace budget lock for its capacity arithmetic and reservation insertion.
Cleanup/reconciliation retain their established lock order and accounting.

A paused publication for one conversation must allow another conversation in
the same namespace to admit and publish. Completion can be out of caching
sequence order; readers still need overlap and metadata sweeps (R12). The sealed
rehearsal exercises both newly admitted and already admitted second conversations
while the first is paused after its main write. An old-budget-lock mutation must
block that same admission schedule. No test bypasses or relaxes the R12 contract.

This amends 000021 in place under the applied-nowhere rule. The catalog seal and
up/down byte pins change; consumers must adopt the reviewed rev5 pin before use.


### Rev6: namespace authority and transition receipts

Every runtime login needs a reviewed `polis_coordinator_namespaces` profile and
one `polis_coordinator_principals` mapping before it can acquire a lease, admit
work or publish. Installation provisions neither. The mapping records both the
login name and PostgreSQL role OID, its one `math_env`, and a separate
`can_transition` flag (false for ordinary runtimes). Recreating a login requires
new provisioning. A session setting or `SET ROLE` cannot change its assignment:
the authority uses `session_user` and the matching OID. Runtime roles cannot edit
profiles or mappings. Operator changes require publisher exclusion and review.

Row-level policies restrict direct control writes and runtime reads on the new
coordinator tables. Every privileged admission, reconciliation, protection,
reference, cleanup and publication entry point also authenticates the namespace
before reading an exact receipt or doing privileged work. A publisher retains
its capability/lease checks and cannot write math directly. The dedicated
NOLOGIN function owners remain trusted; do not give service logins membership
in those owners, superuser, BYPASSRLS or role-management privileges. Policy
expressions and role lists are included in the up/down catalog seal.

Nothing changes the policies, triggers, columns or grants on existing math
tables beyond the already reviewed publication-owner grants. Existing Clojure
credentials are **not** fenced by this schema. Use the isolated shadow database
option; externally drain legacy writers and prevent reconnect before transition.
Keep shadow side effects isolated. The namespace mapping protects coordinator
and Python authority, not an old broad-credential legacy connection.

`pc_transition(source_env, destination_env, zid, transition_id,
last_served_tick, exclusion_sha256)` is an operator capability, separately
provisioned with `can_transition=true` and the control role. It is bound to the
operator login's destination namespace. The digest binds the operator's external
exclusion evidence; it is not a database proof that legacy processes stopped.
The immutable operation ID, source/destination, conversation, caller identity,
last client clock and exclusion digest identify the exact receipt. A mismatch
refuses, while an exact retry returns the historical result without new writes,
even at capacity. The result describes that commit, not current readiness.

The API locks the conversation exclusively, then both namespace lease rows in
key order, the destination transition profile and the four math tables in their
fixed publication order. A live same-conversation publication prevents the
transition; lock waits are bounded to one second. Other conversations still
publish independently (the rev5 publication path takes no namespace budget or
transition-profile lock). Call and commit immediately, with an operator-selected
statement/transaction deadline. Draining writers and clearing old reader
processes remain mandatory beyond the database transaction.

A namespace profile declares `writer_kind` (`python` or `legacy`) and an explicit
`max_transitions` in 1..10000. Retained transition receipts count toward this
ceiling; there is no runtime deletion, timeout, or automatic enlargement. Text
fields and numeric clocks have fixed bounds. This is a logical receipt bound,
not a physical PostgreSQL storage/WAL/MVCC bound. The dedicated receipt catalog
does not consume or release uncertain publication reservations.

For a Python destination the API records the greater of the source and
destination current/retained clocks, the last served client tick, and zero in
`polis_coordinator_floors`. It returns `publication_required`. It does not
retick existing Python output or create a generation receipt. The bridge must
read that floor as its expected tick, acquire a fresh dispatch and commit an
actual Python publication at floor + 1 before any reader switches. Missing,
zero and stored-empty source rows do not reset the client clock.

For a legacy destination the API requires all four existing math rows at one
coherent tick. Missing, partial or mixed-generation output refuses; an actual
legacy rebuild is required first. It atomically reticks those four rows above
all observed and last-served math ticks, and gives main a fresh sequence cursor.
Science payloads and original-byte archives stay unchanged. No Python generation
receipt is invented for the legacy result: historical receipts stay at their
historical keys. A fresh legacy process must read the database tick when it
resumes. Client clocks at the exact-number ceiling refuse instead of wrapping.

Both modes expire outstanding source/destination leases and clear their armed
dispatches. The floor, legacy retick if selected, dispatch revocations and exact
transition receipt commit together; errors roll them all back (sequence values
may be consumed). Absent publication receipts remain unresolved and charged.
A transition does not authorize queue finalization or erase publication history.

The transition does not route traffic or reset caches. D05 must retire old
prefetch/Bundle processes and cursors, verify namespace configuration on every
consumer, and prove the complete real-app L→P→L sequence with old client ETags,
comment changes, reports/CSV/auth and continued input. Cross-namespace cache
cursors are not interchangeable. Runtime bridge pins and login provisioning are
adopted in that separate handoff; this schema rehearsal alone is not D05 PASS.

### Rev7: independent observation and revocable per-conversation writers

`polis_coordinator_observer` is a fifth NOLOGIN capability. It has SELECT on all
new coordinator tables, including pending operations, both sides of a transition,
writer authority and install provenance. Its SELECT-only policies require no
principal mapping or function call. It receives no EXECUTE on any `pc_*` function,
sequence privilege, table write privilege, or grant on an existing application
table. Provision an independent observer login with only this role; membership
in a writer/owner role would combine their privileges. Observer evidence can
read a committed unresolved operation even after its writer loses authority.
Observation does not resolve that operation or certify a rollback by itself.

`polis_coordinator_writer_authority(math_env,zid,enabled)` records current writer
authority independently of leases and historical transition receipts. Before the
first transition involving a pair, an absent row allows the already provisioned
namespace principal to write that conversation. Installation seeds no authority.
Every new committed transition writes source=false and destination=true under
its exclusive conversation lock, atomically with lease withdrawal, destination
floor/retick and the receipt. Explicit return transitions can re-enable a writer;
replaying an older exact receipt only reads history and cannot re-enable it.
Deleting a lease, dropping/recreating a runtime process, or cleaning old receipts
cannot remove the authority row. Runtime roles cannot change these rows directly.
There are at most two entries per distinct pair of namespaces and conversation
first encountered by a transition; repeated transitions update existing entries.
This is logical state, not a physical storage/WAL size guarantee.

The scope is **per conversation**, not namespace-wide startup refusal. A process
may authenticate its namespace at startup and continue servicing unaffected zids.
Its subsequent per-zid admission must call `pc_writer_allowed(env,zid)` or
`pc_assert_writer(env,zid)` in the same transaction as acquiring/arming the lease.
The lease INSERT/UPDATE policy independently calls the predicate, so an unchanged
restricted acquisition statement cannot bypass it. New `pc_admit` and
`pc_publish` work also checks it. Revocation raises `WRITER_AUTHORITY_REQUIRED`
(SQLSTATE P2033) through the assertion; direct lease writes fail their RLS check.
Historical exact publication readback and operation reconciliation remain
available after withdrawal and cannot authorize a new publication.

The writer predicate takes the parent conversation's KEY SHARE lock and retains
it to transaction end. It is VOLATILE: its separate authority read sees a fresh
READ COMMITTED snapshot **after** a waiting lock completes. A transition either
waits for previously admitted writer transactions, or its committed revocation
is visible before a waiting acquisition can pass. REPEATABLE READ and SERIALIZABLE
writer transactions explicitly refuse with `WRITER_READ_COMMITTED_REQUIRED`
(P2033), including when an old snapshot would see no authority row. This isolation
contract is part of bridge adoption. Transactions should keep parent → lease
lock order; ad hoc reverse-order writes may be deadlock victims and must retry
the whole transaction. Locks for one zid do not prevent another zid publishing.

The seal includes the observer grants/policies, authority table, writer functions
and lease policy. Normal down refuses authority data; forced down still requires
intact provenance/catalogs, drops only the recorded new objects, and reverses the
observer's recorded schema-USAGE grant. Existing math catalogs and ACLs remain
identical to rev6. This amendment is applied nowhere. Runtime pin adoption, the
independent observer's D06 harness and the full rollback rehearsal remain separate
handoffs, as does any operator authorization to install or activate the schema.
