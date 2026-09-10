# Certification probe images

These source/image admission tools build the certification reader/producer and
independent verifier for the [probe box](../../../docs/probe-box.md).
The old signed-admission, uploaded fixture archive and offline download verifier
workflow has been removed. Raw recordings and fixtures never leave the box.

`recipe.py` enumerates the reviewed public source closure. `stage.py` checks each
file against its source commit and SHA256, requires a fresh context, excludes
ambient/untracked data, and binds engine source to candidate/oracle commits.
`runtime.Dockerfile` uses reviewed preloaded ARM64 numerical/JVM dependencies;
no package resolution or network fetch occurs during replay. `export_oci.py` and
`image_admission.py` distinguish manifest, configuration and archive digests,
check every blob and source overlay, and require independent review/controls.
These build tools run after code review/commit; development tests cannot mint
release source identities. Keep producer and verifier builds independent.

The recipe entrypoint is `ci/private_cert/images/probe.py`. The fixed launcher
checks its source census and executes isolated Python with a closed argument ABI:

- Producer image `extract`: `/replica:ro`, `/output:rw`. The socket-only service
  reaches the fixed TLS read replica. One read-only snapshot creates the original
  owned bundle under `/output/.local/fixture` and its input bindings separately.
- Producer image `produce`: `/fixture:ro`, `/run-spec:ro`, `/output:rw`.
  Input/schedule digests precede fresh serial Clojure/Python execution. Output
  contains recordings/process receipts, never a copied fixture directory.
- Verifier image `verify`: `/fixture:ro`, `/run-spec:ro`, `/evidence:ro`,
  `/job:ro`, `/verdict:rw`. It independently re-admits fixtures, checks the exact
  checkpoint/file census, runs certify plus G12 and 21 failing controls, and
  writes only `polis-probe-receipt/1` to `/verdict/receipt.json`.

The closed receipt is an explicit projection of the local detailed gate report;
no nested raw report is serialized. Stages and recovery remain diagnostics;
this scoped result does not authorize writer transfer. The host validates the
receipt again before the only evidence upload. A future probe supplies a new
reviewed image/argv pair and the same closed receipt ABI.

Release recipe invocation remains:

```
python3 ci/private_cert/images/recipe.py --source "$SOURCE" --role producer \
  --candidate "$CANDIDATE_SHA" --oracle "$ORACLE_SHA" \
  --policy-sha256 "$POLICY_SHA256" --runtime-image "$RUNTIME_DIGEST_REF" \
  --out /private/build/producer-recipe.json
python3 ci/private_cert/images/stage.py --source "$SOURCE" \
  --recipe /private/build/producer-recipe.json --out /private/build/producer-context
```

Repeat from the independent verifier source with role `verifier`. Build/export
with no network/pull and linux/arm64; validate recipes, OCI digests and all image
admission controls before inserting real digest references into the probe registry.
An empty registry intentionally admits no jobs until that release work is done.
The legacy `plan.py` only validates a local original bundle and derives input
commitments; it grants no launch, data access, signature or export permission.
