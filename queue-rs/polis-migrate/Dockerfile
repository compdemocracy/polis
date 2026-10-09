# Build from repository root. One binary for deploys and manual/local upgrades.
FROM docker.io/library/rust:1.98.1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Public RDS truststore retrieved over HTTPS 2026-10-09; checksum pins its bytes.
RUN curl --fail --location --proto '=https' --tlsv1.2 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-ca.pem \
 && echo 'fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c  /rds-ca.pem' | sha256sum --check
WORKDIR /src
COPY queue-rs/ ./
RUN cargo build --release --locked -p polis-migrate
FROM docker.io/library/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/polis-migrate /usr/local/bin/polis-migrate
COPY server/postgres/migrations /migrations
COPY --from=build /rds-ca.pem /etc/polis/rds-ca.pem
ENV POLIS_MIGRATIONS_DIR=/migrations POLIS_MIGRATE_CA_FILE=/etc/polis/rds-ca.pem
USER 65534:65534
ENTRYPOINT ["polis-migrate"]
CMD ["apply"]
