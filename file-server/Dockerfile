# Test this Dockerfile build with:
# (from the polis root directory)
# docker build -t polis-file-server:dev -f file-server/Dockerfile .
# docker run --name file-server --env PORT=8080 -p 8080:8080 polis-file-server:dev

######################## POLIS CLIENT ADMIN ########################
#FROM client-base AS client-admin # <- switch back to basing on client admin once we upgrade other clients
FROM docker.io/node:24-alpine AS client-admin

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app

COPY client-admin/package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN npm ci --production=false

COPY client-admin/. .

ARG ADMIN_UIDS
ARG AUTH_AUDIENCE
ARG AUTH_CLIENT_ID
ARG AUTH_ISSUER
ARG AUTH_NAMESPACE
ENV ADMIN_UIDS=${ADMIN_UIDS}
ENV AUTH_AUDIENCE=${AUTH_AUDIENCE}
ENV AUTH_CLIENT_ID=${AUTH_CLIENT_ID}
ENV AUTH_ISSUER=${AUTH_ISSUER}
ENV AUTH_NAMESPACE=${AUTH_NAMESPACE}

RUN npm run build:prod



##################### POLIS CLIENT PARTICIPATION #####################
FROM docker.io/node:24-alpine AS client-participation

ARG EMBED_SERVICE_HOSTNAME
ARG GA_TRACKING_ID
ARG OIDC_CACHE_KEY_PREFIX
ARG OIDC_CACHE_KEY_ID_TOKEN_SUFFIX
ENV EMBED_SERVICE_HOSTNAME=${EMBED_SERVICE_HOSTNAME}
ENV GA_TRACKING_ID=${GA_TRACKING_ID}
ENV OIDC_CACHE_KEY_PREFIX=${OIDC_CACHE_KEY_PREFIX}
ENV OIDC_CACHE_KEY_ID_TOKEN_SUFFIX=${OIDC_CACHE_KEY_ID_TOKEN_SUFFIX}

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app

COPY client-participation/package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN npm ci --production=false

COPY client-participation/. .

RUN npm run build:prod



######################## POLIS CLIENT REPORT ########################
# FROM client-base AS client-report
FROM docker.io/node:24-alpine AS client-report

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app

RUN apk add git

COPY client-report/package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN npm ci --production=false

COPY client-report/. .

# GIT_HASH will be set properly when running `make` (see Makefile).
ARG GIT_HASH
ENV GIT_HASH=${GIT_HASH:-placeholder}

ARG AUTH_AUDIENCE
ARG AUTH_NAMESPACE
ARG AUTH_CLIENT_ID
ARG AUTH_ISSUER
ARG DD_APPLICATION_ID
ARG DD_CLIENT_TOKEN
ARG DD_SITE
ARG SERVICE_URL
ENV AUTH_AUDIENCE=${AUTH_AUDIENCE}
ENV AUTH_CLIENT_ID=${AUTH_CLIENT_ID}
ENV AUTH_NAMESPACE=${AUTH_NAMESPACE}
ENV AUTH_ISSUER=${AUTH_ISSUER}
ENV DD_APPLICATION_ID=${DD_APPLICATION_ID}
ENV DD_CLIENT_TOKEN=${DD_CLIENT_TOKEN}
ENV DD_SITE=${DD_SITE}
ENV SERVICE_URL=${SERVICE_URL}

RUN npm run build:prod



############################ FILE SERVER ############################
FROM docker.io/node:24-alpine

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app

COPY file-server/package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN npm ci

COPY file-server/. .

# use the multi-stage builds above to copy out the resources
RUN mkdir /app/build
COPY --from=client-admin          /app/build/       /app/build
COPY --from=client-participation  /app/dist/        /app/build
COPY --from=client-report         /app/dist/        /app/build

EXPOSE 8080

CMD npm run serve