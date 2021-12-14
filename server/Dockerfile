FROM node:14.14.0-alpine

WORKDIR /app

RUN apk add postgresql-dev

RUN apk add --no-cache --virtual .build \
  g++ git make python

COPY package*.json ./

# TODO get `npm ci` to work
RUN npm install
RUN apk del .build

COPY . .
RUN npm run build

EXPOSE 5000

CMD npm run serve
