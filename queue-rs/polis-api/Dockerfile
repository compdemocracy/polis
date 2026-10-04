# polis-api image. Build context: queue-rs/ (the Cargo workspace), e.g.
#   docker build -f queue-rs/polis-api/Dockerfile queue-rs
# FEATURES=fixture-clock builds the conformance variant only; the default
# image has no way to fake the clock.
FROM docker.io/library/rust:1.98.1-slim-trixie AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
ARG FEATURES=""
RUN cargo build --release --locked -p polis-api ${FEATURES:+--features "$FEATURES"} \
 && cp target/release/polis-api /polis-api

FROM docker.io/library/debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /polis-api /usr/local/bin/polis-api
ENV POLIS_API_LISTEN=0.0.0.0:5100
EXPOSE 5100
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/polis-api"]
