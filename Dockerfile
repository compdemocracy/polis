ARG TAG=dev

FROM compdem/polis-client-admin:${TAG}          as admin
FROM compdem/polis-client-participation:${TAG}  as participation
FROM compdem/polis-client-report:${TAG}         as report

FROM babashka/babashka


RUN apt-get update
RUN apt-get -y install openjdk-16-jre

WORKDIR /app
COPY bin/deploy-static-assets.clj ./

RUN npm ci

RUN mkdir /app/client-participation/build /app/client-admin/build /app/client-report/build

COPY --from=admin         /build/ /app/client-admin/build
COPY --from=participation /build/ /app/client-participation/build
COPY --from=report        /build/ /app/client-report/build

CMD ./deploy-static-assets.clj

