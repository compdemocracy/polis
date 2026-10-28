# polis-api image. Build context: repository root, e.g.
#   docker build -f queue-rs/polis-api/Dockerfile .
# FEATURES=fixture-clock builds the conformance variant only; the default
# image has no way to fake the clock.
FROM docker.io/library/rust:1.98.1-slim-trixie AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev python3 ca-certificates=20250419+deb13u1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src/queue-rs
COPY queue-rs/ .
COPY VERSION VERSION_STABLE_COMMIT /src/
COPY scripts/build_identity.py /src/scripts/build_identity.py
ARG FEATURES=""
ARG GIT_HASH=unknown
ARG POLIS_VERSION=unknown
ARG POLIS_BUILD_DISTANCE=unknown
ARG POLIS_BUILD_TAG
ARG POLIS_BUILD_SOURCE=unverified-archive
ENV GIT_HASH=${GIT_HASH} POLIS_VERSION=${POLIS_VERSION}
RUN cd polis-api/certs && sha256sum --check SHA256SUMS
# Same inputs and script as server/Dockerfile's npm prebuild. Git is absent
# from both image contexts, so a single Compose build identifies both alike.
RUN GIT_HASH="$GIT_HASH" POLIS_BUILD_DISTANCE="$POLIS_BUILD_DISTANCE" \
    POLIS_BUILD_TAG="$POLIS_BUILD_TAG" POLIS_BUILD_SOURCE="$POLIS_BUILD_SOURCE" \
    python3 /src/scripts/build_identity.py --output /src/build-info.json
ENV POLIS_BUILD_INFO=/src/build-info.json
RUN cargo build --release --locked -p polis-api ${FEATURES:+--features "$FEATURES"} \
 && cp target/release/polis-api /polis-api

FROM docker.io/library/debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3t64 ca-certificates=20250419+deb13u1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /polis-api /usr/local/bin/polis-api
COPY queue-rs/polis-api/certs/rds-global-bundle.pem queue-rs/polis-api/certs/SHA256SUMS /etc/polis/
COPY --chmod=755 queue-rs/polis-api/docker-entrypoint.sh /usr/local/bin/polis-api-entrypoint
ENV POLIS_API_DB_CA_FILE=/etc/polis/rds-global-bundle.pem
# As the server image's prod target: production unless built otherwise, and
# an env file can still override it at run time, for both processes alike.
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
ENV POLIS_API_LISTEN=0.0.0.0:5100
EXPOSE 5100
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/polis-api-entrypoint"]
