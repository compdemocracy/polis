#!/bin/sh
# Tests the write-label guard in math/bin/run without a JVM or a database:
# `timeout` (the command bin/run wraps `clojure -M:run full` in) is stubbed on
# PATH to record that the engine WOULD start, then stop bin/run's loop.
#
#   sh math/bin/test-run-guard.sh     # exits non-zero on any failure
set -u
here=$(cd "$(dirname "$0")" && pwd)
run="$here/run"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/timeout" <<'STUB'
#!/bin/sh
echo "$*" > "$STARTED"
kill -PIPE "$PPID"  # PIPE: the shell prints no notice for it
STUB
chmod +x "$work/bin/timeout"

failures=0
passes=0

# case <name> <expect: start|refuse> <env assignments...>
case_() {
  name=$1 expect=$2
  shift 2
  started="$work/started.$passes.$failures"
  rm -f "$started"
  env -i PATH="$work/bin:/usr/bin:/bin" STARTED="$started" "$@" sh "$run" > "$work/out" 2> "$work/err"
  status=$?
  if [ "$expect" = start ]; then
    if [ -f "$started" ] && grep -qx -- "-s KILL 14400 clojure -M:run full" "$started"; then
      passes=$((passes + 1))
    else
      failures=$((failures + 1))
      echo "FAIL $name: expected the engine to start (status $status)"; cat "$work/err"
    fi
  else
    if [ "$status" = 78 ] && [ ! -f "$started" ] && grep -q "refusing to start" "$work/err"; then
      passes=$((passes + 1))
    else
      failures=$((failures + 1))
      echo "FAIL $name: expected refusal with status 78 and no start (status $status)"; cat "$work/err"
    fi
  fi
}

case_ "prod starts"                        start  MATH_ENV=prod
case_ "prod starts with the dev opt-in"    start  MATH_ENV=prod MATH_CLOJURE_ALLOW_NONPROD_ENV=1
case_ "python is refused"                  refuse MATH_ENV=python
case_ "python is refused even opted in"    refuse MATH_ENV=python MATH_CLOJURE_ALLOW_NONPROD_ENV=1
case_ "unset is refused"                   refuse
case_ "empty is refused"                   refuse MATH_ENV=
case_ "dev is refused without the opt-in"  refuse MATH_ENV=dev
case_ "dev starts with the opt-in"         start  MATH_ENV=dev MATH_CLOJURE_ALLOW_NONPROD_ENV=1
case_ "opt-in must be exactly 1"           refuse MATH_ENV=dev MATH_CLOJURE_ALLOW_NONPROD_ENV=true
case_ "PROD (case) is refused"             refuse MATH_ENV=PROD
case_ "prod with whitespace is refused"    refuse "MATH_ENV=prod "

echo "math/bin/run guard: $passes passed, $failures failed"
[ "$failures" = 0 ]
