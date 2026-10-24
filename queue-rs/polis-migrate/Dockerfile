# Build from repository root. One binary for deploys and manual/local upgrades.
FROM docker.io/library/rust:1.98.1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev curl ca-certificates=20250419~deb12u2 \
 && rm -rf /var/lib/apt/lists/*
# Public RDS truststore retrieved over HTTPS 2026-10-09; checksum pins its bytes.
RUN curl --fail --location --proto '=https' --tlsv1.2 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-ca.pem \
 && echo '90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /rds-ca.pem' | sha256sum --check
WORKDIR /src
COPY queue-rs/ ./
RUN cargo build --release --locked -p polis-migrate
FROM docker.io/library/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates=20250419~deb12u2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/polis-migrate /usr/local/bin/polis-migrate
COPY server/postgres/migrations /migrations
COPY --from=build /rds-ca.pem /etc/polis/rds-ca.pem
ENV POLIS_MIGRATIONS_DIR=/migrations POLIS_MIGRATE_CA_FILE=/etc/polis/rds-ca.pem
USER 65534:65534
ENTRYPOINT ["polis-migrate"]
CMD ["apply"]
