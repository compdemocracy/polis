# Requires a very specific version due to package bugs and version compatibility
FROM node:10.20.1-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json npm-shrinkwrap.json ./
RUN npm install

COPY . .
COPY polis.config.template.js polis.config.js

ARG GIT_HASH
RUN npm run build:preprod
