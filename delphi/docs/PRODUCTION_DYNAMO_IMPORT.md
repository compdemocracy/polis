# One-shot DynamoDB import

The importer reads all 20 codec tables, verifies two complete paginated scans,
partitions rows using the Postgres conversation/report mapping, and imports valid
results through the ordinary fenced queue daemon. **It defaults to dry-run and
never publishes, switches readers, resumes old jobs, or deletes source data.**
All source rows, intermediate files, detailed logs and receipts stay on a private
`/import` mount in AWS. Standard output contains aggregate counts and digests only;
errors report only their class. No production execution is part of this patch.

## Before running in AWS

Colin approves the worker, source account/region, source freeze and import image.
Stop/drain every source writer and take the approved backup first. Two equal scans
are evidence of stable bytes, not a cross-table transaction snapshot. Keep the
freeze through import and verification. This command scans live DynamoDB; it does
not accept AWS S3 export manifests. The local endpoint option is for generated
DynamoDB Local fixtures and accepts loopback HTTP only.

Build `delphi/Dockerfile.importer` from a reviewed Delphi runtime image **pinned
by digest**, containing the matching `polis-jobs` binary. Build context is the
repository root. The source code is copied into the image. No model or paid
provider is invoked. For example, in the approved build environment:

```sh
docker build -f delphi/Dockerfile.importer \
  --build-arg "DELPHI_BASE=$APPROVED_DELPHI_IMAGE_DIGEST" \
  -t "$IMPORT_IMAGE" .
```

The AWS source adapter requires boto3's `iam-role` credential provider. Environment
keys, shared profiles and container credentials are refused. The instance profile
needs **only `dynamodb:DescribeTable` and `dynamodb:Scan`** on the exact 20 table ARNs
listed in `polismath/delphi_storage/codec.py:FAMILIES`, including
`report_narrative_store`. It needs no Dynamo mutation, backup, export or table
creation permission. Metadata/network access and role scope are operator-provided;
this patch changes no IAM, deployment, service, or instance configuration.

Supply these settings privately inside AWS, never in an image, checkout or CI log:

- `IMPORT_SOURCE_DATABASE_URL`: read-only primary Postgres login; `SELECT(zid)` on
  `conversations` and `SELECT(report_id,zid)` on `reports`. Its sessions are explicitly
  read-only. Production requires `sslmode=verify-full` and the approved CA.
- `QUEUE_DATABASE_URL`: dedicated non-admin login that is a member of
  `polis_queue_executor`, without membership in `polis_queue_owner`, superuser,
  replication, database/role creation, or bypass-RLS privileges. Production requires
  `sslmode=verify-full` and the approved CA. Queue writes use existing RPCs only.
- `POLIS_JOBS_CA_FILE` and `POLIS_JOBS_HOST_ALLOWLIST`: the daemon's existing verified
  TLS transport settings. Production requires `POLIS_JOBS_TRANSPORT=tls` (the default).
- A writable encrypted-EBS directory mounted at `/import`, readable only by the
  operator/container identity, with enough capacity for **two census databases,
  canonical snapshots, exact archive/quarantine files and worker journals**.
  Preserve this directory and its permissions for retries and audit/rollback.
  The CLI takes an exclusive lock; do not run another importer on the same mount.

Do not broaden the queue role to read the source application tables. The separate
source login is deliberate. The normal graph child does not inherit either DB
credential or AWS environment settings; only the parent scans/adopts work.

## Dry-run, then apply

On the approved AWS worker (these are operator templates, not executed by CI):

```sh
docker run --rm --env-file "$PRIVATE_IMPORT_ENV" \
  -v "$PRIVATE_IMPORT_DIRECTORY:/import" -v "$APPROVED_CA_DIRECTORY:/ca:ro" \
  "$IMPORT_IMAGE_DIGEST" --region "$APPROVED_REGION"
```

Dry-run performs both scans, validates source key schemas and identities, and
materializes canonical files for size/integrity checks. It opens no queue connection
and writes **zero graph/result rows**. A missing table refuses by default; only
an explicitly inventoried absence may be supplied with `--allow-missing TABLE`.
Absence is included in the source digest. Unknown/extra table names are not guessed
into the frozen 20-family codec; the two undeclared historical moderation names
remain outside this importer.

Review aggregate conservation (`source = imported + archived + quarantined`),
missing-table count, conversation count, large-conversation count, canonical byte
count and source digest. Per-table counts contain no conversation/report IDs.
Private `census-*/snapshot/inventory.json` identifies each exact bundle and archive.
Quarantine includes rows without a unique verified identity, contradictory
conversation/report fields and NUL-containing result rows. Original typed codec
bytes are retained. T15/T16 controls are archived without becoming runnable jobs.
Do not infer complete served coverage when any retained row remains quarantined;
resolve its mapping/retention separately before activation.

Apply requires a fresh confirmation of the maintained source freeze:

```sh
docker run --rm --env-file "$PRIVATE_IMPORT_ENV" \
  -v "$PRIVATE_IMPORT_DIRECTORY:/import" -v "$APPROVED_CA_DIRECTORY:/ca:ro" \
  "$IMPORT_IMAGE_DIGEST" --region "$APPROVED_REGION" \
  --apply --source-frozen --environment "$DEDICATED_IMPORT_ENV" --scope delphi
```

The environment must begin `import-` and must be dedicated to this campaign. Use
one common reader scope for all conversations. The importer processes them
sequentially because queue guards are per environment/scope; node product keys
include the conversation identity. It starts the real daemon, which alone claims,
heartbeats, stages families, confirms child exit and finalizes artifacts. Completed
imports are verified through the result RPC, byte for byte, with the artifact hash
and run binding. The parent never fabricates a lease, result receipt or exit.

No publication occurs. `receipts-*.json` privately records graph/root identifiers;
reviewed publication and reader activation are separate operations. Other readers
and existing published results remain unchanged. Use the common environment/scope
when those later operations are approved.

## Bounds, retries and undo

Detached families support **64 MiB per conversation/family and 256 MiB per
conversation**, the existing M28 storage bounds, while graph metadata remains under
900,000 bytes. This removes the old 450,000-byte bundle restriction; it does not
raise SQL/daemon limits. The census spills to SQLite rather than retaining all
conversations in memory. Every conversation is checked before admission; oversize
families, changed scan digests, duplicate keys, missing tables and invalid schema
refuse without truncation or silently skipping data. A source beyond these bounds
needs a separately reviewed storage-contract change before production admission.

Control and quarantine bytes remain in the exact private archive, outside the
servable Postgres result families. Run artifacts bind the full source digest and
conversation snapshot digest. **Keep that private archive**; Postgres result rows
do not replace it. Imported results do not modify votes or perform sign conversion.

Repeat with the same code/runtime, source freeze, environment, scope and private
mount. Content/provenance request keys reuse completed graphs and attempts. A
partial failure preserves completed work and unpublished evidence; never delete
or restamp queue history. Failed/dead jobs require normal queue diagnosis, not a
new environment to hide failures. The daemon is gracefully stopped on error or
completion. Stopping the importer and retaining Dynamo as reader is the undo;
there is no destructive database rollback, automatic publication or source deletion.

`--wait-seconds` bounds this invocation's wait for graph completion (default 3600).
It does not authorize timing out an external provider; this importer invokes none.
The private worker log/journal is retained for diagnosis. Do not upload it from AWS.

## Executable proof

Hosted CI and mm5 both run:

```sh
bash scripts/test-production-import.sh
```

Set unique `COMPOSE_PROJECT_NAME=polis-import-test-*`, `POLIS_RECOVERY_PG_PORT` and
matching `RECOVERY_PG_PORT`. The script builds the importer, verifies runtime and
migration source bindings, runs boundary/legacy/codec tests, and uses a real local
DynamoDB, narrow source/executor roles, fresh Postgres and real daemon. Generated
fixtures cover all 20 families, two conversations, scan pagination, typed decimals,
sets/binary, >450KB results, private archive/quarantine, dry-run zero writes,
unpublished run bindings and idempotent repeat. Existing reader activation,
server suites, production IAM/TLS and live AWS data are not acceptance claims here.
