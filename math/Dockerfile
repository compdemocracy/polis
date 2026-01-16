FROM docker.io/clojure:temurin-17-tools-deps

WORKDIR /app
COPY . .

# Install clojure and fetch dependencies
RUN clojure -A:dev -P

CMD ["./bin/run"]
