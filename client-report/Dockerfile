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
RUN npm run deploy:prod
