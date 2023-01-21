FROM docker.io/node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache --virtual .build \
  g++ libpq-dev make python3

RUN npm ci

RUN apk del .build

COPY . .

RUN npm run build

EXPOSE 5000

CMD npm run serve
