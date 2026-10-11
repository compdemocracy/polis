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

This command has **no apply option**. It invokes only DescribeTable, consistent
paginated Scan and read-only PostgreSQL SELECTs. PostgreSQL sessions start with
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
`delphi/` directory mounted read-only at `/app`; it builds and pulls no image. No new AWS role, stack, secret or database login
is needed. It needs Docker and Python 3 on that box, and the current instance role
must already allow DescribeTable and Scan on the 20 source tables. It uses IMDSv2
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
missing table. Source changes between the two scans refuse. Matching scans are an
inventory observation, **not** a transactional DynamoDB snapshot or permission to
apply while writers are running. The reviewed importer bounds (64 MiB/family,
256 MiB/conversation) also run before printing a successful report; oversized
sources refuse without truncation. `stderr.log` contains a sanitized failure class.
There is no automatic retry of a refused report.

## Local proof and retained importer

Hosted CI and mm5 run exactly `bash scripts/test-production-import.sh`. It uses
DynamoDB Local and generated multi-conversation data, including pagination,
quarantine-only conversations, unmapped data, public aliases and description
truncation. It verifies every public PostgreSQL table before/after reporting,
the Dynamo source digest, read-only refusal for a broad login, and conservation.
It also reruns the reviewed #1449 staged import/daemon/idempotence regression in
local test mode. The legacy `import_dynamo_production.py --apply` remains in that
reviewed importer; it is never selected by this launcher and production apply is
outside this task. The older dedicated-role/apply instructions in
`PRODUCTION_DYNAMO_IMPORT.md` do not apply to this existing-box dry-run path.
