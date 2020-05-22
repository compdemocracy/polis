FROM node:10.20.1-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .
COPY fs_config.template.json fs_config.json

COPY --from=polis/client-report:latest /app/build/ ./build/
COPY --from=polis/client-admin:latest /app/build/ ./build/
COPY --from=polis/client-participation:latest /app/build/ ./build/

EXPOSE 8080

CMD node --max_old_space_size=400 --gc_interval=100 --harmony app.js
