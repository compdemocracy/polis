FROM node:10.15.0

RUN npm install -g gulp
RUN npm install gulp
RUN npm link gulp

ADD package*.json .
RUN npm install

ADD polis.config.template.js polis.config.js

ADD . .

RUN gulp dist
