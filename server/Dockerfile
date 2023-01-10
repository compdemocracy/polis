FROM docker.io/node:19.4.0-alpine3.17

WORKDIR /app

RUN apk add postgresql-dev python3-dev build-base

RUN apk add --no-cache --virtual .build \
  g++ git make python3

COPY package*.json ./

# TODO get `npm ci` to work
RUN npm install
RUN apk del .build

# TODO This shouldn't be necessary; fix
#RUN chown -R 1000:1000 /root/.npm

COPY . .

RUN npm run build

EXPOSE 5000

CMD npm run serve