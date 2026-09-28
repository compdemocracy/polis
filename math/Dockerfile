FROM docker.io/clojure:temurin-17-tools-deps

WORKDIR /app
COPY . .

# Install clojure and fetch dependencies.
# Retry the Maven Central classpath fetch: it intermittently fails with
# "Premature end of Content-Length delimited message body" on large jars
# (e.g. org.apache.poi:poi), which would otherwise abort the whole build.
RUN for attempt in 1 2 3; do \
      echo "clojure -A:dev -P (attempt $attempt/3)"; \
      clojure -A:dev -P && break; \
      if [ "$attempt" = "3" ]; then \
        echo "dependency fetch failed after 3 attempts" >&2; exit 1; \
      fi; \
      echo "retrying in 5s..."; sleep 5; \
    done

CMD ["./bin/run"]
