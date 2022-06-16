# Gulp v3 stops us from upgrading beyond Node v11
FROM docker.io/node:11.15.0-alpine

WORKDIR /app

# Fixes bug in Alpine < 12.4.0 - see https://stackoverflow.com/a/52196681/199
RUN npm config set unsafe-perm true

RUN apk add git g++ make python openssh --no-cache

# Move this above the 'npm install' step as the repo runs a build as a postinstall hook
COPY polis.config.template.js polis.config.js
# If polis.config.js exists on host, will override template here.
COPY . .

RUN npm install

ARG GIT_HASH
RUN npm run deploy:prod
