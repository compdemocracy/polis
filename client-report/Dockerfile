# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

FROM docker.io/node:24-alpine

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app

RUN apk add git

COPY package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN npm ci --production=false

COPY . .

# GIT_HASH is optional and will be set properly when running `make` (see Makefile).
# Or may be passed in at build time with --build-arg GIT_HASH=$(git rev-parse --short HEAD)
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
ENV AUTH_NAMESPACE=${AUTH_NAMESPACE}
ENV AUTH_CLIENT_ID=${AUTH_CLIENT_ID}
ENV AUTH_ISSUER=${AUTH_ISSUER}
ENV DD_APPLICATION_ID=${DD_APPLICATION_ID}
ENV DD_CLIENT_TOKEN=${DD_CLIENT_TOKEN}
ENV DD_SITE=${DD_SITE}
ENV SERVICE_URL=${SERVICE_URL}

CMD npm run build:prod
