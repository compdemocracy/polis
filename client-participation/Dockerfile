# Gulp v3 stops us from upgrading beyond Node v11
FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add --no-cache --virtual .build \
  g++ git make python

RUN npm config set unsafe-perm true
RUN npm install -g bower

COPY client-participation/package*.json ./
COPY client-participation/bower.json ./

RUN npm ci
RUN bower install --allow-root

RUN apk del .build

COPY client-participation/* ./

ARG GIT_HASH
RUN npm run build:preprod
