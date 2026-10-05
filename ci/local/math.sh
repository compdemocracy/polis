#!/usr/bin/env bash
# Test Math / "test-clj": the Clojure math tests (`clojure -M:test`; the
# integration tests that need a database are excluded by the alias).
# Hosted CI uses JDK 16.0.2 and Clojure CLI 1.10.1.693. A different host
# runtime is accepted only with CHECK_ALLOW_RUNTIME_MISMATCH=1; under that
# override, a missing Clojure CLI falls back to a container.
# Dependency resolution needs Maven Central and Clojars on a cold cache.
. "$(dirname "$0")/lib.sh"
check_init math
cd "$CHECK_ROOT/math"
java_have="$(java -version 2>&1 | sed -n '1s/.*version "\([^"]*\)".*/\1/p' || true)"
clojure_have="$(clojure -Sdescribe 2>/dev/null | sed -n 's/.*:version "\([^"]*\)".*/\1/p' | head -1 || true)"
if [ "$java_have" != 16.0.2 ] || [ "$clojure_have" != 1.10.1.693 ]; then
  check_runtime_mismatch "math requires JDK 16.0.2 and Clojure CLI 1.10.1.693; found JDK ${java_have:-none}, Clojure CLI ${clojure_have:-none}"
fi
if command -v clojure >/dev/null 2>&1; then
  check_log "JDK ${java_have:-unknown}; Clojure CLI ${clojure_have:-unknown}"
  clojure -M:test
else
  image="${CHECK_CLOJURE_IMAGE:-clojure:temurin-21-tools-deps}"
  check_log "WARNING: no clojure on PATH; running in $image under the runtime-mismatch override"
  mkdir -p "$CHECK_ROOT/.check/m2"
  docker run --rm -v "$CHECK_ROOT/math:/math" -v "$CHECK_ROOT/.check/m2:/root/.m2" -w /math \
    "$image" clojure -M:test
fi
