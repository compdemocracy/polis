# Requires a very specific version due to package bugs and version compatibility
FROM node:6.10.3-alpine

ARG GIT_HASH

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json npm-shrinkwrap.json ./
RUN npm install --silent

COPY . .
COPY polis.config.template.js polis.config.js

RUN npm run build:preprod
