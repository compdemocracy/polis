FROM node:6.10

ARG GIT_HASH

RUN npm install -g gulp

ADD package*.json npm-shrinkwrap.json ./
# envvar hides core-js sponsorship message that errors in postinstall.
# See: https://github.com/zloirock/core-js/pull/799#issuecomment-611437614
ENV ADBLOCK=1
RUN npm install

ADD polis.config.template.js polis.config.js

ADD . .

RUN gulp dist
