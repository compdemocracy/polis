# syntax=docker/dockerfile:1.4
# Requires BuildKit (default in Docker 23+; on older versions prefix
# the build command with `DOCKER_BUILDKIT=1`). The `RUN --mount=type=cache`
# directives below are silently ignored without BuildKit.
# To build locally, for example:
# docker build -t polis-server:local .
# To run locally, for example:
# docker run --rm --name polis-server --env-file .env --network polis-dev_polis-net \
#  -p 5000:5000 --target dev polis-server:local
#
# For a dev build, use `--target dev`.
# Should default to prod build, but you can also explicitly use `--target prod`

FROM docker.io/node:22-alpine as base

ARG NODE_ENV

WORKDIR /app

# Install Python and necessary tools (including pip)
RUN apk add --no-cache python3 py3-pip ca-certificates

# Verified startup migration checks use the same public RDS CA pin as the
# runner image. Deployments with another private CA can override this env.
RUN mkdir -p /etc/polis \
 && wget -O /etc/polis/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && echo 'fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c  /etc/polis/rds-ca.pem' | sha256sum -c -
ENV NODE_EXTRA_CA_CERTS=/etc/polis/rds-ca.pem

# This package is needed at runtime
RUN apk add libpq-dev

RUN apk add --no-cache --virtual .build \
  g++ make python3

COPY package*.json ./

EXPOSE 5000


# Define the development build

FROM base as dev

# Set default NODE_ENV to development unless overridden at build time with --build-arg NODE_ENV=production
ENV NODE_ENV ${NODE_ENV:-development}
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --production=false

COPY . .

CMD npm run dev



# Define the production build

FROM base as prod

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ENV NODE_ENV ${NODE_ENV:-production}

# Install OpenSSL and CA Certificates (CRITICAL for production)
RUN apk add --no-cache openssl ca-certificates

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --production=false

# For prod builds, to minimize the image size, remove the dependencies tagged with `--virtual .build` above.
RUN apk del .build

COPY . .

RUN npm run build

CMD npm run serve