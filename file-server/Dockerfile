######################## POLIS CLIENT ADMIN ########################
#FROM client-base AS client-admin # <- switch back to basing on client admin once we upgrade other clients
FROM docker.io/node:18-alpine AS client-admin

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV ${NODE_ENV:-production}

WORKDIR /app

COPY client-admin/package*.json ./

RUN npm ci --production=false

COPY client-admin/. .

RUN npm run build:prod



##################### POLIS CLIENT PARTICIPATION #####################
FROM docker.io/node:18-alpine AS client-participation

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV ${NODE_ENV:-production}

WORKDIR /app

COPY client-participation/package*.json ./

RUN npm ci --production=false

COPY client-participation/. .

RUN npm run build:prod



######################## POLIS CLIENT REPORT ########################
# Gulp v3 stops us from upgrading beyond Node v11
# FROM client-base AS client-report
FROM docker.io/node:11-alpine as client-report

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV ${NODE_ENV:-production}

WORKDIR /app

RUN apk add git

COPY client-report/package*.json ./

RUN npm ci --production=false

COPY client-report/. .

# GIT_HASH will be set properly when running `make` (see Makefile).
ARG GIT_HASH
ENV GIT_HASH ${GIT_HASH:-placeholder}

RUN npm run deploy:prod



############################ FILE SERVER ############################
FROM docker.io/node:18-alpine

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV ${NODE_ENV:-production}

WORKDIR /app

COPY file-server/package*.json ./

RUN npm ci

COPY file-server/. .

# use the multi-stage builds above to copy out the resources
RUN mkdir /app/build
COPY --from=client-admin          /app/build/       /app/build
COPY --from=client-participation  /app/dist/        /app/build
COPY --from=client-report         /app/build/       /app/build

EXPOSE 8080

CMD npm run serve
