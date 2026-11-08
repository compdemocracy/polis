# Client error triage

Client reports become structured server log events with `message = "client_error"`.
The log fields are `client`, `build`, `page`, `kind`, `error_message`, `stack`,
`resource`, `method`, `status`, `duration_ms`, `signature`, `count`, and `user_agent`.
Fields unrelated to an event can be empty. Kinds are `error`, `unhandledrejection`,
`console_error`, `console_warn`, `fetch`, `xhr`, `resource`, and `csp`.
The signature is 16 lowercase hexadecimal characters; each report's `count` is
an integer from 1 through 1000. A signature groups repeated occurrences, so use
``sum(`count`)`` when ranking frequency. Counting log lines undercounts repetitions.

Choose the log groups and time range in Logs Insights. These queries assume
the structured fields are discovered at the top level of each JSON log event.

## Top signatures across clients

```text
filter message = "client_error"
| stats sum(`count`) as total_count,
    latest(error_message) as error_message, latest(resource) as resource,
    latest(status) as status, latest(page) as page, latest(stack) as stack,
    earliest(build) as first_build, latest(build) as latest_build
  by signature, client, kind
| sort total_count desc
| limit 10000
```

The client column separates `alpha`, `admin`, `report`, and `participation`.
For one client, filter by its exact name; this example selects the report:

```text
filter message = "client_error" and client = "report"
| stats sum(`count`) as total_count,
    latest(error_message) as error_message, latest(resource) as resource,
    latest(status) as status, latest(page) as page, latest(stack) as stack,
    earliest(build) as first_build, latest(build) as latest_build
  by signature, client, kind
| sort total_count desc
| limit 10000
```

## Hourly and daily signatures

```text
filter message = "client_error"
| stats sum(`count`) as total_count,
    latest(error_message) as error_message, latest(resource) as resource,
    latest(status) as status, latest(page) as page, latest(stack) as stack,
    earliest(build) as first_build, latest(build) as latest_build
  by signature, client, kind, bin(1h) as period
| sort total_count desc
| limit 10000
```

```text
filter message = "client_error"
| stats sum(`count`) as total_count,
    latest(error_message) as error_message, latest(resource) as resource,
    latest(status) as status, latest(page) as page, latest(stack) as stack,
    earliest(build) as first_build, latest(build) as latest_build
  by signature, client, kind, bin(1d) as period
| sort total_count desc
| limit 10000
```

Time bins use the log event timestamp. Counts collected before a client flush
are attributed to the arrival bin; they do not reconstruct occurrence times.
These queries and the renderer rank the largest signature/bin combinations
across the selected range, rather than selecting N rows separately for each bin.
The optional client filter also works with either time query.
See the [Logs Insights stats reference](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-Stats.html)
for sums and time bins.

## Compare across builds

The queries above retain precise report signatures. Browser deduplication keeps
bundle line and column, stripping only the filename's content hash. Different errors
in one minified bundle therefore remain separate log events and default rows.

Inline-only reports instead carry a projected page marker without line or column:
server-rendered content can change both. These markers cannot identify an inline
source statement and do not split when preload sizes or template offsets change.
Distinct inline-only bugs in the same category on one page share one signature: the browser sends the first occurrence and counts the rest.
On `/:id` pages, single-segment third-party script frames (including analytics and Cloudflare) show the same page marker as our inline code.
When bundle frames exist, they take precedence over document frames, including
inline fetch/XHR wrappers. Historic reports keep their stored signatures; compare
changed categories across deployment by client, kind, error message and page.
The broader query below includes only content-hashed bundles; it excludes document
markers (and any older document-coordinate records).

For an explicit broader view of content-hashed bundles in Logs Insights:

```text
filter message = "client_error"
| parse stack /^(?<top_frame>[^\r\n]+)/
| fields coalesce(top_frame, resource) as location
| parse location /^(?<bundle>.*)\.[A-Za-z0-9_-]{8,}(?<extension>\.(?:js|mjs|css))(?::\d+:\d+)?$/
| filter ispresent(bundle)
| fields concat(bundle, extension) as group_location
| stats sum(`count`) as total_count, count_distinct(signature) as position_signatures,
    latest(stack) as stack, latest(resource) as resource, latest(page) as page,
    earliest(build) as first_build, latest(build) as latest_build
  by client, kind, error_message, status, group_location
| sort total_count desc
| limit 10000
```

This view includes only content-hashed locations and intentionally combines
positions within each bundle/category. `position_signatures` shows how many
precise signatures contribute (Logs Insights may approximate large distinct
counts). Inspect the precise query before treating a broad group as one defect.
Add `bin(1h) as period` or `bin(1d) as period` to `by` for time bins, or add a
client condition to the filter. Named captures and string functions follow the
[parse reference](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-Parse.html)
and [function reference](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-operations-functions.html).
This query still needs execution against the intended log group before use.

For the same broader view offline, export a **precise** query above and use:

```sh
queue-rs/target/debug/render-client-errors results.json --group-builds --top 20
```

The renderer groups by client, kind, status or error category, hash-stripped
bundle name and optional period; only hashed bundles lose offsets. Plain scripts
and rows without diagnostic fields retain their precise signatures. It sums
counts before ranking and prints `GROUP_SIGNATURE`, `GROUP_LOCATION`, and
`POSITION_SIGNATURES`. The group hash uses the documented signature algorithm
with that broader location. The latter count is the number of input signature
rows combined, not a count of source-code defects. Limits or truncation upstream
still make it incomplete. The original export remains the per-position record.

In this offline view, representative diagnostics and first/latest build values
come from one deterministic input row, selected by its ordered fields. They do
not claim to be the earliest/latest across the combined group: the export lacks
per-row event timestamps. The table says this explicitly. Use the Logs Insights
view for chronological build endpoints. The broader query above is for viewing
in Logs Insights; the renderer takes the precise export, not its grouped output.

## Render an export locally

Export a completed query as CSV, or save its JSON field/value results. Then run:

```sh
cargo build --locked --manifest-path queue-rs/Cargo.toml --bin render-client-errors
queue-rs/target/debug/render-client-errors results.csv --top 20
queue-rs/target/debug/render-client-errors results.json --top 50
cat results.json | queue-rs/target/debug/render-client-errors - --top 20
```

The binary uses the existing Rust workspace dependencies. It reads local files
or stdin and does not contact a service. It accepts a JSON array of rows, each an
array of `{"field": "name", "value": "text"}` objects, or an object containing
that array as `results`, matching the [GetQueryResults response](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_GetQueryResults.html).
CSV needs the headers `signature`, `client`, `kind`, `total_count`, with optional
`period`. The representative columns are `error_message`, `resource`, `status`,
`page`, `stack`, `first_build`, and `latest_build`; missing values display as
empty cells. Other fields are ignored. JSON exports use those same field names.

The table shows count, client, kind, signature, optional period, the representative
message/resource/status/page/stack, and the first/latest build values. Sorting is
numeric by descending count with deterministic ties. `--top` accepts 1 through
1000, defaulting to 20. Control characters, non-ASCII text, and table/HTML
delimiters are escaped; displayed cells are limited to 120 characters. The message
and stack columns contain the already projected diagnostic values from the
server log. Unknown fields, including `@ptr`, are not printed.

Malformed input, duplicate fields or summary groups, invalid signatures or
kinds, missing required values, mixed presence of `period`, and invalid counts
produce exit status 2 without a partial table. Counts must be positive integers
no larger than 9223372036854775807; summed totals may exceed 1000. Input is
limited to 16 MiB and 10000 rows. A response object with an unfinished status or
a nonempty `nextToken` is rejected. Bare arrays and CSV contain no completeness
metadata: ensure the query has completed before exporting. A query limit or
upstream truncation can omit groups; the tool only ranks the supplied rows.

Run the offline tests with:

```sh
cd queue-rs
cargo test --locked
```

The renderer integration tests run in the existing Rust CI command above. The
fixture test sums the `count` values of local JSON log events (7 + 1000 = 1007,
rather than two log lines), compares those totals to a completed GetQueryResults
shaped export, and renders that export. This is offline arithmetic and export
validation; it does not run the Logs Insights parser or verify a live log group.
The queries still need a read-only execution against the intended log group
before operational use. Backticks explicitly name the `count` field.

Representative values are the latest available value for each field, so they
may come from different events in a group. First/latest build values follow log
event timestamps, not lexical build order. They show the endpoints of the
selected time range, not every intervening build.
