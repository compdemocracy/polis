# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

FROM docker.io/node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY polis.config.template.js polis.config.js
# If polis.config.js already exists in the local directory being copied,
# it will override the template from the line above.
COPY . .

CMD npm run build:prod
