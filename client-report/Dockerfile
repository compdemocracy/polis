# Gulp v3 stops us from upgrading beyond Node v11
FROM polis_config AS config

FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json ./
RUN npm ci

COPY --from=config /config/config.js /app/config/
COPY --from=config /config/*.yaml /app/config/

COPY . .

ARG GIT_HASH
RUN npm run deploy:prod
