FROM node:14.8.0-alpine

WORKDIR /app

RUN apk add postgresql-dev

RUN apk add --no-cache --virtual .build \
  g++ git make python

COPY server/package*.json ./
# TODO get `npm ci` to work
RUN npm install

RUN apk del .build

COPY server/* ./

EXPOSE 5000

CMD node --max_old_space_size=400 --gc_interval=100 --harmony app.js
