# Vote-sign un-flip rehearsal (operator runbook)

The rehearsal proves the P-078 un-flip migration on a temporary copy of the
production database, restored inside the VPC from the latest automated
snapshot. Production is never touched. The migration file is
`server/postgres/migrations/held/000024_vote_sign_unflip.sql`. It is held
outside every apply path: no deploy, initdb or `run-migrations.sh` reaches it.
The rehearsal is the only thing that runs it, and it runs it only on the copy.
Ruling R-I governs any other use.

Roles follow the probe-box rules ([probe-box.md](probe-box.md)):

- The **operator** is an agent session holding the deploy SSO. It runs every
  RDS and Secrets Manager call below.
- The **worker** has no RDS rights. It reads one stack secret and connects
  only to the copies.
- **Identifiers** stay in the operator dir. These are the snapshot, the
  endpoints and the one-time password. The job carries only their sha256.
- **The receipt** carries numbers and fixed verdict names only.

Placeholders in angle brackets are values from the operator dir or the stack
outputs. This document holds no values.

## Before the first rehearsal

1. Deploy the CDK delta (`cdk/probeBox.ts`: `RehearsalDbSg`, its ingress from
   the worker, the worker's egress to it, `RehearsalDbSecret` and the worker's
   read of it) from the ProbeStack's own worktree, with all of its current
   context flags. This delta ships separately from the job code.
2. Bake and admit a new probe AMI. `worker.py` has the rehearsal phases and
   `unflip_rehearsal.py` is a baked file.
3. Merge the registry PR that pins the reader, producer and verifier image
   digests, and that binds `convention_ddl_sha256` to PR-A's committed
   migration file. The registry entry is the only source of truth for the
   images and the three file digests: `restore` and `launch` never replace
   them. They refuse a template (`PLACEHOLDER_IMAGE`, `PLACEHOLDER_DIGEST`)
   and any local file that is not the pinned bytes (`MIGRATION_DIGEST`,
   `QUERIES_DIGEST`, `DDL_DIGEST`). The registry binds PR-A's `000023` by
   digest; until PR-A lands, its bytes are in
   `ci/probe_box/fixtures/unflip/000023_vote_convention.sql`.
   `restore` checks all of this before any RDS call.
4. Write the operator config. It is the stack's `WorkerConfig` output plus
   one key, `DB_SUBNET_GROUP`: the production database's subnet group name.
   Save it as `<operator dir>/config.json`.

## Each rehearsal

Every command runs from the repository root under the operator profile.

```bash
# 1. Preflight. Refuses on: a stale snapshot (older than 36 h), a leftover
#    tagged copy, an unconfirmed cleanup in the ledger, expired SSO, or a
#    missing rehearsal secret.
python3 ci/probe_box/run.py unflip-rehearsal check \
  --config <operator dir>/config.json --profile <operator profile> \
  --source-db-instance <production instance identifier>

# 2. Restore. Refuses first, before any RDS call, unless the registry is pinned
#    and the local held migration, queries file and --ddl are its exact bytes.
#    Then restores the latest automated snapshot into the stack-named copy
#    (and its -r2 twin when the restore rule runs), sets a one-time master
#    password on each copy, writes the rehearsal secret, and drafts the job in
#    <operator dir>/unflip-<run8>/.
python3 ci/probe_box/run.py unflip-rehearsal restore \
  --config <operator dir>/config.json --profile <operator profile> \
  --source-db-instance <production instance identifier> \
  --run-id <32 hex> --mode <dry|flip> \
  --certification <public conversation id> --certification <public conversation id> \
  --ddl <PR-A migration file> --server-image sha256:<server digest> --engine-image sha256:<engine digest>

# 3. Launch. Refuses unless the drafted job carries the registry's images and
#    digests (and the local files match), or on a leftover copy from another run.
python3 ci/probe_box/run.py unflip-rehearsal launch \
  --config <operator dir>/config.json --profile <operator profile> --run-id <32 hex> --ddl <PR-A migration file>

# 4. Watch. Ends at the receipt. Cleanup (step 6) always runs in its finally.
python3 ci/probe_box/run.py unflip-rehearsal watch \
  --config <operator dir>/config.json --profile <operator profile> --run-id <32 hex>

# 5. Receipt. Runs the closed decode, binds the result to the job and records
#    it in the ledger.
python3 ci/probe_box/run.py unflip-rehearsal receipt \
  --config <operator dir>/config.json --profile <operator profile> --run-id <32 hex>

# 6. Cleanup. Run it again by hand if the watch did not end cleanly. It deletes
#    only this run's copies at the stack's two fixed identifiers, and only when
#    their sole security group is the rehearsal group. Anything else carrying
#    the tags is refused, kept and reported (the ledger then refuses launches).
python3 ci/probe_box/run.py unflip-rehearsal cleanup \
  --config <operator dir>/config.json --profile <operator profile> --run-id <32 hex>
```

`status` and `cancel` are the ordinary lifecycle commands:
`run.py status|cancel --config … --profile … --run-id …`.

### The RDS and Secrets Manager calls these commands make

The list is for review, and for a manual cleanup. The subcommands above are
the supported path.

```bash
# check
aws rds describe-db-instances --profile <operator profile>            # leftover copies tagged polis:probe-box=<box id>
aws rds describe-db-snapshots --db-instance-identifier <production instance identifier> \
  --snapshot-type automated --profile <operator profile>
aws secretsmanager describe-secret --secret-id <REHEARSAL_SECRET_ARN> --profile <operator profile>

# restore (per copy: <REHEARSAL_INSTANCE>, and <REHEARSAL_INSTANCE_R2> when the restore rule runs)
aws rds restore-db-instance-from-db-snapshot --db-instance-identifier <REHEARSAL_INSTANCE> \
  --db-snapshot-identifier <snapshot identifier> --db-instance-class db.t3.large --storage-type gp3 \
  --allocated-storage 60 --db-subnet-group-name <DB_SUBNET_GROUP> \
  --vpc-security-group-ids <REHEARSAL_SECURITY_GROUP> --no-publicly-accessible --no-multi-az \
  --no-deletion-protection --no-copy-tags-to-snapshot \
  --tags Key=polis:probe-box,Value=<box id> Key=polis:probe-run,Value=<run id> --profile <operator profile>
#   (if --allocated-storage is rejected: restore without it, then)
aws rds modify-db-instance --db-instance-identifier <REHEARSAL_INSTANCE> --allocated-storage 60 \
  --apply-immediately --profile <operator profile>
aws rds modify-db-instance --db-instance-identifier <REHEARSAL_INSTANCE> \
  --master-user-password <one-time password> --backup-retention-period 0 --apply-immediately \
  --profile <operator profile>
aws secretsmanager put-secret-value --secret-id <REHEARSAL_SECRET_ARN> \
  --secret-string file://<operator dir>/<secret document> --profile <operator profile>

# cleanup (per copy)
aws rds delete-db-instance --db-instance-identifier <REHEARSAL_INSTANCE> \
  --skip-final-snapshot --delete-automated-backups --profile <operator profile>
aws secretsmanager put-secret-value --secret-id <REHEARSAL_SECRET_ARN> --secret-string '{}' \
  --profile <operator profile>
```

The one-time password is generated on the laptop. It is set on the copy and
goes into the stack secret. It is never printed and never committed, and the
copy's deletion makes it useless. Production's master credential is never
read: a restored copy inherits it, and the restore step replaces it.

## What the worker does

Each step below is a phase of `ci/probe_box/unflip_rehearsal_steps.py`. The
reader and producer containers run them in turn
(`worker.py: REHEARSAL_PHASES`).

1. **Preflight**, before any write. It checks:
   - the digests of the held migration, the queries file and PR-A's DDL;
   - the server is PostgreSQL 17;
   - the session is not a superuser;
   - the snapshot age;
   - the restore shape (class, storage type and size);
   - free storage against `min_free_storage_gb`. Free storage is an estimate:
     the copy's observed allocation minus every database and the WAL
     directory (`pg_ls_waldir`, which needs `pg_monitor`). If it cannot be
     read, the run refuses. `min_free_storage_gb` is the margin for the flip's
     new heap, index and WAL.
2. **Copy marker.** The first write is `COMMENT ON DATABASE <copy> IS
   'polis-unflip-rehearsal-copy'`, made on the temporary copy the secret
   names and never on production. The engine-rebuild tool writes only with
   `--i-am-a-copy --require-copy-marker`, so it refuses any database without
   the marker. If the comment cannot be set, the run refuses (`COPY_MARKER`).
3. **PR-A's DDL**, only if the copy predates it. The convention must then
   read version 0 / agree -1, with no un-flip row in the ledger.
4. **PRE.** Recorded in one repeatable-read snapshot:
   - semantic aggregates per conversation;
   - one hash per participant;
   - raw counts and sizes.

   In `flip` mode it also records:
   - `votes.csv` exports of the certification conversations;
   - the engine's cold rebuilds of the sample, under the non-served label
     `probe` (producer phase `engine-pre`);
   - then served pca2 bytes for the certification conversations, from a
     loopback server running with `MATH_ENV=probe`, so pca2 reflects the cold
     rebuild rather than the stored rows (reader phase `served-pre`). Each
     rebuild first clears the label's `math_main`, `math_bidtopid`,
     `math_ptptstats` and `math_ticks` rows, so both sides mint the same
     ticks. The comparison drops `math_tick`, `caching_tick` and the ETag from
     the pca2 bodies, and drops the blob's engine-local `math_tick` from the
     `math_main` digest.
5. **MIGRATE.** The transaction takes its locks in order:
   `LOCK TABLE vote_convention IN EXCLUSIVE MODE`, then the row `FOR UPDATE`,
   then `LOCK TABLE votes, votes_latest_unique IN SHARE ROW EXCLUSIVE MODE`.
   While it is open, `vote_insert()` and any direct `INSERT` fail with 55P03;
   reads continue.
   - `flip` runs the held file and commits it.
   - `dry` runs its body inside a transaction and rolls it back.

   A monitor connection samples lock waiters. It cancels the migration past
   the wall budget (90 minutes). Wall time, WAL bytes and heap and index
   growth are recorded.
6. **RE-RUN.** The file must fail at its version guard (SQLSTATE `P0785`). In
   `dry` mode the re-run happens inside the open transaction, behind a
   savepoint.
7. **POST** (`flip`). Runs `VACUUM (VERBOSE)`, then the PRE recordings again
   (the rebuild, then pca2 from it), the convention row, and one
   `vote_insert()` round trip on the copy (rolled back). In
   `dry` mode the SQL recording is repeated after the rollback, to prove the
   copy is unchanged.
8. **Restore rule** (`flip`, `restore_rule`), on the second copy:
   - absent table: apply PR-A, then the forward migration, then assert
     version 1;
   - version 1 with the ledger row: passes as is;
   - anything else: REFUSE.
9. **Receipt.** The verifier writes `polis-unflip-rehearsal-receipt/1`, and
   the worker validates it with the closed decoder before it leaves the box.

## Refusals

A REFUSE means the production day does not proceed. Fix the cause, then run
a fresh rehearsal on a fresh snapshot.

| condition | where | outcome |
|---|---|---|
| snapshot older than 36 h | operator check/restore; worker preflight | `SNAPSHOT_STALE` |
| a copy tagged with this box exists | every probe launch, any kind | `REHEARSAL_INSTANCE_REMAINS` |
| the ledger's last cleanup for a run is unconfirmed | every probe launch, any kind | `CLEANUP_UNCONFIRMED` |
| free storage (allocation minus all databases and WAL) below `min_free_storage_gb`, or unobservable | worker | `STORAGE_HEADROOM` |
| restore class/storage differ from the job | worker | `RESTORE_SHAPE` |
| registry template | operator restore (before any RDS call) and launch | `PLACEHOLDER_IMAGE`, `PLACEHOLDER_DIGEST` |
| migration, DDL or queries digest mismatch | operator restore and launch; worker | `*_DIGEST` |
| a tagged instance that is not one of the two fixed copies in the rehearsal group | operator cleanup | not deleted; reported; launches refuse |
| server not 17.x, superuser session, convention not at version 0 | worker | `SERVER_VERSION`, `SUPERUSER_SESSION`, `CONVENTION_STATE` |
| the copy marker cannot be set on the copy | worker | `COPY_MARKER` (before any other write) |
| lock wait above `lock_wait_budget_ms`; wall time above 90 min | worker | `LOCK_BUDGET`, `WALL_BUDGET` (the transaction rolls back) |
| an assertion inside the migration fails | worker | `MIGRATION_FAILED` (nothing committed) |
| the re-run is not refused by the guard | worker | `RERUN_NOT_REFUSED` (PR-I must not ship) |
| a post assertion fails, including a pca2, export or math case missing on either leg (every certification conversation and every sampled conversation must be present PRE and POST) | verifier | the assertion is named `FAIL` |
| cleanup fails | operator | the ledger records it; every later launch refuses; the instance identifiers are printed for deletion by hand |

## The receipt

`polis-unflip-rehearsal-receipt/1` has these top-level fields:

```text
schema, kind, job_sha256, run_id, mode, verdict ∈ {PASS, REFUSE, INCOMPLETE},
snapshot_sha256, snapshot_age_s,
restore: {duration_s, storage_growth_s, class_ok, storage_ok, free_storage_gb_before},
convention_ddl_applied,
pre / post: {conversations, participants, votes, votes_latest, agg_sha256, hashes_sha256,
             pca2_cases, pca2_sha256, math_zids, math_sha256, exports_sha256, lsn_before_sha256},
migrate: {wall_s, wal_bytes, max_lock_waiters, max_lock_wait_ms, heap_growth_bytes,
          index_growth_bytes, dead_tuples_after, counts_mirrored, vacuum_s},
rerun_refused, rerun_sqlstate_class,
assertions: {aggregates, hashes, pca2, math, exports, convention_version, insert_roundtrip}
            each ∈ {PASS, FAIL, NOT_COLLECTED},
restore_rule ∈ {PASS, REFUSE, NOT_RUN}, refusals: [closed names], cleanup_confirmed
```

`PASS` requires all of the following:

- no refusal;
- every assertion `PASS` (in `dry` mode: aggregates, hashes and the
  convention row; the others `NOT_COLLECTED`);
- the re-run refused;
- mirrored counts;
- lock and wall time within budget;
- a fresh snapshot;
- the restore shape as configured;
- the restore rule `PASS` when configured, `NOT_RUN` otherwise.

The decoder recomputes the verdict and refuses any other. The operator sets
`cleanup_confirmed` from the cleanup's outcome. The `receipt` subcommand
reports `window: ALLOWED` only for a `flip` PASS with a confirmed cleanup.

## Production day

The rehearsal's file is the production file, byte for byte; the receipt's job
binds its sha256. Print the file, its digest and its ledger checksum with:

```bash
python3 ci/probe_box/unflip_rehearsal.py --print-migration
```

Print the verification queries with the command below. The blocks marked
`(day)` are run on the box, never from a laptop, and compared with the
receipt. The `vote_insert()` round trip is **not** a production-day query:
on production it would overwrite a real participant's vote. It is printed
only wrapped in `BEGIN; … ROLLBACK;`, for rehearsal copies. The production
day checks the write path with one browser vote (P-078 §2c step 5).

```bash
python3 ci/probe_box/unflip_rehearsal.py --print-sql
```

## Tests

```bash
python3 -m unittest ci/probe_box/test_unflip_rehearsal.py                 # contract, receipt, operator
ci/probe_box/test_unflip_rehearsal.sh                                     # + the step machine on a throwaway PostgreSQL 17
```

The wrapper starts one PostgreSQL 17 container (`COMPOSE_PROJECT_NAME=p078h`,
port 5474, tmpfs) and removes it on exit. It builds the real migration chain
plus a generated fixture, then runs the held migration in both modes. The
cases cover:

- the re-run refusal and the restore rule;
- every assertion's failure path;
- every preflight refusal;
- the image phases as the worker sequences them.
