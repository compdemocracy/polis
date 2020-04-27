FROM node:10.15.0

ARG GIT_HASH

WORKDIR /app

RUN npm install -g gulp

ADD package*.json ./
RUN npm install

ADD polis.config.template.js polis.config.js

ADD . .

RUN gulp deployPreprod
