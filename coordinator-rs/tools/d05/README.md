# Public reader transition rehearsal

This runs the actual application and Rust→Python publication bridge over all 21
migrations. It exercises six generated conversations through L→P→L using the
reviewed 000021 transition API. Four app processes cover reader replacement,
old client ETags, cold/warm/prefetched caches, reports, CSVs and authentication.
The fixed inventory has **501 assertions**, including deliberately failing
old-floor/undrained-reader/prior-bid-handler controls.

The fallback is a **coherent content-recovery fixture**. Its input rows come from
the pinned Python bridge and are installed as legacy-shaped rows for the reader
rehearsal. It is not a Clojure recomputation, a private science certificate, a
capacity result, or permission to transfer a live writer. Existing legacy
writers still require external exclusion under the isolated-shadow ruling.

## Run

Use the repository's provisioned Python environment and pinned Rust toolchain.
The cached characterization images `p027-server`, `p027-file-server`, and
`p027-oidc-simulator`, plus `postgres:17-alpine` and `amazon/dynamodb-local:latest`,
must already exist. The runner resolves their content IDs before starting any
service; it does not build or pull them.

Choose an unused project and a free contiguous range of 13 loopback ports:

```sh
export COMPOSE_PROJECT_NAME=p026-reader-transition-example
export POLIS_RECOVERY_PG_PORT=56600
export RECOVERY_PG_PORT=56600
python -B coordinator-rs/tools/d05/campaign.py --output /tmp/p026-reader-transition-example
```

For explicitly reviewed local edits, add `--allow-local-changes`; pass any
additional untracked source with `--local-file path/to/file`. The D05 harness's
own files are included automatically in local mode. Output must be outside the
checkout. The wrapper creates an attributed source snapshot, builds the fault
binary there, runs the profile, and verifies its final receipt. It retains the
snapshot and logs for review. No Git mutation is used.

All services share one internal Docker network. Bounded loopback/stdio relays
allow the host coordinator and HTTP driver to reach those containers without
giving the app an external network. Each run tears down only its own project.

Verify a retained result independently:

```sh
python -B coordinator-rs/tools/d05/verify.py /tmp/p026-reader-transition-example/results --controls
```

The verifier rejects missing, duplicate, reordered or failed cases, incomplete
cleanup, and artifact drift. Its five receipt controls are separate from the
501 database/HTTP assertions. The receipt binds source bytes, engine manifest,
compiled binary, image IDs, migrations, transition receipts, served bodies,
negative controls and cleanup. Its full-contract gate remains FAIL.

## What this establishes

- A login is bound to one namespace at startup and again at dispatch/publication;
  restricted Python credentials cannot lease or publish into L. Tests also cover
  the reverse namespace restriction on the mapped legacy control principal.
- A transition floor requires a fresh Python publication strictly above it,
  including unchanged input and zero ticks. Historical retention floors retain
  their inclusive meaning. Science fields survive this republication unchanged.
- Every serving replica is drained before its replacement namespace serves.
  The same OIDC owner token survives replacement. Participant credentials are
  also exercised; the characterization harness generates ephemeral anonymous
  signing keys per process, so this profile does not certify anonymous-key
  distribution across production replicas.
- Comparisons preserve the existing shape for each cache lifecycle. Cold and
  prefetched paths have different existing template behavior; they are compared
  with their respective pre-transition baselines. Only top-level column clocks
  are removed for the transition comparison, and those clocks are separately
  checked against the database and old client ETags.
- `/api/v3/bid` derives its mapping and cluster IDs from one admitted Bundle. A
  rotated mapping with a mismatched generation yields no assignment; the pinned
  prior handler returns the wrong cluster ID through the same real HTTP app.
- A comment-only moderation change, continuing HTTP vote intake, dormant
  conversations and imported durable rows all reach the publication path. This
  does not exercise external import storage or delivery services.

The required coordinator campaign remains separate. Run it for the adopted
rev6 source as well; these HTTP assertions do not replace its existing tests,
R12 schedules, uncertainty checks or build profiles.
