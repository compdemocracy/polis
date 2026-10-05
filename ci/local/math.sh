#!/usr/bin/env bash
# Test Math / "test-clj": the Clojure math tests (`clojure -M:test`; the
# integration tests that need a database are excluded by the alias).
# Uses the host's clojure CLI when there is one (CI installs JDK 16 and CLI
# 1.10.1.693); otherwise runs in the clojure:temurin-21-tools-deps image.
# Dependency resolution needs Maven Central and Clojars on a cold cache.
. "$(dirname "$0")/lib.sh"
check_init math
cd "$CHECK_ROOT/math"
if command -v clojure >/dev/null 2>&1; then
  java -version 2>&1 | head -1 || true
  clojure -M:test
else
  image="${CHECK_CLOJURE_IMAGE:-clojure:temurin-21-tools-deps}"
  check_log "no clojure on PATH: running in $image (CI uses JDK 16)"
  mkdir -p "$CHECK_ROOT/.check/m2"
  docker run --rm -v "$CHECK_ROOT/math:/math" -v "$CHECK_ROOT/.check/m2:/root/.m2" -w /math \
    "$image" clojure -M:test
fi
