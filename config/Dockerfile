FROM node:14.5.0-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY ./* ./config/

COPY . .

RUN node export_config.js

RUN echo done
