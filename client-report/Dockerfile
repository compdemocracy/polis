FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json ./
RUN npm ci

COPY . .
COPY polis.config.template.js polis.config.js

ARG GIT_HASH
RUN npm run build:preprod
