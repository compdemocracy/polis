FROM postgres:9.5

ENV POSTGRES_DB polis-dev
ENV POSTGRES_PASSWORD oiPorg3Nrz0yqDLE
ENV POSTGRES_USER postgres

ADD ./postgres/db_setup_draft.sql /docker-entrypoint-initdb.d/
