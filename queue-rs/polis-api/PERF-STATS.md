# In-memory metrics read

`POLIS_API_PERF_STATS_READS=1` and `RUST_API_ROUTES=perfStats` opt in
independently. Both default off. GET and HEAD `/perfStats_9182738127`
return the existing empty JSON object while Node's in-memory collector is
hard-disabled. Revisit this contract before enabling metric collection.

The route uses no database, pool, lock, external service or background task.
It preserves the global HTTPS redirect, Express JSON framing and conditional
responses; this non-API path does not apply the API CORS middleware.
Queries, credentials, bodies and unsupported methods hand back to Node.
The shared nginx fallback applies before response headers only.

`conformance/perf-stats-run.sh` records complete unchanged-Node response bytes,
compares enabled Rust, and checks every request against a disabled process.
The contract and route tests cover the empty response and disabled admission.
