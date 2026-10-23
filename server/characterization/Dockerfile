FROM rust:1.98.1-bookworm AS migrate-build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u2 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY queue-rs/ .
RUN cargo build --locked --release -p polis-migrate

FROM node:22.23.4-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates=20250419~deb12u2 && rm -rf /var/lib/apt/lists/*
COPY --from=migrate-build /src/target/release/polis-migrate /usr/local/bin/polis-migrate
ENV POLIS_MIGRATE_BIN=/usr/local/bin/polis-migrate
