# Python 3.12 ARM64 login layer

This recipe supplies the existing `ProvisionLogin` Lambda with psycopg2 and
`/opt/rds-ca.pem`. It assembles the pinned maintainer-provided Linux wheel into
`python/`, retains its bundled native libraries and license notices, and puts
the pinned public RDS CA bundle at the archive root. It does not compile
psycopg2 from source, install a database login, publish a layer or call AWS.

`lock.json` pins the ARM64 AWS Lambda Python 3.12 image by manifest and config
digest, psycopg2-binary 2.9.13 by exact cp312/Linux/ARM64 wheel and SHA256, and the
RDS global CA bundle by SHA256, byte size and certificate count. The output ZIP
is also pinned to the digest obtained from two identical clean builds. The deployed
runtime remains `PYTHON_3_12` / `ARM_64` in `cdk/probeBox.ts`.

From the repository root on Linux/macOS, with Python 3.10+ and a local Docker daemon:

```sh
python3 -B ci/probe_box/layer/build.py \
  --output /private/tmp/probe-login-layer-a \
  --cache /private/tmp/probe-login-layer-cache
python3 -B ci/probe_box/layer/build.py \
  --output /private/tmp/probe-login-layer-b \
  --cache /private/tmp/probe-login-layer-cache --offline
cmp /private/tmp/probe-login-layer-a/polis-probe-login-python312-arm64.zip \
    /private/tmp/probe-login-layer-b/polis-probe-login-python312-arm64.zip
```

Both output directories must be new and separate from the cache and Lambda
source directory. The first invocation fetches only the public pinned wheel,
CA and runtime image; a cached mismatch refuses instead of being replaced.
`--offline` requires all three already present. Assembly and native verification
run with networking disabled, read-only roots, no capabilities, only explicit
file mounts and temporary writable directories. Each local container is removed.
No host cloud credentials or Docker socket are mounted.

The ZIP uses sorted entries, fixed timestamps/permissions and uncompressed
storage, so neither source mtimes nor compression-library changes alter it.
The output includes the ZIP, `.sha256`, member digests and `build-receipt.json`.
A receipt is written only after a fresh pinned-runtime process extracts the ZIP,
checks ARM64 ELF headers, imports the native adapter and actual provisioner,
and loads every pinned CA certificate. A failed build directory must not be
published. Source changes during assembly refuse a receipt.

## Operator publication under SSO

After reviewing the committed recipe and local receipt, print the exact command
with the operator's profile and target region:

```sh
python3 -B ci/probe_box/layer/publish_command.py \
  --artifact-dir /private/tmp/probe-login-layer-a \
  --profile YOUR_SSO_PROFILE --region us-east-1
```

This only prints a checked command. It neither reads the SSO profile nor runs
AWS. The printed command has this shape, with the actual artifact path and
SHA256 filled in:

```sh
aws lambda publish-layer-version \
  --profile YOUR_SSO_PROFILE --region us-east-1 \
  --layer-name polis-probe-login-python312-arm64 \
  --zip-file fileb:///private/tmp/probe-login-layer-a/polis-probe-login-python312-arm64.zip \
  --compatible-runtimes python3.12 --compatible-architectures arm64 \
  --description 'Python 3.12 ARM64 probe login; sha256:THE_VERIFIED_ZIP_SHA256' \
  --query '{LayerVersionArn:LayerVersionArn,CodeSha256:Content.CodeSha256}' \
  --output json --no-cli-pager
```

The operator runs that command in the authorized SSO session. Compare returned
`CodeSha256` with the expected base64 hash printed above the command. Put the
returned versioned `LayerVersionArn` into the private configuration's
`postgresLayerArn`. No ARN is invented by the build. Publication is a separate
operator action; no deployment or connection to a primary/replica occurs here.

Updating the runtime, wheel or CA requires changing the reviewed pins and
rebuilding twice and reviewing the resulting ZIP digest. An old archive pin
refuses a changed result and reports its actual candidate digest; it never
automatically updates the pin. The CA URL can rotate while this recipe stays pinned; changed
bytes correctly refuse until a reviewed update. Native libraries (including
libpq/OpenSSL) arrive together in the pinned wheel and must be updated together.
Local import/CA checks and local SQL rehearsals do not prove target RDS access.

References: [Lambda Python layer layout](https://docs.aws.amazon.com/lambda/latest/dg/python-layers.html),
[Lambda Python image/architecture](https://docs.aws.amazon.com/lambda/latest/dg/python-image.html),
[psycopg2 2.9.13 distribution](https://pypi.org/project/psycopg2-binary/2.9.13/),
[RDS trust bundles](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html),
[publish-layer-version](https://docs.aws.amazon.com/cli/latest/reference/lambda/publish-layer-version.html).
