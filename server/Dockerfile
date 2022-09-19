FROM docker.io/node:18.9.0-alpine3.15

WORKDIR /app

RUN apk add postgresql-dev python3-dev build-base

RUN apk add --no-cache --virtual .build \
  g++ git make python3

COPY package*.json ./

# TODO get `npm ci` to work
RUN npm install
RUN apk del .build

COPY . .

RUN npm run build

EXPOSE 5000

CMD npm run serve