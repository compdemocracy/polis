# Gulp v3 stops us from upgrading beyond Node v11
FROM node:15.3.0-alpine

WORKDIR /app

RUN apk add --no-cache --virtual .build \
  g++ git make python

RUN npm config set unsafe-perm true
RUN npm install -g bower

COPY package*.json ./
COPY bower.json ./

RUN npm ci
RUN bower install --allow-root

RUN apk del .build

COPY . .
COPY polis.config.template.js polis.config.js

ARG GIT_HASH
RUN npm run build:preprod
