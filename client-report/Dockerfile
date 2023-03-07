# NOTE: This Dockerfile is not actually used by the docker-compose.yml.
# Instead, the file-server Dockerfile builds and serves these assets.
# But this file is still useful for development or deployments that do not use
# the docker compose configuration.

FROM docker.io/node:18-alpine

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV ${NODE_ENV:-production}

WORKDIR /app

RUN apk add git

COPY package*.json ./

RUN npm ci --production=false

COPY . .

# GIT_HASH is optional and will be set properly when running `make` (see Makefile).
# Or may be passed in at build time with --build-arg GIT_HASH=$(git rev-parse --short HEAD)
ARG GIT_HASH
ARG REPORT_UPLOADER
ARG S3_BUCKET_PREPROD
ARG S3_BUCKET_PROD
ARG SERVICE_URL
ENV GIT_HASH ${GIT_HASH:-placeholder}
ENV REPORT_UPLOADER ${REPORT_UPLOADER:-local}
ENV S3_BUCKET_PREPROD ${S3_BUCKET_PREPROD}
ENV S3_BUCKET_PROD ${S3_BUCKET_PROD}
ENV SERVICE_URL ${SERVICE_URL}

CMD npm run deploy:prod
