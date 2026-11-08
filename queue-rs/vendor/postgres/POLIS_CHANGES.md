# Bounded synchronous connections

This directory contains the source of postgres 0.19.14, redistributed under MIT, with the original MIT
and Apache licence files unchanged. The crates.io archive has SHA-256
`33ad20e0aa0b24f5a394eab4f78c781d248982b22b25cecc7e3aa46a681605bd`.
The published manifest is retained except for the unused benchmark and its
development dependency. The crate is excluded from workspace membership.

Three opt-in methods preserve the synchronous client and transaction types used
by the route and authentication code:

- `Config::setup_deadline` covers resolution, TCP, TLS, startup and authentication.
- `Client::set_deadline` carries that same absolute deadline through session setup.
- `Client::set_io_timeout` bounds each protocol operation on established clients.

On expiry the connection stream is dropped, closing its socket and request
receiver before returning the driver's existing timeout error. Transaction,
rollback, copy and row-stream operations use the same connection polling path.
A failed bounded connect shuts its runtime down without waiting for a blocking
OS resolver. That resolver may finish later, but the dropped connect future
cannot open a socket and no pool permit remains with it.

The default deadlines are absent, so existing job and migration clients retain
the upstream behavior. Route pools opt in through `Connector::connect_bounded`.
The route policy and existing PostgreSQL statement timeouts remain outside this
crate. A future upstream synchronous cancellation/deadline API can replace this
copy once it proves equivalent socket closure and permit reclamation.

Route pools use the upstream `Client::check_connection` protocol Sync only
after a client has been idle longer than the five-second keepalive window. The synchronous runtime is idle between checkouts, so a closed
socket may not yet have set `Client::is_closed`. Recently used clients add no checkout round trip. A stale idle client
adds one bounded network round trip; a failed check discards the client and returns an error without a
second connection attempt in the same checkout.

## Exact recorded delta

[POLIS_CHANGES.patch](POLIS_CHANGES.patch) is the canonical unified diff from
the published crate to every retained file, including Cargo.toml and README.
`UPSTREAM_SHA256.json` records every file in the checksum-verified upstream
archive. The five omitted packaging/development files are explicitly listed in
that manifest; only this document, the hash manifest and the diff are additions.
The check reverses the diff without fuzz, verifies every retained upstream hash,
and regenerates and compares the diff byte for byte. Unexpected, missing and
symlinked files fail with their names.

Cargo does not assign a registry checksum to a patched path dependency. The
archive checksum stays in README, this document and `UPSTREAM_SHA256.json`;
the check requires them to agree and their version to match the postgres package
in Cargo.lock and Cargo.toml. No hand-added lockfile entries are needed.
File contents are compared; file modes are not checked.
This verifies the reviewed vendoring; it does not poll for newer releases or
security advisories. Upstream release/security review remains part of re-vendoring.
