# Requires a very specific version due to package bugs and version compatibility
FROM node:6.10.3

WORKDIR /app

RUN npm install -g gulp

ADD package*.json npm-shrinkwrap.json ./
# envvar hides core-js sponsorship message that errors in postinstall.
# See: https://github.com/zloirock/core-js/pull/799#issuecomment-611437614
ENV ADBLOCK=1
RUN npm install

ADD polis.config.template.js polis.config.js

ADD . .

ARG GIT_HASH
RUN gulp deployPreprod
