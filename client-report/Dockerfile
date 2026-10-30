# syntax=docker/dockerfile:1.4
# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.
# Build from the repository root: docker build -f client-report/Dockerfile .

FROM docker.io/node:24.22.1-alpine
RUN apk add --no-cache 'ca-certificates>=20261020-r0'

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

RUN apk add --no-cache python3

WORKDIR /app/client-report

RUN apk add git

COPY client-report/package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --production=false

COPY VERSION VERSION_STABLE_COMMIT /app/
COPY scripts/build_identity.py scripts/build-identity.cjs /app/scripts/
COPY client-report/ .

ARG AUTH_AUDIENCE
ARG AUTH_NAMESPACE
ARG AUTH_CLIENT_ID
ARG AUTH_ISSUER
ARG DD_APPLICATION_ID
ARG DD_CLIENT_TOKEN
ARG DD_SITE
ARG SERVICE_URL
ENV AUTH_AUDIENCE=${AUTH_AUDIENCE}
ENV AUTH_NAMESPACE=${AUTH_NAMESPACE}
ENV AUTH_CLIENT_ID=${AUTH_CLIENT_ID}
ENV AUTH_ISSUER=${AUTH_ISSUER}
ENV DD_APPLICATION_ID=${DD_APPLICATION_ID}
ENV DD_CLIENT_TOKEN=${DD_CLIENT_TOKEN}
ENV DD_SITE=${DD_SITE}
ENV SERVICE_URL=${SERVICE_URL}

ARG GIT_HASH=unknown
ARG POLIS_BUILD_DISTANCE=unknown
ARG POLIS_BUILD_TAG
ARG POLIS_BUILD_SOURCE=unverified-archive
ENV GIT_HASH=${GIT_HASH} POLIS_BUILD_DISTANCE=${POLIS_BUILD_DISTANCE} POLIS_BUILD_TAG=${POLIS_BUILD_TAG} POLIS_BUILD_SOURCE=${POLIS_BUILD_SOURCE}

CMD npm run build:prod
