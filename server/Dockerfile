# To build locally, for example:
# docker build -t polis-server:local .
# To run locally, for example:
# docker run --rm --name polis-server --env-file .env --network polis-dev_polis_net \
#  -p 5000:5000 polis-server:local

FROM docker.io/node:18-alpine

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ARG NODE_ENV
ENV NODE_ENV ${NODE_ENV:-production}

WORKDIR /app

COPY package*.json ./

# This package is needed at runtime
RUN apk add libpq-dev

RUN apk add --no-cache --virtual .build \
  g++ make python3

RUN npm ci --include=dev

RUN apk del .build

COPY . .

RUN npm run build

EXPOSE 5000

CMD npm run serve
