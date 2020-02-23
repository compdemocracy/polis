FROM node:10.9.0

# sudo docker image build -t polis-server:1.0 .
# sudo docker container run --network="host" --publish 5000:5000 --detach --name polis-server polis-server:1.0
# sudo docker container kill polis-server
# sudo docker container rm polis-server
# sudo docker logs polis-server
# --network="host"

# sudo docker container kill polis-server; sudo docker container rm polis-server; sudo docker image build -t polis-server:1.0 .
# sudo docker container run --network="host" --publish 5000:5000 --detach --name polis-server polis-server:1.0


ARG host=localhost
ARG port=5000

ARG static_files_host=localhost
ARG static_files_port=5001

ARG static_files_admin_host=localhost
ARG static_files_admin_port=5002

# database credentials are defined in .env file
#ARG postgres_host=localhost
#ARG postgres_port=5432
#ARG postgres_uid=postgres
#ARG postgres_pwd=postgres
#ARG postgres_db=polis-dev
#ENV DATABASE_URL postgres://${postgres_uid}:${postgres_pwd}@${postgres_host}:${postgres_port}/${postgres_db}

ENV DOMAIN_OVERRIDE ${host}:${port}
ENV PORT ${port}

ENV STATIC_FILES_HOST ${static_files_host}
ENV STATIC_FILES_PORT ${static_files_port}
ENV STATIC_FILES_ADMINDASH_PORT ${static_files_admin_port}
ENV DISABLE_INTERCOM="true"

WORKDIR /app

COPY . .

RUN npm install

EXPOSE ${port}

#CMD npm run docker

CMD ["node", "--max_old_space_size=400", "--gc_interval=100", "--harmony", "app.js" ]


