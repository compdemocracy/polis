# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

FROM docker.io/node:18-alpine

ARG ENABLE_TWITTER_WIDGETS
ARG FB_APP_ID
ENV ENABLE_TWITTER_WIDGETS ${ENABLE_TWITTER_WIDGETS}
ENV FB_APP_ID ${FB_APP_ID}

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

CMD npm run build:prod
