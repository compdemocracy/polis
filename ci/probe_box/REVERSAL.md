# PostgreSQL 17 reversal fixture rehearsal

`reversal_rehearsal.py` owns two fresh local Compose projects, reads the existing
public roles-census seed through the restricted reader, validates receipt/3, and
restores that catalog layout into a second database. It never accepts a remote
DSN. Existing project containers, networks or volumes cause refusal. Only its
own projects are torn down, including on failure.

Run with an existing Python environment containing psycopg2 and a locally
available `postgres:17.11` image:

```sh
COMPOSE_PROJECT_NAME=p027-reversal-review \
POLIS_RECOVERY_PG_PORT=55548 RECOVERY_PG_PORT=55548 \
REVERSAL_EVIDENCE_DIR=/tmp/reversal-review \
python -B ci/probe_box/reversal_rehearsal.py
python -B -m unittest discover -s ci/probe_box -p test_reversal_fixture.py -v
```

Reserve both the specified port and the following port. The driver uses
`--pull never`, owns `<project>-source` and `<project>-target`, and refuses
pre-existing resources bearing either Compose project label. The source database
is seeded once; its census reader remains read-only. No production data or
credentials are accepted. No schema migration file is modified.

`reversal_fixture.restore(connection, receipt, job, settings_presence=True)` is
the reviewed builder core. The caller must provide an idle connection to its
owned loopback `probe_test` database on PostgreSQL 17. This function is not a
connection factory or a sandbox for arbitrary externally supplied database
connections. The driver establishes container ownership before calling it.

The census intentionally omits passwords, column types, routine bodies,
configuration values, application rows and production migration provenance.
Consequently this is a **layout reconstruction**, with explicit qualifications:

- Reviewed `SHAPE` supplies the seed's object definitions; unknown object shapes
  are refused. Receipt metadata is never executed as arbitrary SQL.
- Role attributes, database attributes, owners, PostgreSQL 17 membership options
  and grantors, ACLs/default ACLs and constant TRUE/FALSE policies are restored.
  All equality checks happen before committing. Existing passwords are refused;
  none are created. Extra roles/default ACLs and incompatible DEFAULT ACL or
  role-validity baseline representations are refused.
- Configuration values cannot be reconstructed. The explicit presence profile
  supplies an inert `application_name` setting to match permitted presence/count
  metadata. It does not reproduce original configuration behavior. Omitting
  this opt-in rejects a census containing settings.
- Equality is first established with the original restricted census projection.
  Only then are the unchanged application migrations before 000021 installed as
  a separate prerequisite. Thus the migration-21 test baseline is the restored
  fixture **plus** reviewed application schema, not a claimed copy of a live DB.
- Migration 000021 up/down files run unchanged through psql. Up replay, down
  replay and another up/down cycle are checked independently.

Evidence contains the validated public receipt/job, a closed residue report,
check results and command exit records. `polis-reversal-residue/1` has exact
keys `schema`, `verdict`, `classification`, `families`, `changes`; verdict is
`PRESERVED` or `RESIDUE`, classification is `NONE`, `ACL_REPRESENTATION_ONLY` or
`CATALOG_LAYOUT_CHANGED`. Each of the twelve fixed census families reports
added/removed row counts and typed identities with ADDED/REMOVED/CHANGED and
changed field names. No arbitrary SQL, passwords or setting values are emitted.

The seeded baseline currently produces **RESIDUE / ACL_REPRESENTATION_ONLY**:
`math_main`, `math_ticks`, `math_bidtopid` and `math_ptptstats` retain explicit ACL
catalog arrays instead of their original DEFAULT/NULL representation after
down. Expanded privilege grants are equal; no role or object is left by the
coordinator migration. The second down and the repeated up/down cycle preserve
that same residual state. The report intentionally does not call it exact
catalog preservation. Production reversal remains `NOT_EVALUATED`.
