FROM docker.io/clojure:temurin-17-tools-deps

WORKDIR /app
COPY . .

RUN curl -L -o /app/dd-java-agent.jar 'https://dtdg.co/latest-java-tracer'

# Install clojure and fetch dependencies
RUN clojure -A:dev -P

CMD ["./bin/run"]
