FROM node:10-alpine

ARG GIT_HASH

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json ./
RUN npm ci

COPY . .
COPY polis.config.template.js polis.config.js

RUN npm run build:preprod
