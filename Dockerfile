FROM node:10.15.0

RUN npm install -g gulp
RUN npm install -g bower
RUN npm install gulp
RUN npm link gulp

COPY package*.json ./
COPY bower.json ./
RUN npm install
RUN bower install --allow-root

ADD polis.config.template.js polis.config.js

ADD . .

RUN gulp prodBuildNoDeploy
