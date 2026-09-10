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
later publications; queue finalization, uncertain-operation admission, retention
and deletion policy still require the separate D03/D04 implementation and tests.
No automatic receipt deletion or retention promise is implemented here.

## Roles and authority boundary

The installer and reversal require a PostgreSQL 17 superuser. This deliberately
uses the same installer class as the down rehearsal instead of introducing a new
non-superuser role-administration protocol in this schema item. Neither script
grants role membership or creates a login/password.

* `polis_coordinator_owner` owns the new state objects. Its external privileges are
  public-schema USAGE/CREATE and conversations SELECT/REFERENCES(zid)/UPDATE(topic)
  for the parent lock/FK boundary. It receives no existing math write grant.
* `polis_coordinator_control` can maintain leases, cursors, failures and
  reconciliation and read receipt tables. It cannot insert receipts or use the
  publication sequence.
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
then locks parent → lease → ticks and writes bidtopid → ptptstats → main, followed
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
retained receipt history. The publication function reads this indexed maximum
under the parent/lease locks. Deleting or regressing the latest pointer therefore
advances to a fresh generation instead of reusing an immutable receipt identity.
A caller whose expected tick ignores retained history gets a conflict. Exact
operation readback still proves a past commit without promising that current
math rows have survived; a new repair operation restores those rows.
