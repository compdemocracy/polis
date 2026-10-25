# syntax=docker/dockerfile:1.4
# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.
# Build from the repository root: docker build -f client-participation/Dockerfile .

FROM docker.io/node:24.22.1-alpine
RUN apk add --no-cache 'ca-certificates>=20261020-r0'

ARG EMBED_SERVICE_HOSTNAME
ARG GA_TRACKING_ID
ARG OIDC_CACHE_KEY_PREFIX
ARG OIDC_CACHE_KEY_ID_TOKEN_SUFFIX
ARG AUTH_NAMESPACE
ENV EMBED_SERVICE_HOSTNAME=${EMBED_SERVICE_HOSTNAME}
ENV GA_TRACKING_ID=${GA_TRACKING_ID}
ENV OIDC_CACHE_KEY_PREFIX=${OIDC_CACHE_KEY_PREFIX}
ENV OIDC_CACHE_KEY_ID_TOKEN_SUFFIX=${OIDC_CACHE_KEY_ID_TOKEN_SUFFIX}
ENV AUTH_NAMESPACE=${AUTH_NAMESPACE}

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

RUN apk add --no-cache python3

WORKDIR /app/client-participation

COPY client-participation/package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --production=false

COPY VERSION VERSION_STABLE_COMMIT /app/
COPY scripts/build_identity.py scripts/build-identity.cjs /app/scripts/
COPY client-participation/ .

ARG GIT_HASH=unknown
ARG POLIS_BUILD_DISTANCE=unknown
ARG POLIS_BUILD_TAG
ARG POLIS_BUILD_SOURCE=unverified-archive
ENV GIT_HASH=${GIT_HASH} POLIS_BUILD_DISTANCE=${POLIS_BUILD_DISTANCE} POLIS_BUILD_TAG=${POLIS_BUILD_TAG} POLIS_BUILD_SOURCE=${POLIS_BUILD_SOURCE}

CMD npm run build:prod
