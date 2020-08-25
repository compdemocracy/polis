ARG TAG=dev

FROM polisdemo/client-admin:${TAG}          as admin
FROM polisdemo/client-participation:${TAG}  as participation
FROM polisdemo/client-report:${TAG}         as report

FROM node:14.8.0-alpine

WORKDIR /app

COPY file-server/package*.json ./

RUN npm ci

COPY file-server/* ./
COPY file-server/fs_config.template.json fs_config.json

RUN mkdir /app/build
COPY --from=admin         /app/build/ /app/build
COPY --from=participation /app/build/ /app/build
COPY --from=report        /app/build/ /app/build

EXPOSE 8080

CMD node --max_old_space_size=400 --gc_interval=100 --harmony app.js
