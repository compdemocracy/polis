# polis-api image. Build context: queue-rs/ (the Cargo workspace), e.g.
#   docker build -f queue-rs/polis-api/Dockerfile queue-rs
# FEATURES=fixture-clock builds the conformance variant only; the default
# image has no way to fake the clock.
FROM docker.io/library/rust:1.98.1-slim-trixie AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates=20250419+deb13u1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
ARG FEATURES=""
ARG GIT_HASH=unknown
ARG POLIS_VERSION=unknown
ENV GIT_HASH=${GIT_HASH} POLIS_VERSION=${POLIS_VERSION}
RUN cd polis-api/certs && sha256sum --check SHA256SUMS
RUN cargo build --release --locked -p polis-api ${FEATURES:+--features "$FEATURES"} \
 && cp target/release/polis-api /polis-api

FROM docker.io/library/debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3t64 ca-certificates=20250419+deb13u1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /polis-api /usr/local/bin/polis-api
COPY polis-api/certs/rds-global-bundle.pem polis-api/certs/SHA256SUMS /etc/polis/
COPY --chmod=755 polis-api/docker-entrypoint.sh /usr/local/bin/polis-api-entrypoint
ENV POLIS_API_DB_CA_FILE=/etc/polis/rds-global-bundle.pem
# As the server image's prod target: production unless built otherwise, and
# an env file can still override it at run time, for both processes alike.
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
ENV POLIS_API_LISTEN=0.0.0.0:5100
EXPOSE 5100
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/polis-api-entrypoint"]
