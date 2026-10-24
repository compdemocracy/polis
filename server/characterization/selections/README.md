# Topic selection write characterization

The source pin is `19873803fa2b84ddca841a50cfb57009650554de`. `cases.json` contains 164 requests through the unchanged Node application, including its authentication and participant middleware. `controls.json` contains 13 separately labelled scheduling, failure, token-wrapper and immediate topical-read observations. All inputs are generated fixtures.

`record.cjs` uses the released test schema, an isolated OIDC simulator, ephemeral participant signing keys and real SQL. Publication results and explicit query failures are controlled stand-ins. It refuses socket connections outside loopback and the reserved test ports. Run it only with an isolated `polis-test` database: PostgreSQL 58950, OIDC 58951, DynamoDB 58952, email 58953, S3 58954, and the temporary Node listener 58955. It deletes and recreates only its generated fixture conversation and identities. The ordinary test suite must not run against that database concurrently.

Use the normal server test environment with these service ports, `NODE_EXTRA_CA_CERTS` pointing at the test CA, and Node 22. Run `provider.cjs` inside the owned simulator and set `SELECTION_PROVIDER_TOKEN_FILE` to its generated JSON output. Never put that file, environment files or signing keys in a recording or commit.

From `server/`:

```
node characterization/selections/record.cjs /tmp/selection-cases.json characterization/selections/cases.json
node characterization/selections/control.cjs /tmp/selection-controls.json characterization/selections/controls.json
```

Each command fails on a difference. It preserves status, body bytes and ordered header names/values. It excludes Date, Connection and Keep-Alive from equality. A newly issued token is verified against the ephemeral public key and durable membership, then only its lexical token value is replaced; the issued identity, kind, expiration metadata and surrounding bytes remain observed. Content-Length and ETag are checked against the original bytes before being derived from the substituted bytes. User IDs allocated by the database are bound to generated participant/account labels in durable witnesses; application response IDs retain their original string/number shape. No response field or row order is silently sorted to resolve a mismatch.

The Node controls establish the non-atomic PUT insert race, lost first-response identity, committed mutation followed by an acknowledgement failure, lookup wait before mutation, and immediate topical nextComment. Wrapper-only controls are labelled: these routes themselves do not return arrays or non-JSON success bodies.

The Rust handler replays the corpus in the ordinary `polis-api` database tests, with regenerated verified credentials. It compares admitted status/headers/body exactly and checks all eight fixture tables remain unchanged after a hand-back. Its fixture database uses the published selection DDL and minimal parent tables; the mixed test separately uses the full released Node test database.

For that supplementary test, start `mixed.cjs` in the same isolated Node environment. It serves only unchanged Node routes and a generated fixture/public-key endpoint on loopback. From `queue-rs/`, set `POLIS_API_TEST_DATABASE_URL` to that database and `POLIS_SELECTION_NODE_ADDRESS=127.0.0.1:58955`, then run:

```
cargo test --locked -p polis-api --features db-tests mixed_node_and_rust_same_key -- --ignored --nocapture
```

The test drives concurrent Node HTTP calls and Rust route calls below HTTP. It starts no Rust listener, modifies no nginx map and activates no production switch. Stop the Node companion by its recorded PID after the test.

The implementation admits bounded JSON arrays and existing participants with verified anonymous/standard participant tokens. Other identities, cookies, XID/Treevite gates, input shapes and DynamoDB attribution remain Node's responsibility before mutation. A missing-row PUT also returns before mutation; an existing row is updated by one autocommit UPDATE RETURNING after lookup. Neither users nor participants are created. Errors or deadlines after a possible mutation are terminal 500, never a request to retry in Node. No migration is required.

Publication cases seal the backend, environment, scope and exact SQL parameters in each observation. The ambiguous case is unscoped: the captured query runs against two distinct scope rows. The scoped control uses the same rows with scope `first` and returns only its job. The Rust replay consumes the sealed configuration and enforces uniqueness on `(env,zid,scope_key)` in its publication fixture. These provider rows are explicit stand-ins, not a full job-pipeline run.

The lookup-wait control waits for an entered signal before inspecting the database. The topical-read control asserts the selected topic key and supplies a comment in a different cluster as a distractor.

Mixed proof retains the same-method concurrent waves and adds twelve forced cross-method schedules. Each Node and Rust request reaches an observed pre-statement barrier before either proceeds; both orders are exercised for all six different-method pairings. Exact response branch/body, final JSON, count and job attribution are checked, including Node PUT creation after deletion and all-column no-write hand-back snapshots. A further schedule parks Node after an empty UPDATE, lets Rust POST insert, and checks Node's subsequent INSERT fails without altering the Rust row. These are controlled overlapping requests; they do not certify unrestricted load or HTTP transport behavior.

Deadline and caller-loss checks use unique JSON and job markers and exact counts. A post-mutation hook runs only for a successful response, never an error or zero-row PUT. A separate fixture trigger parks an in-flight PostgreSQL write: the test observes `PgSleep`, confirms the new marker is not visible, loses the caller and verifies that exact write commits. No process-death, shutdown or lost-COMMIT transport guarantee is claimed.
