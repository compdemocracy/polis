ARG TAG=dev

FROM compdem/polis-client-admin:${TAG}          as admin
FROM compdem/polis-client-participation:${TAG}  as participation
FROM compdem/polis-client-report:${TAG}         as report

FROM node:15.9.0-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .
COPY fs_config.template.json fs_config.json

RUN mkdir /app/build
COPY --from=admin         /app/build/ /app/build
COPY --from=participation /app/build/ /app/build
COPY --from=report        /app/build/ /app/build

EXPOSE 8080

CMD node --max_old_space_size=400 --gc_interval=100 --harmony app.js
