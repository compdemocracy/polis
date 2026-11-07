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
