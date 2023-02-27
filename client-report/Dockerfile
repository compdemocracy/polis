# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

FROM docker.io/node:18-alpine

WORKDIR /app

RUN apk add git

COPY package*.json ./

RUN npm ci

COPY . .

# GIT_HASH will be set properly when running `make` (see Makefile).
ARG GIT_HASH="placeholder"

CMD npm run deploy:prod
