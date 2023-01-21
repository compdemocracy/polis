FROM docker.io/node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY polis.config.template.js polis.config.js
# If polis.config.js already exists in the local directory being copied,
# it will override the template from the line above.
COPY . .

CMD npm run build:prod
