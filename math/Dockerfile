FROM docker.io/clojure:temurin-17-tools-deps

WORKDIR /app

# Install clojure and fetch dependencies
# Copy deps.edn first and fetch dependencies
COPY deps.edn .
RUN clojure -A:dev -P

# Then copy the rest of the source code
COPY . .

CMD ["./bin/run"]
