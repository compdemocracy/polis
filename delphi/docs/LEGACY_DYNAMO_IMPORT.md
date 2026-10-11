# Import a local DynamoDB export

`scripts/import_dynamo_export.py` moves a bounded, checksummed export into a
normal Postgres graph job. The worker verifies source bytes, codec version,
worker code, importer code and runtime; normal queue finalization stores its
immutable artifact and M28 result rows together. No historical job executes.

The export command requires an explicit loopback endpoint and only uses dummy
local credentials. It never falls back to an AWS endpoint. Specify every family
to export with repeated `--family` arguments. The exporter reads all scan pages
and writes the frozen `delphi-storage-codec/1` files and `SHA256SUMS`.
Keep the source quiescent during export. Consistent scan pages do not provide
a transaction snapshot across a whole table or all families; checksums verify
the completed export but cannot detect changes between scan pages.

```sh
python scripts/import_dynamo_export.py export-local /tmp/generated-export \
  --endpoint http://127.0.0.1:8000 \
  --family Delphi_CommentEmbeddings --family Delphi_NarrativeReports \
  --family Delphi_JobQueue --family Delphi_JobActiveGuard
python scripts/import_dynamo_export.py preview /tmp/generated-export \
  --zid "$DEMO_ZID" --report-id "$DEMO_REPORT"
python scripts/import_dynamo_export.py enqueue /tmp/generated-export \
  --zid "$DEMO_ZID" --report-id "$DEMO_REPORT" --env local-demo --scope import-demo
```

For enqueue, `QUEUE_DATABASE_URL` must use a queue executor login.
`DATABASE_URL` supplies read access to verify that every explicitly named
report belongs to the selected conversation. Preview is offline; it checks
explicit source bindings but cannot verify the live reports mapping. Neither
command remaps conversation IDs or report IDs. Mixed-conversation exports fail.

The `delphi` worker claims `graph_narrative` and runs the declared
`legacy-dynamo-export/1` model. Repeating the same enqueue returns the same
graph. Source, code or runtime changes produce a new request; an active scope
still prevents overlapping admission. Admission does not publish the result.
After successful execution, publication uses the ordinary explicit
`pd_graph_publish` generation check, so a failed import cannot replace a report.
The approved core contract does not support replacing a failed graph with a
superseding branch; that capability is deferred to #1436. The importer exposes
ordinary admission, status verification and publication only.

Every source row is counted as one of:

- Imported result rows in the 18 M28 result families.
- Archived T15/T16 job and guard rows in `legacy_control_files`, with exact
  codec bytes on the immutable artifact. They are never converted to current
  jobs, active scopes, leases or provider submissions.
- Quarantined result rows containing NUL strings/keys, which JSONB cannot
  represent. Their exact codec bytes and `postgres-jsonb-nul` reason remain in
  `quarantine` on the immutable artifact. Binary zero bytes are valid base64
  codec data and are imported normally.

Unknown families, duplicate/noncanonical keys, missing/changed/unlisted files,
wrong conversation/report bindings and oversized artifacts fail before enqueue.
The initial importer is bounded to 450,000 serialized output bytes and the
queue's existing input limit. It refuses larger exports without truncation;
large archives need a separate artifact transport. It processes result values
as tagged codec values, preserving decimal numbers, sets, binary values and
JSON stored as strings. It does not read, write or reinterpret stored votes.
