# Run-bound Delphi results (#1428)

M28 stores all 18 result families from frozen `delphi-storage-codec/1`. Queue and
active-guard records remain control-plane records, never executable imported jobs.
No legacy table, vote value, or prior result is updated or deleted.

`delphi_result_batches` binds one batch to an environment, graph job, graph run,
and attempt. `delphi_result_families` retains each canonical UTF-8 JSONL file and
its SHA-256. `delphi_result_rows` indexes tagged attributes by the family's real
composite key without converting decimal strings through floating point. JSONB
cannot represent NUL strings; importers must quarantine these with original bytes.

A fenced worker or daemon calls:

* `pd_result_put_family(env, job, owner, attempt, epoch, family, wire)`; identical
  retries return the same digest, changed bytes at the same family key fail.
* `pd_result_seal(env, job, owner, attempt, epoch)`; returns the batch reference
  `{schema, batch_id, sha256, families}`. A sealed batch refuses added families.
* The exact reference goes at artifact JSON `results`; graph finalization verifies
  it and binds its artifact in the same transaction as queue success. Failed or
  superseded attempts cannot affect any served generation.

Small stage outputs may instead embed `family_files: {family: codecWire}`. The
artifact insert trigger validates, stores, seals and binds these within that same
transaction. The M27 artifact cap remains 512 KiB. The staged path permits up to
64 MiB per family and 256 MiB per batch. It does not require embedding full results
in the graph manifest or handing PostgreSQL credentials to a child process.

Readers use `pd_result_artifact_family` for pinned dependencies and
`pd_result_served_bundle` for the coherent served generation. The view
`delphi_result_current_rows` provides environment, conversation, scope, generation,
family, tagged key, and tagged item for existing API filters. An entire family
comes from the closest artifact in the published dependency bundle; an explicitly
empty family shadows older ancestor rows. Existing graph publication CAS and
supersession checks determine visibility. Base tables are inaccessible to the
executor role, which receives only read APIs and fenced writers. Mutable human
annotations belong in separate generation-aware overrides, never these artifacts.

`PostgresResultStore` and `PostgresResultReader` in
`polismath.delphi_storage.postgres` retain caller transaction ownership. They use
the existing frozen codec for Python resource values, validation, and reading.

Validation commands (run on mm5):

```
cd delphi
python -m unittest tests.test_delphi_postgres_results -v
```

This exact command is added to the characterization workflow. The supplementary
real PostgreSQL campaign is `python delphi/tests/job_graph/results.py` with the
existing job-graph proof environment and an idle dedicated local queue. It covers
stale ownership, idempotence, changed retry refusal, atomic manifest rejection,
environment isolation, immutable tables, access denial and publication CAS.

## Default and activation boundary

M28/M29 are selected additive migrations in the release runner. Merging this
code does not switch readers or launch workers. An absent `DELPHI_RESULT_BACKEND`
uses DynamoDB in both Node and Python; `dynamodb` is the explicit default.
Only `postgres` selects the Postgres reader, with `DELPHI_RESULT_ENV` required
and `DELPHI_RESULT_SCOPE` optional. PostgreSQL errors never fall back to DynamoDB.
The server already receives these settings through its environment file; Python
reader processes need them in their own environment. No production flag is set
by this change. Verify published/imported coverage before Colin activates it.

`delphi/scripts/import_dynamo_export.py` is an explicitly invoked command. No
startup hook, migration or service automatically runs it. See
`delphi/docs/LEGACY_DYNAMO_IMPORT.md` for its bounded input contract. The proof's
fixed narrative/name outputs demonstrate transport only. Provider execution,
text quality, old Dynamo table retirement and reader activation are separate.
