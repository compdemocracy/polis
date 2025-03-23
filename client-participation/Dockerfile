# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

FROM docker.io/node:18-alpine

ARG EMBED_SERVICE_HOSTNAME
ARG GA_TRACKING_ID
ENV EMBED_SERVICE_HOSTNAME=${EMBED_SERVICE_HOSTNAME}
ENV GA_TRACKING_ID=${GA_TRACKING_ID}

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app

COPY package*.json ./

RUN npm ci --production=false

COPY . .

CMD npm run build:prod
