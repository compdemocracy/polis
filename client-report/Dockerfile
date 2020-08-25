# Gulp v3 stops us from upgrading beyond Node v11
FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY client-report/package*.json ./
RUN npm ci

COPY client-report/* ./
COPY client-report/polis.config.template.js polis.config.js
RUN mkdir config
COPY config/* ./config/

ARG GIT_HASH
RUN npm run build:preprod
