# P-053 step-2 image contents and admission

This slice implements BOARD [671]/[677]: one producer runs paired Clojure/Python
recordings over the admitted bundle, and a separately built verifier runs the
reviewed certify + G12 comparison (absolute 1e-6, relative 1e-4, zero outliers).
Stages are diagnostic only; recovery/consumption belong to shadow diagnostics.
A scoped PASS is not writer transfer or a complete retirement certificate.

**Integration dependency:** first apply the lossless-ingress change handed off
in BOARD [675]. This branch starts at #2762 and intentionally does not duplicate
that separate set of edits. The combined source must contain `event_ingress.py`,
the updated Python/Clojure drivers and certify's event metadata binding before
building or running the new tests. Public canaries use committed public CSVs;
private entries require authoritative events.jsonl and metadata.

## Source and runtime closure

- `runtime.Dockerfile` composes the already reviewed, preloaded Linux ARM64 OS,
  numerical Python and Clojure/JVM images. All three inputs must use immutable
  repository@sha256 references. It copies only dependency paths; no package
  manager, download or dependency resolution runs during the build or replay.
  Review the numerical `/usr/local` tree, Java, Maven jars and the single baked
  resolved classpath before pinning this runtime. It is a dependency image, not
  the candidate/oracle source. No Postgres service is needed by paired replay.
- `clojure-offline.py` accepts only `-M:replay`, reads the single baked classpath,
  selects its pinned jars under `/opt/m2`, and runs the staged math source. It
  never invokes Maven. The runtime must provide `/usr/bin/python3` and
  `/opt/venv/bin/python` plus the locked numpy/scipy/sklearn/pandas closure.
- `recipe.py` enumerates the explicit public source closure: replay/math code,
  strict admission and battery/schema/schedule definitions, public fixture CSVs,
  gate and accepted G12 implementation. `g12.py` copies the reviewed Q25 metric
  core and its 17 controls, without its host-specific CLI/enumerator.
- `stage.py` checks every listed file against both the reviewed source commit
  and its SHA256; producer engine files additionally match candidate/oracle
  commits. Only those bytes enter a fresh context. Ambient `.git`, `.local`,
  virtualenvs, credentials, symlinks and private extraction data are excluded.
- `Dockerfile` installs the source-only context as root-owned files, selects the
  fixed launcher and UID/GID 65534, and clears the runtime's command. The launcher
  checks the entire payload file census and hashes before invoking the gate with
  isolated Python imports. Rebuild the verifier from its independently reviewed
  checkout/recipe; never copy the producer's output into a verifier build.

The image lock records **OCI manifest digest**, **configuration digest**, and
**archive SHA256** separately. Docker's image ID is the configuration digest,
not the OCI manifest digest. Runtime dependencies, source commits, role, gate and
policy are bound in the reviewed recipe. The supervisor's signed runtime digest
binds the canonical image lock, which binds both recipes and the review receipt.

## Prepare a release build

Run each role from a reviewed committed source checkout. The reviewer can use a
separate source commit for verifier code while binding the same candidate/oracle/
policy tuple. An uncommitted implementation cannot be labeled with a base commit.
These commands only illustrate local preparation; they do not authorize a cloud
build, private staging or publication.

```sh
python3 ci/private_cert/images/recipe.py --source "$SOURCE" --role producer \
  --candidate "$CANDIDATE_SHA" --oracle "$ORACLE_SHA" \
  --policy-sha256 "$POLICY_SHA256" --runtime-image "$RUNTIME_DIGEST_REF" \
  --out /private/build/producer-recipe.json
python3 ci/private_cert/images/stage.py --source "$SOURCE" \
  --recipe /private/build/producer-recipe.json --out /private/build/producer-context
```

Repeat from the independently reviewed verifier source with `--role verifier`.
Review `build.json` (recipe, Dockerfile and launcher hashes) for each context.
Build/export each independently using the preloaded runtime, `--network=none`,
`--pull=false`, `--platform=linux/arm64`, and build arguments `RUNTIME_IMAGE`,
`IMAGE_ROLE`, `RECIPE_SHA256`. Export a single-platform OCI archive without
attestations/index extras. If the local Docker driver cannot export OCI, save
exactly one image and use `export_oci.py --docker-archive IMAGE.tar --out IMAGE.oci.tar`;
it preserves config/layer bytes and deterministically creates the OCI manifest.
Load the final archive in the admitted Podman builder and check that its actual
manifest/config digests match. Never substitute a mutable tag or pull at boot.

`image_admission.py` hashes every referenced blob and uncompressed layer, checks
ARM64/configuration, and verifies the final source overlay against the reviewed
recipe and launcher. It rejects unreferenced blobs, ambiguous indexes, source
whiteouts/links, wrong entrypoints, ambient environment and incomplete controls.
Its required independent review artifact is:

```json
{"schema":"polis-private-image-review/1","recipeSha256":{"producer":"RECIPE_SHA256","verifier":"RECIPE_SHA256"},"gateReviewSha256":"REVIEW_ARTIFACT_SHA256","controls":{"missing-evidence":"PASS","forged-evidence":"PASS","truncated-evidence":"PASS","short-inventory":"PASS","wrong-input":"PASS","wrong-policy":"PASS","stale-checkpoint":"PASS","candidate-control-isolation":"PASS"}}
```

Placeholders above must be replaced with actual SHA256s. The reviewer records
observed synthetic canary results, not a receipt synthesized from image labels.
Run the controls against the final images; hashes alone cannot establish source
review, canary completion or independence.

```sh
python3 ci/private_cert/image_admission.py \
  --producer-oci /private/build/producer.oci.tar \
  --verifier-oci /private/build/verifier.oci.tar \
  --producer-recipe /private/build/producer-recipe.json \
  --verifier-recipe /private/build/verifier-recipe.json \
  --review /private/build/review.json --out /private/build/image-lock.json
```

Pass `PRIVATE_CERT_IMAGE_LOCK` to `bake.sh`. The bake requires canonical JSON and
hashes it plus the admission checker into `runtime-lock.json`. Signed admission
uses the actual manifest digests as `runnerImage` and `verifierImage`. Before
fetching any fixture, the worker checks the signed runtime binding and both
preloaded Podman images' digest, configuration ID, OS/architecture and launcher
contract. The independent reviewer CLI requires `--image-lock` and
`--runtime-lock` and performs the same preflight for its verifier before download.

## Bundle plan and executable ABI

The uncompressed fixture tar contains only regular files, in this layout:

```text
plan.json
manifest.json
config.json
payload/<opaque-role-directory>/events.jsonl
payload/<opaque-role-directory>/events.meta.json
payload/<other files listed by the extraction manifest>
```

Use the owned extraction's original manifest/config/payload; `prepare()` calls
both fixture verification and admission, including census, polarity and opaque
role bindings. A reviewed `plan.json` has exactly:

```json
{"schema":"polis-private-paired-plan/1","scope":"private","manifestSha256":"SHA256","configSha256":"SHA256","entries":[{"dataset":"BATTERY_ALIAS","schedule_id":"BATTERY_SCHEDULE_ID","role":"CONFIG_ROLE","directory":"MANIFEST_ROLE_DIR","schedule":{}}]}
```

`entries` must contain the complete battery scope (`public`, `private` or `all`),
not a subset. `schedule` is the complete reviewed ScheduleSpec with fresh explicit
cuts from this actual event stream. Entry count, checkpoint count, moderation,
restart, Clojure options and coverage must preserve the battery recipe. Private
entries must cover the full stream. An allowed public prefix needs its full-stream
companion. Historical CSV cuts cannot silently truncate new lossless inputs.

`plan.py --fixture DIR --candidate SHA --oracle SHA --out inputs.json` validates
that already reviewed plan and derives the actual schedule/inventory digests and
expected paired-checkpoint count for signing. It does not select roles, choose
new cuts, run engines, sign or upload. This planning command needs the same locked
Python dependencies and combined source as the gate. Do not hand-invent the
inventory digest or use producer output to establish expected checks.

The producer accepts `produce` with `/fixture:ro`, `/run-spec:ro`, `/output:rw`.
`inputs.json` contains only candidateSha, oracleSha, policySha256, scheduleSha256,
inventorySha256 and expectedChecks. `/admission` must be absent. Output must be
fresh; engines run serially with no recording cache. It retains original fixture
bytes, every raw step, schedule, logs, process exits, peak child RSS and output
size. The supervisor contains credentials/control and records collector failure.

The verifier accepts `verify` with `/evidence:ro`, `/admission:ro`, `/verdict:rw`.
It independently derives inputs/checkpoints, verifies the complete file census
and all engine exits, and applies certify + G12. Its receipt schema is
`polis-private-gate/2`; `negativeControlsSha256` binds the actual controls JSON.
The details include each entry's comparison and stage diagnostic. Raw checkpoint
controls reject missing, forged, truncated and short evidence, in addition to the
17 G12 controls. An exception yields INCOMPLETE with zero checks. Public output
and cleanup still follow the separate supervisor/reviewer protocol.

The host uses no network, read-only container root, no capabilities, no new
privileges, fixed unprivileged user, bounded temporary storage/memory/processes,
and disjoint mounts. Both images contain reviewed comparison code; the candidate
has no access to the verifier process, mounted control record or verdict output.
Actual Podman/AMI isolation, lifecycle/IAM canaries, private capacity and cleanup
receipts remain mandatory before private activation.

## Local validation scope

Run `python -m unittest discover -s ci/private_cert -p 'test_*.py' -v` with the
combined reviewed ingress/image source and Delphi dependencies. This covers OCI
closure/admission, transport, controls and real bundle intake with synthetic role
metadata. Full public image canaries run both engines and two independent
verifier invocations offline on ARM64. Retain failed runs and control receipts.
Development snapshots are not release pins: the second reviewer's canary recipes explicitly
carry an extra `development` field and synthetic commit values, which the release
recipe validator rejects. Local Docker canaries do not substitute for the actual
admitted Podman host, signed boot or private data execution.
