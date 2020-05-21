FROM node:10.15.0

WORKDIR /app

RUN npm install -g gulp

ADD package*.json ./
RUN npm install

ADD polis.config.template.js polis.config.js

ADD . .

ARG GIT_HASH
RUN gulp deployPreprod
