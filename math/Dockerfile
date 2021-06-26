FROM openjdk:15-alpine

ENV BUILD_DEPS="bash build-base libpng-dev zlib-dev autoconf automake libtool nasm curl" \
  RUN_DEPS="openssh-client"

WORKDIR /build
COPY . .

# Install clojure and fetch dependencies
RUN \
  apk update && \
  apk add $RUN_DEPS $BUILD_DEPS && \
  curl -O https://download.clojure.org/install/linux-install-1.10.3.855.sh && \
  chmod +x linux-install-1.10.3.855.sh && \
  ./linux-install-1.10.3.855.sh && \
  clojure -P

CMD ["./bin/run"]
