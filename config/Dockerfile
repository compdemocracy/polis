FROM node:14.5.0-alpine

WORKDIR /app

COPY config/package*.json ./
RUN npm install

COPY config/* ./config/

COPY config/* ./

RUN node export_config.js

RUN echo done
