# Gulp v3 stops us from upgrading beyond Node v11
FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json ./
RUN npm install

COPY polis.config.template.js polis.config.js
# Note: This will not only copy all remaining files, but also
# override the above template with `polis.config.js` (if it exists)
COPY . .

ARG GIT_HASH
RUN npm run build:preprod
