FROM clojure:tools-deps

WORKDIR /build
COPY . .

# Install clojure and fetch dependencies
RUN clojure -P

CMD ["./bin/run"]
