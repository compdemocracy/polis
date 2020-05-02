from alpine:latest

ENV BUILD_DEPS="bash build-base libpng-dev zlib-dev autoconf automake libtool nasm curl" \
    RUN_DEPS="openssh-client openjdk8-jre" \
    LEIN_ROOT=1

WORKDIR /build
COPY . .

RUN \
  apk update && \
  apk add $RUN_DEPS $BUILD_DEPS && \
  curl --silent https://raw.githubusercontent.com/technomancy/leiningen/stable/bin/lein > /usr/local/bin/lein && \
  chmod +x /usr/local/bin/lein && \
  lein deps

  # Not doing this for now, since conflicts with core.matrix for some reason...
  #lein package && \
  # Don't forget to WORKDIR /app before entry point if we switch back to this...
  #mkdir /app && mv target/uberjar/*-standalone.jar /app/app.jar && \
  #rm -rf /build ~/.m2 ~/.lein && \

  #apk del $BUILD_DEPS && \
  #rm -rf /tmp/* /var/cache/*

ENTRYPOINT ["./bin/dockerRun"]
