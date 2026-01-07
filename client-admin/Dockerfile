# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

FROM docker.io/node:24-alpine

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app

COPY package*.json ./

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN npm ci --production=false

COPY . .

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


CMD ["npm", "run", "build:prod"]
