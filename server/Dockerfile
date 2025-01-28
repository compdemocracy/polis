# To build locally, for example:
# docker build -t polis-server:local .
# To run locally, for example:
# docker run --rm --name polis-server --env-file .env --network polis-dev_polis-net \
#  -p 5000:5000 --target dev polis-server:local
#
# For a dev build, use `--target dev`.
# Should default to prod build, but you can also explicitly use `--target prod`

FROM docker.io/node:18-alpine as base

ARG NODE_ENV

WORKDIR /app

# Install Python and necessary tools (including pip)
RUN apk add --no-cache python3 py3-pip

# Install the gcloud CLI
RUN apk add --no-cache wget gnupg && \
    wget -q -O - https://dl.google.com/dl/cloudsdk/release/google-cloud-sdk.tar.gz | tar xvz -C /root && \
    /root/google-cloud-sdk/install.sh --quiet

ENV PATH="/root/google-cloud-sdk/bin:${PATH}"

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

COPY . .

CMD npm run dev



# Define the production build

FROM base as prod

# Set default NODE_ENV to production unless overridden at build time with --build-arg NODE_ENV=development
ENV NODE_ENV ${NODE_ENV:-production}

ARG JIGSAW_SERVICE_ACCT
RUN echo ${JIGSAW_SERVICE_ACCT} > /app/llm-service-account.json

ENV GOOGLE_APPLICATION_CREDENTIALS=/app/llm-service-account.json

# Authenticate with the service account
RUN gcloud auth activate-service-account --key-file=/app/llm-service-account.json

RUN npm ci --production=false

# For prod builds, to minimize the image size, remove the dependencies tagged with `--virtual .build` above.
RUN apk del .build

COPY . .

RUN npm run build

CMD npm run serve