# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

# Gulp v3 stops us from upgrading beyond Node v11
FROM docker.io/node:11-alpine

WORKDIR /app

RUN apk add git

COPY package*.json ./

RUN npm ci

COPY polis.config.template.js polis.config.js
# If polis.config.js already exists in the local directory being copied,
# it will override the template from the line above.
COPY . .

# GIT_HASH will be set properly when running `make` (see Makefile).
ARG GIT_HASH="placeholder"

CMD npm run deploy:prod
