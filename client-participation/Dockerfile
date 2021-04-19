# Gulp v3 stops us from upgrading beyond Node v11
FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add --no-cache --virtual .build \
  g++ git make python

# Allow global npm installs in Docker
RUN npm config set unsafe-perm true

# Upgrade npm v6.7.0 -> v6.9.2 to alias multiple pkg versions.
# See: https://stackoverflow.com/a/56134858/504018
RUN npm install -g npm@6.9.2

COPY package*.json ./

RUN npm ci

RUN apk del .build

COPY polis.config.template.js polis.config.js
# If polis.config.js exists on host, will override template here.
COPY . .

ARG GIT_HASH
ARG BABEL_ENV=production

RUN npm run deploy:prod

