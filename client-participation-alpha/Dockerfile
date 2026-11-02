# syntax=docker/dockerfile:1.4
FROM node:24.22.1-alpine
RUN apk add --no-cache 'ca-certificates>=20261020-r0'
WORKDIR /app

ARG PUBLIC_SERVICE_URL
ARG INTERNAL_SERVICE_URL
ARG OIDC_CACHE_KEY_PREFIX
ARG OIDC_CACHE_KEY_ID_TOKEN_SUFFIX
ARG PUBLIC_AUTH_NAMESPACE

ENV PUBLIC_SERVICE_URL=$PUBLIC_SERVICE_URL
ENV INTERNAL_SERVICE_URL=$INTERNAL_SERVICE_URL
ENV PUBLIC_OIDC_CACHE_KEY_PREFIX=$OIDC_CACHE_KEY_PREFIX
ENV PUBLIC_OIDC_CACHE_KEY_ID_TOKEN_SUFFIX=$OIDC_CACHE_KEY_ID_TOKEN_SUFFIX
ENV PUBLIC_AUTH_NAMESPACE=$PUBLIC_AUTH_NAMESPACE

COPY client-participation-alpha/package*.json ./
RUN apk add --no-cache python3
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY client-participation-alpha/. .

ARG GIT_HASH=unknown
ARG POLIS_BUILD_DISTANCE=unknown
ARG POLIS_BUILD_TAG
ARG POLIS_BUILD_SOURCE=unverified-archive
ENV GIT_HASH=$GIT_HASH POLIS_BUILD_DISTANCE=$POLIS_BUILD_DISTANCE POLIS_BUILD_TAG=$POLIS_BUILD_TAG POLIS_BUILD_SOURCE=$POLIS_BUILD_SOURCE
COPY VERSION VERSION_STABLE_COMMIT /
COPY scripts/build_identity.py scripts/build-identity.cjs /scripts/

RUN npm run build

EXPOSE 4321
CMD ["node", "dist/server/entry.mjs"]
