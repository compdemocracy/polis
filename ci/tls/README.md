# TLS trust regression checks

The [October 2026 disclosure](https://emudhra.we-have-a-problem.com/) identifies
compromised eMudhra intermediate keys and their Sectigo cross-signs. The public
certificate fixtures come from that disclosure's `chains.zip` and `roots.json`,
retrieved 2026-10-21. They contain certificates only, never private keys.

Run the same entry points locally and in hosted CI:

```sh
python3 -m unittest discover -s ci/tls -p 'test_*.py'
bash ci/tls/check-images.sh
cd cdk && npm ci && npm test -- --runInBand dbBackupLambda
```

OpenSSL 3, Python 3.11+, Docker with named build contexts, and the toolchains
needed by the final images are required. Set `OPENSSL` if OpenSSL 3 is not the
default executable. Builds and Lambda wheel installation need package-network
access. Certificate checks themselves are offline. All audit containers run
with `--network=none`; Node handshakes use container-local loopback only.
No application, job worker, database or production endpoint is started.

`check_trust.py` checks exact SHA-256, SPKI and serial identities for all sixteen
intermediate objects. Each effective PEM store must reject all sixteen with an
issuer/trust error using `-purpose any`, isolated roots and disabled time checks.
Four objects are code-signing intermediates: a TLS-usage failure would not prove
distrust. Separately, all twelve published direct/cross-signed TLS leaf chains
must fail for trust, with expiry disabled. Stale roots must accept all sixteen
objects and twelve leaf chains in the regression controls, and fail the gate.
Empty/truncated stores and affected objects installed as anchors fail as well.

The native checks add evidence beyond exporting stores to host OpenSSL:

- Node's real TLS handshake accepts a generated local chain, rejects it with
  `CERT_REVOKED` after its intermediate is added using Node's test-only hook,
  then accepts it after that test entry is cleared. Each affected object is
  also sent alongside an untrusted local chain: all sixteen must return
  `CERT_REVOKED` from the **compiled** blocklist, without injecting those keys.
  This tests Node's documented peer-chain fallback, not a forged affected leaf
  chain. The unaffected untrusted control must return the ordinary issuer error.
  Temporary test keys are generated for each run and removed afterwards.
  See the [upstream native callback and test hooks](https://github.com/nodejs/node/commit/4342503fd8).
- Python's actual HTTPX and stdlib SSL contexts, plus requests/certifi/botocore
  bundle paths, are validated with the image's native libcrypto. The probe
  worker declares its smaller boto-only dependency set explicitly. The checker
  requires that libcrypto and Python ssl report the same OpenSSL version.
  Generic path verification disables time checks and does not select TLS EKU;
  every store rejects sixteen objects, while isolated stale roots accept them.
- Java uses its own PKIX validator and final `cacerts`, with revocation-network
  lookups disabled and a fixed date within each object's validity. Every object
  must fail with `NO_TRUST_ANCHOR`; old roots must accept the same objects. There
  is no TLS EKU restriction that could hide code-signing trust.

The matrix builds final server `prod`, Delphi `final` (CPU dependency option,
including the real `polis-jobs` binary and RDS bundle), math `runtime`, nginx,
migration-carrying Postgres, API, migrator, OIDC, coordinator, file-server, three
standalone client images and the local probe base/worker. Commentgraph is not
built or deployed; its legacy recipe remains an optional named audit.
No base/trust-only stage substitutes for a shipped runtime. The daemon's
`--version` check establishes presence/loadability, not database connectivity.
No numerical/model integration or deployed-image equivalence is claimed.

`TLS_IMAGE_TAG` selects an isolated tag prefix. `TLS_IMAGE_SELECTION` can select
one or more of the named groups in `check-images.sh`; unset means every required
group. Use `TLS_IMAGE_SELECTION=commentgraph` to audit the legacy recipe.
Hosted CI assigns a group to each native arm64 runner to bound disk use and
match the probe recipes. An x86 local builder needs arm64 emulation for probes. The matrix regression
tests require all fifteen shipped configurations and the daemon/RDS audit, and
check that the optional legacy audit remains selectable.
Remove only your own image tags and build outputs after local checks.

Node 22.23.4 / 24.22.1 update NSS roots and block the compromised intermediate
keys. certifi 2026.10.19 removes the affected roots. The CLI locks webpki-roots
1.0.10 and rustls-webpki 0.103.16; its separate tests check anchors and the twelve
TLS chains with old roots supplied. The legacy nginx and Java images explicitly
remove affected roots. Maintained Alpine/Debian versions are checked against
the advisory floor. RPM stores are verified by their actual certificate paths,
not by assuming a release-pinned package command updated them.

Rebuild and replace running images and CLI binaries. An OS update does not
change embedded Node or Rust stores. Deployments must separately audit mounted
CA files, Java truststore overrides, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE/
SSL_CERT_DIR, REQUESTS_CA_BUNDLE and AWS_CA_BUNDLE. `--rds-only` is reserved for
the coordinator, whose TLS client disables system roots; it is inappropriate
for a client which also trusts public roots. Backup Lambda packaging retains
`--require-hashes` and tests the real platform-specific pip invocation and the
included certifi bundle. Existing host/AMI/CodeDeploy/browser stores and already
issued CLI binaries require their own update and effective-store verification.
Neither certificate-verification bypasses nor served certificates are changed.

### Temporary Amazon Linux probe blocklist

The local probe base fingerprint-matches every affected parent root present in
its extracted TLS, email and object-signing bundles against the four roots in `distrust.json`, writes those
certificates to `/etc/pki/ca-trust/source/blocklist/`, then runs
`update-ca-trust extract`. It retains the pinned runtime packages. The required
probe base and worker gates audit the system alias and extracted TLS, email and
object-signing PEM bundles, plus the worker's Python stores. Stale-root controls
remain required; removing a certificate by its display name is not sufficient.

This is temporary while Amazon Linux 2023 `ca-certificates` is awaiting its
[CVE-2026-113470 fix](https://explore.alas.aws.amazon.com/CVE-2026-113470.html).
The affected package observed on October 22 is
`2025.2.76-1.0.amzn2023.0.3`; no fixed version is published yet. Watch that
advisory for the first fixed AL2023 package and its repository release. Once
available, pin the fixed package/release, remove the Dockerfile helper copy/run
and `distrust-ca.py`, and rebuild from a clean base without the local blocklist.
Require the full trust gate to pass, including every affected-object refusal
and stale-store control; a numerically newer package alone is insufficient.
Remove the helper-specific unit test in that same replacement change, retaining
the final-image and stale-store tests.

After merge, the release operator must rebuild and republish the probe base,
record its new digest, and update/readmit the approved digest-pinned inputs.
Running this local gate does not publish an image or update an approved digest.
