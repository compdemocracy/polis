FROM node:10.15.0

ARG GIT_HASH

RUN npm install -g gulp
RUN npm install -g bower

COPY package*.json ./
COPY bower.json ./
RUN npm install
RUN bower install --allow-root

ADD polis.config.template.js polis.config.js

ADD . .

RUN gulp prodBuildNoDeploy
