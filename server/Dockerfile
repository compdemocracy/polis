FROM node:17.6.0-alpine

WORKDIR /app

RUN apk add postgresql-dev python-dev build-base

RUN apk add --no-cache --virtual .build \
  g++ git make python

COPY package*.json ./

# TODO get `npm ci` to work
RUN npm install
RUN apk del .build

COPY . .

EXPOSE 5000
# For vscode debug
EXPOSE 9229


# CMD npm run build && npm run serve
CMD npm run build:watch && npm run serve