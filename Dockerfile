FROM babashka/babashka

RUN apt-get update
RUN apt-get -y install openjdk-16-jre docker

WORKDIR /build
COPY . .

