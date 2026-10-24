# Postgres report exports

`POLIS_API_REPORT_EXPORT_READS=1` and `RUST_API_ROUTES=reportExportPg` opt in
independently; both default off. The selector covers format.json, summary.csv,
comments.csv, votes.csv, participant-votes.csv, participant-importance.csv and
comment-groups.csv under `/api/v3/reportExport/:report_id/:report_type`.
The cluster export, feeds, S3 results and write routes remain outside it.

The initial admitted subset uses canonical GET/HEAD requests without query
parameters, credentials or bodies, at most 1000 comments and 1000 votes, bounded
text and a 1 MiB response. Streamed CSV requires absent Accept-Encoding or
identity encoding. Comments and votes require `TZ=UTC` to match Node's date
strings. Unsupported values, ambiguous identifiers, duplicate vote keys,
failures and timeouts hand back to Node before response bytes are sent.

Summary, participant and group exports currently admit only conversations with
no stored math_main row for the configured environment. Existing math exports
hand back. The no-math presentation retains the three-second approved-comment
count cache; it is local to this service. As with other process-local math
reads, cross-process cache warming and concurrent generation changes are not
claimed equivalent. Public conversation identifiers are read directly, without
introducing another reverse-ID cache.

`POLIS_API_REPORT_EXPORT_DATABASE_URL` supplies primary report-row and summary
URL resolution. `READ_ONLY_DATABASE_URL`, when set, supplies report-ID lookup
and export data, matching Node's report/read pool; otherwise primary is used. The deployment
must provide matching data and timezone to Node and Rust. Each independent
read-only pool has one slot, a 15 ms admission timeout and a 50 ms statement
timeout; the whole read has a 75 ms deadline. No participation pool, migration,
write, provider call or connection held across external work is introduced.

CSV keeps Node's ordering, quoting, newlines, historical vote counts and
importance behavior. Storage-to-export conversion belongs to the shared vote
convention module, including its legacy invalid/null behavior. The format
sidecar is pinned to the server's declaration fixture. Raw conformance compares
complete HTTP bytes against the unchanged Node handler, including streaming
chunks, compression boundaries, HEAD, conditional requests and disabled reads.
