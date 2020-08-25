# Gulp v3 stops us from upgrading beyond Node v11
FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY client-admin/package*.json ./
RUN npm install

COPY client-admin/* ./
COPY client-admin/polis.config.template.js polis.config.js

ARG GIT_HASH
RUN npm run build:preprod
