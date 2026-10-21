# TLS trust regression checks

The [October 2026 disclosure](https://emudhra.we-have-a-problem.com/) identifies
compromised eMudhra intermediate keys and their Sectigo cross-signs. The public
certificate fixtures come from that disclosure's `chains.zip` and `roots.json`,
retrieved 2026-10-21. They contain certificates only, never private keys.

`check_trust.py` rejects affected anchors by SHA-256 and verifies that all twelve
TLS chains fail with an issuer/trust error. It disables certificate time checks
so expiration cannot hide a regression. Its verifier uses only the supplied
bundle, without the host trust store. OpenSSL 3 is required.

Run `python3 -m unittest discover -s ci/tls -p 'test_*.py'` for negative controls.
Run `python3 ci/tls/check_image.py IMAGE --node --rds` for the server,
`--python --rds` for Delphi, `--manual-distrust` for legacy nginx,
`--java --manual-distrust` for the legacy math image, and no flags for
Postgres/API images. Use `--rds` for the migration image.
The image check runs with networking disabled and does not start any service.
It checks fingerprints parsed inside Node for its effective default store,
including `NODE_EXTRA_CA_CERTS`, and
Python's actual certifi, requests and botocore bundle paths when requested.
HTTPX uses certifi by default; deployment-specific SSL_CERT_FILE/SSL_CERT_DIR,
REQUESTS_CA_BUNDLE and AWS_CA_BUNDLE overrides must be audited separately.

Node 22.23.4 / 24.22.1 update NSS roots and block the compromised intermediate
keys. certifi 2026.10.19 removes the affected roots. The CLI locks webpki-roots
1.0.10 and rustls-webpki 0.103.16: both the root removal and intermediate-key
block are required. Rebuild and replace already-running images and CLI binaries;
updating an operating system does not change embedded Node or Rust trust stores.

The legacy nginx Alpine branch receives explicit removal of both root paths.
Other maintained Alpine images require ca-certificates 20261020-r0 or newer;
Debian images pin the advisory releases for bookworm and trixie. A missing
package version must fail the build, never silently retain an older bundle.

The legacy math image removes the affected fingerprints from Java `cacerts`
before Maven dependency downloads. Rebuild any offline runtime that copies that
JDK. `check-images.sh` also checks this Java store, the API and migration images.
The Delphi trust check builds its shared OS stage and installs its exact HTTP
client pins in a small test image; it does not build or run numerical models.

Upstream releases:
[Node](https://github.com/nodejs/node/releases/tag/v22.23.4),
[certifi](https://github.com/certifi/python-certifi/releases/tag/2026.10.19),
[webpki-roots](https://github.com/rustls/webpki-roots/releases/tag/v%2F1.0.10),
[rustls-webpki](https://github.com/rustls/webpki/releases/tag/v%2F0.103.16).

The coordinator disables built-in roots and uses only its explicit RDS bundle.
Its image is audited with `--rds-only`; this option is not appropriate for a
client that also loads the operating system's public roots.
