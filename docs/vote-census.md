# Vote census (`vote-census/1`)

A read-only measurement job in the existing probe framework. `COMPLETE` means the whole aggregate inventory was collected and verified. It does not mean the data is healthy, establish which sign means agree, authorize migration seeding, or authorize a flip. Empty databases are a complete census with zero counts.

## Source and launch contract

The job uses `polis-probe-job/2`, `kind=vote-census`, and a `polis-probe-receipt/3` receipt with `version=vote-census/1`. Three separately admitted images execute `read`, `produce`, and `verify`. The existing worker seals the job, loads manifest-pinned images, gives only the reader the replica socket, gives the producer no job mount, mounts the original projection read-only to the verifier, validates the closed receipt, and publishes through the existing encrypted result transport. No worker sandbox, network, IAM, grant, or export-size allowance is broadened.

`run_spec` contains the reviewed source commit and exact SQL SHA256. The reader checks the shipped SQL before connecting. The job's source pin, the reader projection, the verifier's own source recipe, image hashes, policy hash, and job digest must agree. The registry admission checks the three source closures, recipe hashes, SQL hash, immutable OCI manifest/config bytes, and separate launcher. Existing image launchers remain byte-identical.

The repository entry is an unlaunchable template: all-zero images and source. Replace it only with the output of `ci/private_cert/images/vote_census_registry.py` after reviewed source staging and independent image review. Do not paste guessed image pins. Per run replace only `run_id`; the source and SQL remain bound.

The reader requires PostgreSQL 17, `pg_is_in_recovery()=true`, session/current user `polis_probe_reader`, no broad role attributes or other role memberships, `REPEATABLE READ READ ONLY`, SELECT on the six ordinary public tables, no write authority or ownership, no RLS, and no inherited/partitioned replacements. Missing access returns `NOT_VISIBLE`; a primary returns `NOT_REPLICA`. Failures have no partial counts and never turn into zero-valued success. Error/statement text never enters the receipt.

The six tables are `votes`, `votes_latest_unique`, `comments`, `participants`, `conversations`, `math_main`. The job never provisions a login or grants itself access.

**Current deployment:** there is no production read replica. The existing probe reader login and the socket called `replica` connect to the primary under the 2026-09-10 ruling. This release therefore returns `NOT_REPLICA` there, before any census SELECT. Neither an endpoint name nor read-only permissions change that fact. There is no automatic fallback. The two alternatives and the separate grant decision below require an operator ruling before launch.

Budget bounds: 600 seconds per statement, 1 second lock wait, 1800 seconds per transaction, 30 seconds idle in transaction, 16 MiB `work_mem`, 2400-second job ceiling. These are refusal ceilings, not expected durations. `row_security=off` prevents silent policy filtering. The reader issues fixed SELECTs plus session settings and always rolls back/closes. It creates no functions, tables, temporary tables, indexes, or extensions. PostgreSQL may spill internal sort/hash work; a replica query can be canceled by recovery. Such cancellation produces incomplete evidence. The actual data volume and query-plan load still require operator assessment on the replica before a launch is approved.

## Exact measures and interpretation

`ci/probe_box/vote_census.sql` contains ten named aggregate statements, in one MVCC snapshot. The session/privilege SELECTs are fixed in `vote_census_reader.py`. Output is 5254 fixed integer counters (inventory generated from `vote_census.METRICS`), no row ids, row text, SQL, raw labels, or per-conversation lists. Runtime validation requires every expected metric exactly once, integer type (no booleans), nonnegative range, cross-section totals and the 128 KiB receipt bound. `vote_census_receipt.schema.json` describes the closed structural shape; the Python validator additionally enforces arithmetic and job/image bindings.

1. **Stored values and years:** both tables use `neg=-1`, `zero=0`, `pos=+1`, `null`, `other`; none imply semantics. `votes.created` and `votes_latest_unique.modified` are Unix milliseconds, bucketed in UTC. Years 1970–2100 are explicit; missing timestamps and out-of-range dates have separate buckets. `all` is the total by value. Total rows also appear in `sizes`.
2. **Author-first-vote witness:** join `(comment.zid, comment.tid, comment.pid)` to the same vote triple. The author is the comment's participant, not any voter or globally matching pid. Use earliest non-NULL timestamp; if any author-vote timestamp is missing, the comment is `unknown_time`. Multiple first-time rows count once if unanimous, otherwise `ambiguous`; no physical-order tie break is invented. `none` means no author vote. A later vote changes the first value only when the first value is unambiguous and timestamp ordering known; NULL is a value for this comparison. Return changed comments, distinct author participants `(zid,pid)`, and distinct conversations. These are not unique human-account counts across conversations.

   Conversation buckets cover every conversation row plus any comment-only orphan conversation. `all_neg`/`all_pos` require at least one first signed vote and no opposing, pass, NULL, out-of-domain, ambiguous or unknown-time first vote. Missing author votes are tolerated but exposed in `bucket_value:*:none`. `mixed` contains signed witness data disqualified by those other observations. `none` contains no usable signed first vote, including conversations without comments; its value breakdown prevents confusing missing evidence with unanimous evidence. Overall and bucket-specific first-value counts and conversation denominators are all explicit. Even a unanimous production witness does not prove every undeclared fork's convention. Threshold decisions must name denominator, minimum support, missing coverage and tie exclusions; this job does not set them.
   **Non-zero witness (`witness_nonzero`):** separately exclude seed comments, split native/imported by `original_id IS NULL`, and stratify by the comment's UTC creation year. Select the earliest author vote in {-1,+1}, ignoring earlier passes and NULL values. Count each comment once; opposite values at its first non-zero timestamp are tied, while duplicate equal signs are unanimous. A missing timestamp on any non-zero vote makes ordering unknown. Missing timestamps on pass/NULL votes do not affect non-zero ordering. Invalid values alone are not called pass/NULL. This extends the preflight's five classes with explicit uncertainty, avoiding false sign evidence on damaged data.

   Keys are `year:cohort:class:measure`. Year is 1970–2100, `u` unknown, `x` out of range, `a` all years; cohort `n` native or `i` imported; class `n` no author vote, `p` pass/NULL only, `t` tied, `-` first non-zero minus, `+` first non-zero plus, `u` unknown non-zero ordering, `o` out-of-domain-only (possibly mixed with pass/NULL). Measure `c` counts comments, `z` counts distinct conversations. Conversations can appear in several classes/years; overall conversation counts are deduplicated, not added across years. `excluded_seed` and `excluded_unknown_seed` disclose both exclusions. Compact keys keep the closed receipt within its existing 128 KiB cap. No presentation threshold, sign declaration or migration behavior is implemented.

3. **NULLs:** row and distinct-conversation counts for both tables; ages relative to the transaction clock: future, under one day, one day to 30 days, 30 to 365 days, older, unknown. Additional counters expose latest NULLs with earlier non-NULL history and historical NULLs followed by non-NULL votes. This measures prevalence and the keep-versus-clear decision surface; it does not change any loader's behavior. The separate kebab-only group-cluster counter under `math` addresses the restore-shape question; it cannot prove the geometry is inverted.
4. **Latest-cache disagreement:** maximum timestamp per raw vote triple. Missing either side is a definite discrepancy. For known ordering, a cache value outside *all* tied latest values is a definite value discrepancy; timestamp mismatch is counted separately. Matching one of conflicting tied latest values is compatible, not proof of an ordering. Ties, conflicting values and any missing raw timestamp are separately disclosed. `definite_disagreement` is the union of missing-side/value/time discrepancies, not the sum of overlapping counters. Weights are outside this vote-value comparison. The cache update rule follows insertion order; a timestamp discrepancy can reflect backdated insertion, not necessarily corruption.
5. **Repeated votes and changes:** `changes` reports multirow triples, distinct-value changes, extra rows, maximum rows per key, and row-count histogram. `transitions` separately reports actual adjacent value changes in timestamp order (including NULL); it excludes an entire triple with unknown times or conflicting same-time values. Duplicate unanimous rows do not add changes. Its histogram and explicit eligible/excluded denominators prevent treating every repeated insert as a changed vote.
6. **Orphans:** both vote tables count missing `(zid,tid)` comments, `(zid,pid)` participants, and conversations. `any` is their union. No global tid/pid join or row list is emitted.
7. **Math:** row counts and ages of each `(zid,math_env)`'s newest modified blob; `prod` and `python` are named, all other labels aggregate as `other`, with a separate NULL bucket. Unknown labels remain separate internally for selecting their newest row; their strings never leave SQL. Count distinct conversations whose newest vote exceeds either blob `modified` or input `last_vote_timestamp`, and conversations with votes but missing prod/python blobs. Unknown clocks are explicit. Data is cast to JSONB for key checks so both JSON and JSONB column profiles work; only counts of non-object payloads and kebab-only group-cluster keys leave. No payload content or hash is exported.
8. **Sizes:** exact snapshot row counts plus `pg_relation_size` (main heap), `pg_table_size` (heap/TOAST/forks), indexes and total bytes. Physical sizes are observations made during the transaction, not MVCC-frozen measurements and not a free-disk/WAL/lock-duration measurement. They do not by themselves set a safe flip budget.

## Operator sequence

1. Independent source review: SQL semantics, every fixed counter, closed boundary, replica refusal and generated-fixture tests. The maintainer commits the reviewed file set. No real database identifiers/data belong in that commit.
2. Against that reviewed commit, run `vote_census_recipe.py` for each role using a separately reviewed digest-pinned ARM64 runtime containing the required Python/psycopg2 closure. Run the normal `images/stage.py`; it refuses untracked or uncommitted bytes. Build the three source-only contexts offline with network disabled and without pulling. Do not reuse another job's image digest.
3. Independent reviewer checks OCI source/config closure and role isolation, exercises reader/producer/verifier and refusal controls, then supplies `polis-vote-census-image-review/1` containing exactly `recipeSha256` for reader/producer/verifier and `reviewSha256`. Use `vote_census_registry.py` with all three archives/recipes and this review to generate the concrete registry entry. Review/commit the pins.
4. Owner publishes admitted images, rebakes the worker with updated `contracts.py`, `receipt.py`, and new `vote_census.py` (the normal bake copy-list includes it), and rolls the same source/policy into the operator. SQL and entrypoints belong only in image closures; no reader SQL needs installing on the host. Existing sealing, CLEAN/wipe, provenance and launch-template admission still apply. Roll forward as one reviewed group; an older host/operator refuses the new kind.
5. Owner verifies the actual replica endpoint, role grants and load budget; Colin approves launch after independent review. Run through the existing `ci/probe_box/run.py` publish/launch/watch/receipt lifecycle and the established probe operator runbook. No raw SQL execution or data download from the laptop; no primary fallback.
6. Revalidate saved receipt with `receipt.decode_receipt(raw, admitted_job)`. Require `kind`, version, job/source/SQL/image pins, every control true, `status=COMPLETE`, `verdict=COMPLETE`. Otherwise retain the closed incomplete status; do not infer absent data. Export only this bounded receipt through the existing result path. Keep all normal cleanup/CLEAN evidence.
7. Use counts to propose witness thresholds and resolve NULL questions in separate decisions. This census does not amend migration 000025 (the vote convention), loaders, the flip tool, or any existing hold.

## Read-location decision (separate from source acceptance)

**Option A: temporary RDS physical read replica (recommended).** These are operator instructions to use only after the read-location ruling; this job creates no infrastructure. Use a same-Region, private PostgreSQL 17 replica, `db.t3.large`, **40 GiB gp2**, the source's existing DB subnet group and **the same DB security group**. Its existing probe-worker ingress and group-based egress then apply without adding a network rule. Verify the source has automated backups, encryption and no incompatible pending change; stop if those prerequisites or the reviewed source storage size differ. Creating the replica takes a source snapshot and can suspend I/O on a single-AZ source. Schedule that impact explicitly. [RDS creation requirements](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.Create.html).

Use the approved operator profile/Region. Populate `CENSUS_SOURCE_DB`, `CENSUS_DB_SG`, and `CENSUS_DB_SUBNET_GROUP` privately from the source's current description; none is a credential, but real deployment identifiers do not belong in the repository. The names below designate only newly created temporary resources and must be unused. Save the source's replication-slot inventory before creation using the SQL below.

```sh
CENSUS_REPLICA_DB=polis-census-tmp
CENSUS_REPLICA_PG=polis-census-replica
: "${CENSUS_SOURCE_DB:?set the approved source identifier}"
: "${CENSUS_DB_SG:?set the existing source DB security group}"
: "${CENSUS_DB_SUBNET_GROUP:?set the existing source DB subnet group}"

aws rds create-db-parameter-group \
  --db-parameter-group-name "$CENSUS_REPLICA_PG" \
  --db-parameter-group-family postgres17 \
  --description 'Temporary vote census replica only'

aws rds modify-db-parameter-group \
  --db-parameter-group-name "$CENSUS_REPLICA_PG" \
  --parameters \
    'ParameterName=temp_file_limit,ParameterValue=4194304,ApplyMethod=immediate' \
    'ParameterName=hot_standby_feedback,ParameterValue=0,ApplyMethod=immediate' \
    'ParameterName=max_standby_streaming_delay,ParameterValue=-1,ApplyMethod=immediate' \
    'ParameterName=max_standby_archive_delay,ParameterValue=-1,ApplyMethod=immediate' \
    'ParameterName=max_parallel_workers_per_gather,ParameterValue=2,ApplyMethod=immediate'

aws rds create-db-instance-read-replica \
  --db-instance-identifier "$CENSUS_REPLICA_DB" \
  --source-db-instance-identifier "$CENSUS_SOURCE_DB" \
  --db-instance-class db.t3.large \
  --allocated-storage 40 --storage-type gp2 \
  --db-subnet-group-name "$CENSUS_DB_SUBNET_GROUP" \
  --vpc-security-group-ids "$CENSUS_DB_SG" \
  --no-publicly-accessible --no-multi-az --no-deletion-protection

aws rds wait db-instance-available --db-instance-identifier "$CENSUS_REPLICA_DB"
aws rds modify-db-instance --db-instance-identifier "$CENSUS_REPLICA_DB" \
  --db-parameter-group-name "$CENSUS_REPLICA_PG" --apply-immediately
aws rds wait db-instance-available --db-instance-identifier "$CENSUS_REPLICA_DB"
aws rds reboot-db-instance --db-instance-identifier "$CENSUS_REPLICA_DB"
aws rds wait db-instance-available --db-instance-identifier "$CENSUS_REPLICA_DB"
aws rds describe-db-instances --db-instance-identifier "$CENSUS_REPLICA_DB" \
  --query 'DBInstances[0].{Endpoint:Endpoint.Address,Class:DBInstanceClass,GiB:AllocatedStorage,Storage:StorageType,Encrypted:StorageEncrypted,Public:PubliclyAccessible,Groups:DBParameterGroups,SecurityGroups:VpcSecurityGroups,Source:ReadReplicaSourceDBInstanceIdentifier,Pending:PendingModifiedValues}'
```

The create command deliberately omits `--db-parameter-group-name`: the CLI's supported-engine list for specifying a group during replica creation excludes PostgreSQL DB instances. Attach the replica's **own** group with `modify-db-instance` and reboot **only the replica**, as in AWS's PostgreSQL example. Confirm its parameter status is `in-sync` and the SQL values below match; an `available` waiter alone does not prove parameter application. No census begins before that check. [Create command](https://docs.aws.amazon.com/cli/latest/reference/rds/create-db-instance-read-replica.html), [PostgreSQL replica parameter-group sequence](https://aws.amazon.com/blogs/database/using-delayed-read-replicas-for-amazon-rds-for-postgresql-disaster-recovery/).

`temp_file_limit=4194304` is **4 GiB per process**, not a job-wide quota; at two gather workers plus the leader the allowance can total 12 GiB. Allocate 40 GiB and verify free space for that allowance, database growth, retained WAL and other activity. The scale run below exercises the same 4 GiB/process cap and two-worker maximum. It is a cancellation guard, not a reservation or a guarantee that production plans fit. Keep the replica dedicated to this one census. [PostgreSQL temp-file limit](https://www.postgresql.org/docs/17/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-DISK).

PostgreSQL 17 permits `-1` for both standby delays: replay may wait for the bounded census snapshot instead of cancelling it. Confirm RDS accepts these values and reports them on the replica. If its parameter range rejects `-1`, stop for a reviewed alternative; do not silently retain the default 30-second delays. The 1800-second transaction and 2400-second worker ceilings still apply. `hot_standby_feedback=off` avoids extending the primary's vacuum horizon through feedback, but replay lag and source WAL retention can still grow. Monitor replica lag/storage and source slot/WAL/storage; cancel the census and clean up if approved limits are approached. [Standby delay and feedback semantics](https://www.postgresql.org/docs/17/runtime-config-replication.html#RUNTIME-CONFIG-REPLICATION-STANDBY).

The existing `polis_probe_reader` login, password verifier, role settings and table grants replicate physically from the primary. Do **not** run the provisioner on the replica. The separately approved allowlist change and SELECT grant below must be made on the primary, then replayed before validation. Keep the same reader secret; do not rotate it as part of endpoint selection. Verify catch-up with an operator-captured post-grant source WAL position and the replica's replay position. Through the approved SQL access path, check as the restricted reader:

```sql
SELECT current_user, session_user, pg_is_in_recovery();
SELECT pg_last_wal_replay_lsn(), pg_last_xact_replay_timestamp();
SELECT has_table_privilege(current_user, 'public.votes_latest_unique', 'SELECT');
SELECT name, setting, unit, pending_restart FROM pg_settings
WHERE name IN ('temp_file_limit', 'hot_standby_feedback',
               'max_standby_streaming_delay', 'max_standby_archive_delay',
               'max_parallel_workers_per_gather');
```

Require recovery true, both users `polis_probe_reader`, SELECT true, 4 GiB cap, feedback off, both delays -1, gather maximum 2, and no pending restart. Save the prior private `PROBE_BOX_CONFIG` and operator outputs. Change only its `replicaHost` to the new endpoint, retain `replicaSecurityGroupId` as the existing DB SG and retain `primaryHost` for provisioning. The authorized infrastructure owner reviews the `ProbeStack` diff and redeploys it with the established `enableProbeBox=true` context, then refreshes operator outputs (`REPLICA_HOST`) and the boot DNS/TLS allowlist. Confirm the TLS identity is the actual new RDS hostname. Do not reuse stale launch/boot data. No primary stack or network rule change is needed for this endpoint roll.

**Cost allowance: about $0.50–$1** for the temporary operation, subject to actual billed lifetime and the regional quote. This uses the saved 2026-10-03 us-east-1 Single-AZ db.t3.large input of $0.145/instance-hour, plus 40 GiB gp2 at $4.60/month prorated; it is a budget input, not a completion-time estimate or a price cap. Include creation, validation and cleanup in billed lifetime, plus any chargeable transfer/backup/I/O and T3 surplus CPU credits. Confirm current regional pricing before approval. [RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/).

**Teardown, including failures:** stop the job and require normal worker CLEAN evidence. Restore the saved probe configuration, review/redeploy `ProbeStack`, refresh the prior operator/boot outputs and verify no worker still targets the temporary endpoint. Then the operator deletes only the named temporary instance (never promote it):

```sh
aws rds delete-db-instance --db-instance-identifier "$CENSUS_REPLICA_DB" \
  --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier "$CENSUS_REPLICA_DB"
aws rds delete-db-parameter-group --db-parameter-group-name "$CENSUS_REPLICA_PG"
```

Verify there is no retained automated backup or census snapshot requiring cleanup, and record deletion. As an authorized DBA on the **primary**, compare this query with the saved pre-creation inventory, then verify free storage/WAL retention recovers:

```sql
SELECT slot_name, slot_type, active, restart_lsn, wal_status,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_replication_slots ORDER BY slot_name;
```

A new inactive physical slot after deletion is not successful cleanup. Have the DBA identify its ownership and use the supported RDS cleanup/support path; never drop an unrelated slot by guess. The reader gains no slot-management permissions and this job performs none of these operations.

**Option B: explicitly approved primary read.** This release refuses it. A separate primary-bound policy would retain REPEATABLE READ READ ONLY, **180-second statements** as its own stop limit, 1-second lock wait, 1800-second transaction ceiling, 16 MiB work memory and all grant/role checks. Its statement limit therefore differs from this replica policy's 600 seconds. Read-only prevents application writes; it does not make the load negligible. Ten scans/aggregations over the vote/history tables and math TOAST compete for disk, cache and CPU. One busy backend can occupy half of a two-vCPU db.t3.large; parallel workers can consume the remainder. A roughly 5% average baseline is not reserved spare capacity; compare cycles have higher peaks. The snapshot delays vacuum, and ACCESS SHARE can delay DDL. T3 credits can incur charges.

The last recorded primary storage observation was **12.3 GB free on 2026-09-28, on a 20 GiB gp2 volume**. That is historical, not a current free-space check; obtain fresh FreeStorageSpace before any ruling or launch. The prior local run wrote **13,484,721,849 bytes cumulatively** to temp files. Its peak was unmeasured. Cumulative writes are not simultaneous occupancy; deleting/recreating spills can write much more than the space held at once. The new peak measurement below applies only to its generated fixture and plans.

A full volume can make production data/WAL writes fail, causing PostgreSQL PANIC/restart and an RDS `storage-full` outage on this single-AZ primary. Cancelling only the census after the fact does not undo that outage. Storage autoscaling is not a spill safeguard: low space must persist before it acts, and its growth cannot be shrunk in place. [PostgreSQL disk-full behavior](https://www.postgresql.org/docs/17/diskusage.html), [RDS autoscaling limitations](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIOPS.Autoscaling.html).

`polis_probe_reader` cannot SET `temp_file_limit`; do not grant it that privilege. The primary uses a default parameter group, which is immutable. The supported configuration path here is an approved custom primary parameter group with a temp cap, association with the primary, and **a primary reboot** to apply the newly associated group (a single-AZ outage). Dynamic edits after a custom group is already active are a different case. Do not assume an untested role-level override by `rds_superuser` removes this dependency. Pair any cap with a reviewed `max_parallel_workers_per_gather=0` policy if it is intended as a whole-query bound, and repeat the scale acceptance at that cap/settings. [RDS parameter groups](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Parameters.html), [new-group reboot requirement](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithParamGroups.Associating.html).

This alternative requires a **reviewed code change**: change the reader's `NOT_REPLICA` refusal, `validate_projection()`'s COMPLETE-implies-replica condition and `POLICY_SHA`'s replica-required flag together, preserving truthful `replica=false`; use the primary-specific limits and update success/refusal tests, docs and schema/policy bindings. Prefer an explicitly primary-bound policy that also refuses replicas, retaining this replica policy intact. Rebuild/review/admit all three images and roll host/operator modules. Retain closed errors and no partial counts. Name fresh free-space/spill headroom, application-latency/CPU/credit stop limits, a maintenance window and an operator cancellation path. This release implements none of these relaxations.

### Local scale measurement

The generated scale fixture contains **19,000,000 votes, 435,000 comments and 18,705,000 latest rows**. PostgreSQL 17.11 ran with a 2-CPU/8-GiB limit, 16 MiB work memory, two gather workers maximum, a 4 GiB/process temp cap, and the exact replica-policy SELECTs in one read-only repeatable-read transaction. All ten statements passed the 600-second statement and 1800-second transaction limits; their cumulative measured SQL time was **173.712 seconds**. This local-only timing harness uses a restricted role on its disposable primary; separate physical-standby tests exercise the product reader, which still refuses a primary.

**Peak observed simultaneous temp occupancy: 3,451,641,856 allocated bytes (3.215 GiB), during `latest`.** Peak logical file lengths were 3,451,543,451 bytes. This differs from **13,484,721,849 cumulative temp bytes written** (786 files) across the run. These are measured figures, not expected cloud durations or a production disk budget.

| Statement | Measured seconds | Peak sampled allocated temp bytes |
|---|---:|---:|
| values | 26.629 | 1,003,487,232 |
| witness | 7.056 | 205,893,632 |
| witness_nonzero | 6.102 | 152,354,816 |
| nulls | 2.808 | 0 |
| latest | 57.521 | 3,451,641,856 |
| changes | 17.860 | 785,612,800 |
| orphans | 5.247 | 0 |
| math | 1.328 | 0 |
| sizes | 0.479 | 0 |
| transitions | 48.682 | 1,898,561,536 |

The sampler recursively inspected the disposable container's `base/pgsql_tmp`, including parallel shared filesets, summing both logical lengths and `st_blocks × 512` for all live regular files. No other tablespace or workload used that volume. It took **14,492 samples**, sleeping 10 ms between directory scans; the largest observed start-to-start gap was **59.200 ms**, and the longest scan was 41.038 ms. Ten entries disappeared during scans as PostgreSQL removed them; these races were counted, with no sampler errors. Initial and final occupancy were zero. The retained raw JSONL supports independent recalculation.

This is a **sampled high-water observation, not an upper bound**: scans are not atomic, brief peaks and open files already unlinked can be missed, and filesystem metadata is outside the regular-file totals. Construction warmed the local volume; the generated heap is in index-friendly order and lacks production arrival order, bloat, live traffic, gp2 throttling and recovery conflicts. A production plan may spill more. The result qualifies the fixture's peak only; retain the replica's 40 GiB allocation, per-process cap and storage/WAL monitoring, and do not infer that the primary's historical free space is sufficient.

## Separate grant decision

The minimal requested provisioner change is adding `'votes_latest_unique'` to `ci/probe_box/provision_login.py`'s `TABLES` tuple. The exact production grant is:

```sql
GRANT SELECT ON public.votes_latest_unique TO polis_probe_reader;
```

It needs its own ruling. Land the allowlist change and corresponding inventory tests/docs **before** applying the grant: the provisioner's effective-rights check rejects extra SELECT authority outside its allowlist. Rebuild its provisioning closure and have the authorized operator run it on the primary; the grant then replicates under option A. Recheck roles-census expectations. The grant is necessary under either option and does not approve a read location. This release changes neither provisioner nor grants.

## Test reproduction

Repository boundary and generated-data SQL tests are in `ci/probe_box/test_vote_census.py`; image admission tests are in `ci/private_cert/test_vote_census_images.py`. SQL tests opt in with `VOTE_CENSUS_LOCAL_TEST=1` and a `VOTE_CENSUS_FIXTURE` path generated by `vote_census_fixture.fixture()`/`seed()` on a disposable local PostgreSQL 17 primary and physical standby. Fixture data includes passes before signs, imports, seeds, tied and missing timestamps, out-of-domain values, NULLs, orphans and latest-cache disagreement. Only an isolated local test database may be seeded. The independent SQL oracle compares both witnesses; the product reader still refuses a primary.
