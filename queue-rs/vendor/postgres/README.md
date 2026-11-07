# Rust-Postgres

PostgreSQL support for Rust.

## postgres [![Latest Version](https://img.shields.io/crates/v/postgres.svg)](https://crates.io/crates/postgres)

[Documentation](https://docs.rs/postgres)

A native, synchronous PostgreSQL client.

## tokio-postgres [![Latest Version](https://img.shields.io/crates/v/tokio-postgres.svg)](https://crates.io/crates/tokio-postgres)

[Documentation](https://docs.rs/tokio-postgres)

A native, asynchronous PostgreSQL client.

## postgres-types [![Latest Version](https://img.shields.io/crates/v/postgres-types.svg)](https://crates.io/crates/postgres-types)

[Documentation](https://docs.rs/postgres-types)

Conversions between Rust and Postgres types.

## postgres-native-tls [![Latest Version](https://img.shields.io/crates/v/postgres-native-tls.svg)](https://crates.io/crates/postgres-native-tls)

[Documentation](https://docs.rs/postgres-native-tls)

TLS support for postgres and tokio-postgres via native-tls.

## postgres-openssl [![Latest Version](https://img.shields.io/crates/v/postgres-openssl.svg)](https://crates.io/crates/postgres-openssl)

[Documentation](https://docs.rs/postgres-openssl)

TLS support for postgres and tokio-postgres via openssl.

# Running test suite

The test suite requires postgres to be running in the correct configuration. The easiest way to do this is with docker:

1. Install `docker` and `docker-compose`.
   1. On ubuntu: `sudo apt install docker.io docker-compose`.
1. Make sure your user has permissions for docker.
   1. On ubuntu: ``sudo usermod -aG docker $USER``
1. Change to top-level directory of `rust-postgres` repo.
1. Run `docker-compose up -d`.
1. Run `cargo test`.
1. Run `docker-compose stop`.

## This vendored copy

This is `postgres` 0.19.14 from crates.io, redistributed under its MIT licence.
`LICENSE-MIT` and `LICENSE-APACHE` are unchanged upstream files. The upstream
archive SHA-256 is
`33ad20e0aa0b24f5a394eab4f78c781d248982b22b25cecc7e3aa46a681605bd`.
The retained sources are byte-identical except for `src/config.rs`,
`src/client.rs` and `src/connection.rs`: an 85-line addition (25 lines replaced)
adds opt-in whole-setup and protocol-I/O deadlines with socket closure. The
manifest omits the unused benchmark and its criterion development dependency;
this README and `POLIS_CHANGES.md` document the copy. Upstream packaging metadata,
changelog, lockfile and benchmark are omitted.

The published synchronous client owns a private runtime and cannot be built
from an externally bounded connection. Its TCP connect timeout excludes DNS,
TLS, authentication and session setup. An outer timeout abandons a blocking
operation without closing its socket or releasing its pool slot; keepalive and
TCP_USER_TIMEOUT cannot end a peer that ACKs but never answers. See
`POLIS_CHANGES.md` for the opt-in API and unchanged default behaviour.

To re-vendor an upstream fix:

1. Download the new crates.io archive and verify its SHA-256 against the registry
   checksum before extracting it. Review the upstream release and security fixes.
2. Replace the retained files, preserving upstream licence files byte for byte.
   Update the version and checksum here and in `POLIS_CHANGES.md`.
3. Reapply only the documented three-source deadline delta and benchmark removal,
   or remove the delta if upstream supplies equivalent cancellation and socket
   closure. Review the complete diff against the verified archive.
4. Update Cargo.lock and run the API database fault tests, workspace checks and
   route byte replays. Check setup expiry, socket closure and permit reclamation
   on Linux as well as default behaviour for clients that do not opt in.

Offline verification (Python 3.11 or newer, standard library only):

```sh
python3 ci/vendor_postgres.py
python3 -m unittest discover -s ci -p test_vendor_postgres.py -v
```

Both commands also run in `make check-polis-api`. No network or Cargo registry
cache is needed: the committed per-file SHA-256 manifest anchors the upstream
bytes and the recorded diff accounts for every retained-file change.

The archive checksum is recorded here and in `UPSTREAM_SHA256.json`. Cargo
records the resolved version for a path dependency, with no registry source or
checksum; the check compares that version with the vendored crate and documents.
No custom lockfile entries are needed. These reviewed records are trust anchors,
not independent attestations. When refreshing, update the version and verified
archive checksum here and in `POLIS_CHANGES.md`, update Cargo's resolved version,
and run from the repository root:

```sh
python3 ci/vendor_postgres.py --refresh /path/to/postgres-VERSION.crate
python3 ci/vendor_postgres.py
```

Refresh first verifies the archive against this README's checksum, then regenerates
`UPSTREAM_SHA256.json` and `POLIS_CHANGES.patch`. Review both changes against the
published archive; never refresh merely to silence an unexpected drift failure.
If upstream packaging changes, review the explicit omission list in the checker.
The check detects local drift; discovering new upstream fixes still requires
reviewing upstream releases and advisories.
