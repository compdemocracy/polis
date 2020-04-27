FROM node:10.15.0

WORKDIR /app

COPY package*.json ./
RUN npm install

ADD fs_config.template.json fs_config.json

ADD . .

COPY --from=polis-report:latest /app/build/ ./build/
COPY --from=polis-admin:latest /app/build/ ./build/
COPY --from=polis-participation:latest /app/build/ ./build/

EXPOSE 8080
CMD node --max_old_space_size=400 --gc_interval=100 --harmony app.js
