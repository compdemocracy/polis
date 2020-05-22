# The version of node-sass in use requires node 8.x
FROM node:8.17.0-alpine

ARG GIT_HASH

WORKDIR /app

RUN apk add --no-cache --virtual .build \
  g++ git make python

RUN npm install -g bower

COPY package*.json ./
COPY bower.json ./

RUN npm ci
RUN bower install --allow-root

RUN apk del .build

COPY . .
COPY polis.config.template.js polis.config.js

RUN npm run build:preprod
