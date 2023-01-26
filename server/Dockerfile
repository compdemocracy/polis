FROM docker.io/node:18-alpine

WORKDIR /app

COPY package*.json ./

# This package is needed at runtime
RUN apk add libpq-dev

RUN apk add --no-cache --virtual .build \
  g++ make python3

# This is useful for development situations when node_modules is a volume and would
# otherwise persist across container rebuilds.
RUN rm -rf node_modules

RUN npm ci

RUN apk del .build

COPY . .

RUN npm run build

EXPOSE 5000

CMD npm run serve
