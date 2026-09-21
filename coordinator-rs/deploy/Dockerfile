# Docker Official Images, pinned manifest lists; no package installation.
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS build
WORKDIR /build/coordinator-rs
COPY coordinator-rs/Cargo.toml coordinator-rs/Cargo.lock coordinator-rs/rust-toolchain.toml ./
COPY coordinator-rs/src ./src
COPY coordinator-rs/schemas ./schemas
COPY server/postgres/migrations/000021_create_polis_coordinator.sql /build/server/postgres/migrations/000021_create_polis_coordinator.sql
COPY coordinator-rs/build.rs coordinator-rs/migration.sql ./
RUN CARGO_BUILD_JOBS=2 cargo build --locked --release --bin coordinator-idle
# Preserve the existing reviewed RDS bundle pin; no live runtime download.
RUN curl --fail --location --proto '=https' --tlsv1.2 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-ca.pem \
 && echo 'e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  /rds-ca.pem' | sha256sum --check
# Copy only the executable and the pinned builder's OpenSSL runtime libraries.
RUN mkdir /runtime-libs && cp -L /usr/lib/$(gcc -dumpmachine)/libssl.so.3 /usr/lib/$(gcc -dumpmachine)/libcrypto.so.3 /runtime-libs/
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
COPY --from=build /build/coordinator-rs/target/release/coordinator-idle /usr/local/bin/coordinator-idle
COPY --from=build /runtime-libs/ /usr/local/lib/
COPY --from=build /rds-ca.pem /etc/polis/rds-ca.pem
COPY coordinator-rs/deploy/entrypoint.sh /usr/local/bin/coordinator-entrypoint
RUN chmod 0555 /usr/local/bin/coordinator-entrypoint && mkdir -p /run/coordinator && chown 10001:10001 /run/coordinator && chmod 0700 /run/coordinator
ENV LD_LIBRARY_PATH=/usr/local/lib COORDINATOR_DB_CA_BUNDLE=/etc/polis/rds-ca.pem COORDINATOR_MODE=inactive COORDINATOR_WRITER_ENABLED=false P026_RESERVATION_BYTES=0
USER 10001:10001
VOLUME ["/run/coordinator"]
ENTRYPOINT ["/usr/local/bin/coordinator-entrypoint"]
