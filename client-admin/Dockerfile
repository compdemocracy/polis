# Gulp v3 stops us from upgrading beyond Node v11
FROM node:11.15.0-alpine

WORKDIR /app

RUN apk add git --no-cache

COPY package*.json ./
RUN npm install

COPY . .

ARG GIT_HASH
CMD npm run deploy:prod
