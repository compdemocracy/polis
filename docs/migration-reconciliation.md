# Reconcile an existing deployment

Keep one record per database with the release being installed. This is a review
record for the normal `reconcile` → `apply` → `check` path; it is not a list of
host-specific skipped migrations. Never copy credentials, participant rows or
private identifiers into the public repository.

1. Record the release commit and exact migration source hashes, database major
   version, current application version, backup/restore evidence and installer
   privileges. Confirm the previous application's stop hook: the first move to
   deferred-stop hooks can still execute the old hook before migration refusal.
2. Collect a read-only catalog inventory through the deployment's existing DB
   client. Preserve types, defaults, nullability, keys, index validity, routines,
   triggers, grants and sequence configuration. Encode bigint values as strings
   when transporting them through JavaScript JSON. Do not read sequence values
   or vote/application rows as a shortcut to schema reconciliation.
3. Classify every logical migration: present, pending, partial, conflicting,
   superseded by a known later contract, or outside the forward chain. Cite its
   observed postconditions. Names, owners and physical column positions can
   differ without changing the structure; compare key column names and actual
   definitions. Do not count internal FK trigger OIDs as missing migrations.
4. Retain historical receipts separately. Filename aliases, duplicate legacy
   timestamps and a current matching schema are different kinds of evidence.
   Unknown legacy filenames, competing ledgers, nonempty undeclared vote data
   and unknown routine implementations need reviewed resolution. Do not invent
   execution dates or treat a latest filename as a complete prefix.
5. Prepare and test each needed forward repair on generated databases representing
   the actual structural variant. Preserve existing rows, unrelated schemas,
   grants and third-party dependants. Do not truncate or drop data to satisfy a
   catalog predicate; do not change stored vote signs or overwrite a custom
   routine merely to match a fresh installation. Older retirement SQL is not
   authorization to delete retained deployment data.
6. Once all selected adoption postconditions are supported and reviewed, run
   `polis-migrate reconcile --through NNNNNN` with the factual bound. A failure
   must leave all prior history untouched. Then `apply` the ordered pending
   migrations and run `check`. No history rows may be inserted manually.
7. Record the actual per-file outcomes and postconditions. M22 is resumable:
   indexes can commit before their history row; inspect validity after a lost
   connection and reuse valid results. Every other committed earlier file stays
   applied if a later file fails. Do not run down scripts as automatic recovery.
8. Verify application health after service replacement. Detached Compose startup
   alone is not a serving-health receipt. Keep migration readiness, process
   readiness and application health as separate observations.

Record fields:

| Field | Evidence required |
| --- | --- |
| Release | Commit, SQL source hashes, release holds and pending PR composition |
| Observation | Catalog query version/hash, collection date, scope and transport |
| Per file | Logical identity, known aliases, state, exact postconditions and differences |
| History | Actual receipts and their provenance, or explicitly unknown |
| Preservation | Rows, custom objects, grants, active-writer compatibility and backup |
| Repair | Exact reviewed patch, generated regression evidence, failure recovery |
| Adoption | Explicit bound, atomic success or unchanged-history failure |
| Pending work | Ordered apply outcomes, concurrent-index progress where applicable |
| Completion | Runner check plus actual application health evidence |

Fresh databases use `apply`, not reconciliation. Existing /1, /2 or /3 queues
must pass their recorded catalog contracts; install-table presence is not proof.
A partial legacy install needs compatible forward completion, not a fabricated
adoption. M21's release hold remains until its privilege, sequence and publisher
requirements are resolved. Convention declaration and any semantic sign operation
remain explicit operations; neither a catalog nor a migration merge supplies the
operator's declaration.

This record does not by itself remediate unsupported historical variants,
retire destructive files, compose competing unreleased migration ledgers, or
make manual down scripts history-aware. Those release changes and their tests
must be complete before claiming an upgrade works across supported deployments.
