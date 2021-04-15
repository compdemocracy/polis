FROM alpine:latest

ENV BUILD_DEPS="bash build-base libpng-dev zlib-dev autoconf automake libtool nasm curl" \
  RUN_DEPS="openssh-client openjdk8-jre"

WORKDIR /build
COPY . .

# for build scripting
RUN \
  bash < <(curl -s https://raw.githubusercontent.com/babashka/babashka/master/install)

#apk del $BUILD_DEPS && \
#rm -rf /tmp/* /var/cache/*
