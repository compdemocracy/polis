FROM node:14.14.0-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json ./
RUN npm install

COPY polis.config.template.js polis.config.js
# If polis.config.js exists on host, will override template here.
COPY . .

ARG GIT_HASH
RUN npm run build:prod
