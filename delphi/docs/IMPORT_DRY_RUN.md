# Recognizable DynamoDB import totals on the existing Delphi box

Run the reviewed importer inventory once with the box's existing DynamoDB instance
profile and the running Delphi container's database connection. The report contains
one JSON line per conversation: internal `zid`, public `conversation_id`, every
public alias in `conversation_ids`, topic, first 120 description characters, stored
`conversations.participant_count`, and all 20 families' `source`, `would_import`,
`archive`, and `quarantine` counts. A final line gives per-family and grand totals.
The count is the stored participant count, not a new definition of active voters.
Missing display values remain null; duplicate aliases do not duplicate result rows.

Conversations with only quarantined results or controls are included. Rows whose
conversation cannot be verified have a separate `unmapped` line, never a guessed
identity. Both the per-conversation totals and grand totals conserve every source
row. Only the description is shortened; source records and result counts are exact.
The report escapes user text as JSON, including newlines and terminal controls.

This command has **no apply option**. It invokes only paginated Scan and
read-only PostgreSQL SELECTs; it never calls DescribeTable. Known family key
names/types are checked on every returned row by the codec. Empty tables have no
row keys to check; the report does not certify the live table schema. PostgreSQL sessions start with
`default_transaction_read_only=on` even when using an existing broad application
login. It preserves the deployed connection's explicit TLS configuration. Without
one it requires TLS; this path does not assert stronger transport verification
than the already deployed configuration. It never calls the queue, runs models,
publishes results, creates tables, or stops/restarts the existing service.

## Operator command (not executed by the implementer)

After review, place the merged source checkout containing this patch in a separate
source directory on the existing Delphi box. Use the ordinary operator file-delivery
path; do not redeploy or overwrite the active checkout just to run this inventory.
The launcher starts the **exact running Delphi image ID** with the reviewed
`delphi/` directory mounted read-only at `/opt/polis-import-source`; it builds and
pulls no image. Inherited mounts such as `/app/data` stay separate, so the reviewed
source needs no `data/` directory. No new AWS role, stack, secret or database login
is needed. It needs Docker and Python 3 on that box, and the current instance role
must already allow Scan on the 20 source tables. It uses IMDSv2
through host networking; static credentials/default MinIO keys in the old container
are not copied. An access failure refuses rather than provisioning new authority.

Set the existing instance ID and the absolute path of that reviewed checkout in
your operator shell. No production identifier belongs in the public repository.
The deployed service can be found by its Compose service label; exactly one running
`delphi` container is required. Set a new private output directory for each run.

```sh
export DELPHI_INSTANCE_ID='REPLACE_WITH_EXISTING_INSTANCE_ID'
export IMPORT_SOURCE_DIR='/opt/polis/import-report-reviewed'
export IMPORT_REPORT_DIR='/var/lib/polis-import-report-1463'
python3 - <<'PY' > /tmp/polis-import-report-ssm.json
import json, os, shlex
source = shlex.quote(os.environ['IMPORT_SOURCE_DIR'])
output = shlex.quote(os.environ['IMPORT_REPORT_DIR'])
commands = [
    'set -eu',
    'umask 077',
    'cd ' + source,
    'containers=$(docker ps -q --filter label=com.docker.compose.service=delphi)',
    'test "$(printf "%s\\n" "$containers" | sed "/^$/d" | wc -l)" -eq 1',
    'python3 scripts/run-import-dry-run.py --container "$containers" --region us-east-1 --output ' + output,
]
print(json.dumps({'commands': ['\n'.join(commands)], 'executionTimeout': ['3600']}))
PY
command_id=$(aws --profile polis-deploy --region us-east-1 ssm send-command \
  --instance-ids "$DELPHI_INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters file:///tmp/polis-import-report-ssm.json \
  --cloud-watch-output-config CloudWatchOutputEnabled=false \
  --query Command.CommandId --output text)
aws --profile polis-deploy --region us-east-1 ssm get-command-invocation \
  --command-id "$command_id" --instance-id "$DELPHI_INSTANCE_ID" \
  --query '{Status:Status,ResponseCode:ResponseCode,Output:StandardOutputContent,Error:StandardErrorContent}'
```

Repeat `get-command-invocation` until terminal; require Success and response code 0.
A successful SSM submission alone is not a successful report. The command format
uses the [SSM SendCommand parameters](https://docs.aws.amazon.com/cli/latest/reference/ssm/send-command.html).
SSM's inline output is limited: treat `$IMPORT_REPORT_DIR/report.jsonl` on the box
as the complete report, not the displayed prefix. Read it through your existing
private SSM session (`sudo cat /var/lib/polis-import-report-1463/report.jsonl`), or
page the file there. No S3/CloudWatch output destination is added. SSM still retains
inline output under its existing access/retention rules; it contains the private
metadata explicitly requested for recognition. Never paste it into GitHub or CI.

The private output directory (mode 0700, files 0600) also retains a runtime image/source receipt, an error log,
both censuses and exact control/quarantine archives. Verify `source = would_import
+ archive + quarantine` in every family. Quarantined identities require separate
resolution before any eventual apply/reader switch. Keep evidence on the box under
the existing operator retention policy. Cleanup consists only of this run's output
directory after review;
no live service or source table is changed.

Missing tables refuse unless explicitly named with repeated `--allow-missing
TABLE` on the launcher after checking the inventory; the report lists every allowed
missing table. Source changes between the two scans refuse.

The conversation and report mapping (`conversations.zid`, `reports.report_id`/`zid`)
is read before the first scan and again after the second. Conversations and reports
created during the run are accepted: the finished census is reopened as a resume,
which re-derives every row's binding under the newer mapping without reading
DynamoDB again, so rows for a conversation that appeared mid-run are counted under
it and a new conversation without rows adds nothing. A removed conversation or
report, or a report now bound to a different conversation, refuses. Either way
`stderr.log` carries one `identity mapping drift` line with added, removed and
changed counts (never ids). The report and the importer apply the same rule.

Rebinding only re-derives the binding of rows already scanned, so a conversation
whose result rows are written after this run's scan has passed their page is
accepted with nothing to bind and would otherwise be missed. Every mid-run
addition's identity is therefore recorded in `follow-up.json` inside the run's
attempt directory on the private mount (never relayed, never on stdout/stderr):
the added conversation zids and each new `report_id`→`zid`. The importer's own
stdout result gains a counts-only `follow_up` (`conversations`, `reports`) when
there are additions. Run the import again to pick them up; re-importing a
conversation already imported in the same run is idempotent (no duplicate rows).

Matching scans are an
inventory observation, **not** a transactional DynamoDB snapshot or permission to
apply while writers are running. The importer's per-run bounds (64 MiB per
family, 256 MiB per conversation) are the destination's result contract: the
queue daemon and the Postgres result functions accept no larger family or run.
The dry run never refuses on them. Every family is staged in full, without
truncation, and the report says which conversations would not fit: each
conversation row gets a `staging` object (staged bytes, `within_bound`,
`oversized_families` with their byte sizes, `batch_over_bound`), and the grand
totals get `staging` with, per family, the number of conversations past the
bound and their largest and total sizes. When any conversation is past a bound,
`stderr.log` also carries one `staging bound exceeded (reported, not refused)`
line with those counts and sizes (never ids), and the launcher repeats it. The
importer's own dry run adds the same aggregate as `staging`; with `--apply` it
still refuses at the first family past a bound, before anything is copied or
admitted. `stderr.log` contains the failure class and, for
the importer's own refusals, their fixed reason text (for example `import dry-run
refused (ValueError: source changed between census passes)`); any other message,
which could quote a source value, is withheld. The launcher repeats that line.
There is no automatic retry of a refused report.

## Read pacing, throttling and resume

Most source tables are provisioned at 5 read capacity units, and the box role
cannot call DescribeTable, so capacity is never discovered: the read rate is a
configured ceiling. Every census Scan (report and importer) is eventually
consistent, asks for `--scan-page-limit` items (default 25), and requests
`ReturnConsumedCapacity=TOTAL`; the next request waits until the units already
consumed fit `--max-read-units-per-second` (default 2, shared across all tables
and both passes). Throttling (`ProvisionedThroughputExceededException`,
`ThrottlingException`, `RequestLimitExceeded`) backs off exponentially with
jitter (0.5 s doubling to 30 s) for `--max-throttle-retries` consecutive attempts
(default 8), then the run **pauses** with exit code 3 instead of failing.

Each page's rows and the table's next `ExclusiveStartKey` commit together in the
attempt's census database under the output directory's `scratch/`. Rerun the same
launcher command with `--resume` and the same `--output` to continue: finished
tables are not read again and the interrupted table continues from its last
committed page. Resume refuses unless the image ID and source path match
`runtime.json`. Rows read before new conversations appeared are re-bound under the
current mapping, and both passes must still match before a report is written.
Eventually consistent pages make the two-pass comparison an observation of a
quiet source, as before; a write between passes still refuses. `stderr.log`
also carries one aggregate pacing line (pages, consumed units, throttles, wait).

## Local proof and retained importer

Hosted CI and local runs use exactly `bash scripts/test-production-import.sh`. It uses
DynamoDB Local and generated multi-conversation data, including pagination,
quarantine-only conversations, unmapped data, public aliases and description
truncation. It verifies every public PostgreSQL table before/after reporting,
the Dynamo source digest, read-only refusal for a broad login, and conservation.
The report runs through a loopback proxy that permits only Scan and explicitly
denies DescribeTable; all other DynamoDB operations are also denied. Missing tables
are detected by Scan; access denial and disappearance during pagination refuse.
It also reruns the reviewed staged import/daemon/idempotence regression
(`tests/production_import/proof.py`) in local test mode. The legacy `import_dynamo_production.py --apply` remains in that
reviewed importer; it is never selected by this launcher and production apply is
outside this task. That importer's table-schema preflight still requires
DescribeTable. The older dedicated-role/apply instructions in
`PRODUCTION_DYNAMO_IMPORT.md` do not apply to this existing-box dry-run path.
