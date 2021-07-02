FROM clojure:tools-deps

WORKDIR /build
COPY . .

# Install clojure and fetch dependencies
RUN clojure -A:dev -P

CMD ["./bin/run"]
