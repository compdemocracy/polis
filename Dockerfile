ARG TAG=dev

# polis-client-admin
FROM docker.io/node:11.15.0-alpine AS client-base

RUN apk add git g++ make python openssh --no-cache



# polis-client-admin
FROM client-base AS client-admin

WORKDIR /client-admin/app

COPY client-admin/package*.json ./
RUN npm install

COPY client-admin/polis.config.template.js polis.config.js
# If polis.config.js exists on host, will override template here.
COPY client-admin/. .

ARG GIT_HASH
RUN npm run deploy:prod



# polis-client-participation
# # Gulp v3 stops us from upgrading beyond Node v11
FROM client-base AS client-participation

WORKDIR /client-participation/app

# Allow global npm installs in Docker
RUN npm config set unsafe-perm true

# Upgrade npm v6.7.0 -> v6.9.2 to alias multiple pkg versions.
# See: https://stackoverflow.com/a/56134858/504018
RUN npm install -g npm@6.9.2

COPY client-participation/package*.json ./

# It would be nice if this was ci, but misbehaving for some reason
RUN npm ci

COPY client-participation/polis.config.template.js polis.config.js
# If polis.config.js exists on host, will override template here.
COPY client-participation/. .

ARG GIT_HASH
ARG BABEL_ENV=production

RUN npm run deploy:prod


# polis-client-report
# Gulp v3 stops us from upgrading beyond Node v11
FROM client-base AS client-report

WORKDIR /client-report/app

COPY client-report/package*.json ./
# This should be working with `npm ci`, but isn't; Need to debug
RUN npm install

COPY client-report/polis.config.template.js polis.config.js
# If polis.config.js exists on host, will override template here.
COPY client-report/. .

ARG GIT_HASH
RUN npm run deploy:prod



FROM docker.io/babashka/babashka

RUN apt-get update && apt-get -y install openjdk-16-jre


RUN mkdir /app/

WORKDIR /app/

COPY ./bin/ ./bin/

COPY --from=0 /client-admin/app/dist/          /app/client-admin/dist
COPY --from=1 /client-participation/app/build/ /app/client-participation/dist
COPY --from=2 /client-report/app/build/        /app/client-report/dist

CMD ./bin/deploy-static-assets.clj --bucket $STATIC_ASSET_DEPLOY_BUCKET

