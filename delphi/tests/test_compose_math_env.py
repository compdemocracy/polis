"""Every compose stack must hand delphi the math_env its math service writes.

The report pipeline reads ``math_main`` / ``math_ptptstats`` scoped by
``math_env`` (see ``tests/test_report_math_env.py``). The delphi service has no
``env_file:``, so ``--env-file`` only feeds ``${...}`` interpolation, never the
container environment, and nothing on the report import path calls
``load_dotenv()``: unless the service block lists ``MATH_ENV``, the report
container falls back to the library default in
``polismath/components/config.py`` regardless of what the stack is configured
for. If that resolves to a different env than the one the ``math`` service
writes under, ``GroupDataProcessor.get_math_main_by_conversation`` finds no row
and silently synthesises groups from raw votes.

Runs without a docker daemon: the compose files are parsed as YAML and their
``${VAR:-default}`` interpolation is evaluated here, which is what
``docker compose config`` would print. The checkout is located by walking up
from this file (``POLIS_CHECKOUT_DIR`` overrides), because the CI job copies
``delphi/tests`` into the delphi image at ``/app/tests``, where the repo root is
not an ancestor — ``python-ci.yml`` copies the two compose files in beside it.
"""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from polismath.components.config import ConfigManager


COMPOSE_FILES = {
    "docker-compose.yml": "prod",
    "docker-compose.test.yml": "dev",
}
PROBE = "probe-math-env"


def _find_checkout():
    """Directory holding both compose files: $POLIS_CHECKOUT_DIR, else the
    nearest ancestor of this file that has them (the checkout root normally,
    /app when CI has copied them in beside /app/tests). None if unavailable."""
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent, *here.parents]
    for candidate in candidates:
        if all((candidate / name).is_file() for name in COMPOSE_FILES):
            return candidate
    return None


CHECKOUT = _find_checkout()
requires_checkout = pytest.mark.skipif(
    CHECKOUT is None,
    reason=(
        f"neither {' nor '.join(COMPOSE_FILES)} was found in $POLIS_CHECKOUT_DIR "
        f"({os.environ.get('POLIS_CHECKOUT_DIR') or 'unset'}) nor in any ancestor of "
        f"{Path(__file__).resolve()} — point POLIS_CHECKOUT_DIR at a Polis checkout"
    ),
)

# ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, ${VAR?err} — the forms
# compose interpolates. `:` variants also treat the empty string as unset.
_INTERPOLATION = re.compile(
    r"\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?:(?P<op>:-|-|:\?|\?)(?P<arg>[^}]*))?\}"
)


def _interpolate(value: str, env: dict) -> str:
    def replace(match):
        raw = env.get(match["name"])
        unset = raw is None or (raw == "" and (match["op"] or "").startswith(":"))
        if not unset:
            return raw
        return match["arg"] if match["op"] in (":-", "-") else ""

    return _INTERPOLATION.sub(replace, value)


def _environment(compose_file: str, service: str, env: dict | None = None) -> dict:
    document = yaml.safe_load((CHECKOUT / compose_file).read_text())
    assert service in document["services"], f"{compose_file} defines no {service} service"
    entries = document["services"][service].get("environment") or []
    if isinstance(entries, dict):
        pairs = [(key, value or "") for key, value in entries.items()]
    else:
        pairs = [(entry.partition("=")[0], entry.partition("=")[2]) for entry in entries]
    return {key: _interpolate(value, env or {}) for key, value in pairs}


@requires_checkout
@pytest.mark.parametrize("compose_file", sorted(COMPOSE_FILES))
def test_delphi_receives_math_env(compose_file):
    assert "MATH_ENV" in _environment(compose_file, "delphi"), (
        f"{compose_file}: the delphi service does not set MATH_ENV, so the report "
        "pipeline would read math rows under the library default instead of this "
        "stack's math_env"
    )


@requires_checkout
@pytest.mark.parametrize("compose_file,default", sorted(COMPOSE_FILES.items()))
def test_delphi_resolves_to_the_stack_default(compose_file, default):
    # MATH_ENV unset in the environment and in the env file.
    assert _environment(compose_file, "delphi")["MATH_ENV"] == default


@requires_checkout
@pytest.mark.parametrize("compose_file,default", sorted(COMPOSE_FILES.items()))
@pytest.mark.parametrize("env", [{}, {"MATH_ENV": PROBE}], ids=["unset", "MATH_ENV-set"])
def test_delphi_and_math_agree_on_math_env(compose_file, default, env):
    delphi = _environment(compose_file, "delphi", env)
    math = _environment(compose_file, "math", env)
    assert math["MATH_ENV"] == env.get("MATH_ENV", default)
    assert delphi["MATH_ENV"] == math["MATH_ENV"], (
        f"{compose_file}: delphi reads a different math_env than math writes"
    )


@requires_checkout
def test_delphi_does_not_follow_the_shadow_poller_env():
    # docker-compose.yml gives math-python its own label variable; reports must
    # follow the server's MATH_ENV, not the writer's label.
    env = {"MATH_ENV": PROBE}
    assert _environment("docker-compose.yml", "delphi", env)["MATH_ENV"] == PROBE
    assert _environment("docker-compose.yml", "math-python", env)["MATH_ENV"] == "python"


BLAS_THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")


@requires_checkout
def test_math_poller_pins_blas_threads_but_report_pipeline_does_not():
    # The poller runs single-threaded BLAS so PCA bits do not depend on thread
    # count; the delphi report service shares the image and keeps its threads.
    poller = _environment("docker-compose.yml", "math-python")
    assert {key: poller.get(key) for key in BLAS_THREAD_VARS} == dict.fromkeys(BLAS_THREAD_VARS, "1")
    delphi = _environment("docker-compose.yml", "delphi")
    assert not set(BLAS_THREAD_VARS) & set(delphi)


@requires_checkout
def test_math_python_forwards_the_served_env_override():
    # scripts/math_poller.py refuses MATH_ENV=prod unless
    # MATH_POLLER_ALLOW_SERVED_ENV=1; compose must pass the override through
    # from the stack env, empty (refusing) by default.
    unset = _environment("docker-compose.yml", "math-python")
    assert unset.get("MATH_POLLER_ALLOW_SERVED_ENV") == "", (
        "docker-compose.yml's math-python service must forward "
        "MATH_POLLER_ALLOW_SERVED_ENV with an empty default"
    )
    env = {"MATH_POLLER_ALLOW_SERVED_ENV": "1"}
    forwarded = _environment("docker-compose.yml", "math-python", env)
    assert forwarded["MATH_POLLER_ALLOW_SERVED_ENV"] == "1"


@requires_checkout
def test_library_default_matches_the_deployed_stack(monkeypatch):
    # With MATH_ENV unset, docker-compose.yml resolves to `prod`; the library
    # default must agree so an unwired container still reads the right rows.
    monkeypatch.delenv("MATH_ENV", raising=False)
    monkeypatch.setattr(ConfigManager, "_instance", None)
    assert (
        ConfigManager.get_config().get("math-env")
        == _environment("docker-compose.yml", "delphi")["MATH_ENV"]
    )


def test_library_default_is_prod(monkeypatch):
    # Compose-independent, so it still runs where the checkout is unavailable.
    monkeypatch.delenv("MATH_ENV", raising=False)
    monkeypatch.setattr(ConfigManager, "_instance", None)
    assert ConfigManager.get_config().get("math-env") == "prod"


# --- Production wiring (scripts/after_install.sh) ----------------------------
#
# Production boxes do not pass --profile: each CodeDeploy role starts its
# services BY NAME, and Compose enables the profiles of services named on the
# command line. The Python poller therefore runs exactly where the Delphi
# role's `up` line names it, and since the switch to Python no role names the
# Clojure `math` service. CI copies the script into the checkout-shaped root
# ($POLIS_CHECKOUT_DIR) beside the projection-gate inputs.

AFTER_INSTALL = Path("scripts") / "after_install.sh"
# The env lines the deploy hook's comment tells operators to put in the
# production secret; every one must be something math-python actually reads.
SHADOW_SECRET_VARS = (
    "MATH_PYTHON_ENV",
    "DATABASE_SSL_MODE",
    "DELPHI_POLLER_CONTAINER_MEMORY",
    "MATH_CONV_CACHE_CAP",
)


def _find_after_install():
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / AFTER_INSTALL).is_file():
            return candidate / AFTER_INSTALL
    return None


AFTER_INSTALL_PATH = _find_after_install()
requires_after_install = pytest.mark.skipif(
    AFTER_INSTALL_PATH is None,
    reason=f"{AFTER_INSTALL} not found in $POLIS_CHECKOUT_DIR nor any ancestor of this file",
)

_ROLE_BRANCH = re.compile(r'^(?:if|elif) \[ "\$SERVICE_FROM_FILE" == "(?P<role>[a-z-]+)" \]; then$')


def _role_up_lines() -> dict:
    """{role: [compose `up` command tokens, ...]} for each top-level role branch
    of the deploy hook; comments are ignored."""
    roles, current = {}, None
    for line in AFTER_INSTALL_PATH.read_text().splitlines():
        match = _ROLE_BRANCH.match(line)
        if match:
            current = match["role"]
            roles[current] = []
            continue
        if line.startswith(("else", "fi")):
            current = None
            continue
        code = line.split("#", 1)[0].split()
        command = code[1:] if code[:1] == ["sudo"] else code
        if current and command[:1] and command[0].endswith("docker-compose") and "up" in command:
            roles[current].append(code)
    return roles


def _services_named(tokens: list) -> set:
    after_up = tokens[tokens.index("up") + 1 :]
    return {token for token in after_up if not token.startswith("-")}


@requires_after_install
def test_delphi_role_starts_delphi_and_the_shadow_poller():
    roles = _role_up_lines()
    assert len(roles.get("delphi", [])) == 1, "the delphi role must have exactly one compose up line"
    (line,) = roles["delphi"]
    assert _services_named(line) == {"delphi", "math-python"}
    assert {"-d", "--build", "--force-recreate"} <= set(line)


@requires_after_install
def test_only_the_delphi_role_starts_the_shadow_poller():
    # Two pollers on one label would both write every zid.
    roles = _role_up_lines()
    assert {"server", "math", "delphi"} <= set(roles)
    starting = {role for role, lines in roles.items() if any("math-python" in _services_named(l) for l in lines)}
    assert starting == {"delphi"}


@requires_after_install
def test_deploy_hook_does_not_rely_on_profile_flags():
    # Activation comes from naming the service; a --profile flag would start
    # every service in that profile on whichever role carried it.
    for lines in _role_up_lines().values():
        for line in lines:
            assert not any(token.startswith("--profile") for token in line)


@requires_after_install
@requires_checkout
def test_secret_lines_named_by_the_hook_are_read_by_math_python():
    text = AFTER_INSTALL_PATH.read_text()
    block = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"]["math-python"]
    raw = yaml.safe_dump(block)
    for name in SHADOW_SECRET_VARS:
        assert f"{name}=" in text, f"after_install.sh no longer names {name} for the secret"
        assert "${" + name + ":-" in raw, f"math-python does not read ${{{name}}}"
    # The hook must say the served-label override stays unset.
    assert "MATH_POLLER_ALLOW_SERVED_ENV" in text


@requires_checkout
@pytest.mark.parametrize("env", [{}, {"MATH_ENV": PROBE}, {"MATH_ENV": "prod"}], ids=["unset", "probe", "prod"])
def test_math_python_label_is_python_when_math_python_env_unset(env):
    assert "MATH_PYTHON_ENV" not in env
    assert _environment("docker-compose.yml", "math-python", env)["MATH_ENV"] == "python"


def _math_python_memory() -> str:
    block = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"]["math-python"]
    return block["deploy"]["resources"]["limits"]["memory"]


@requires_checkout
def test_math_python_memory_limit_reads_delphi_poller_container_memory():
    raw = _math_python_memory()
    assert raw == "${DELPHI_POLLER_CONTAINER_MEMORY:-16g}"
    assert _interpolate(raw, {}) == "16g"
    assert _interpolate(raw, {"DELPHI_POLLER_CONTAINER_MEMORY": "6g"}) == "6g"
    # Delphi's own cap is a different variable; setting it must not move the poller's.
    assert _interpolate(raw, {"DELPHI_CONTAINER_MEMORY": "8g"}) == "16g"


# --- The switch to Python (readers on `python`, Clojure only under `prod`) ---
#
# Production sets MATH_ENV=python in the env secret: the server (env_file) and
# Delphi (interpolation) read the label math-python writes. The Clojure `math`
# service writes under ${MATH_ENV} too, so the math role starts it only when
# Compose resolves that label to exactly `prod`, starts nothing under `python`,
# and fails closed otherwise (review 1441). Rollback = MATH_ENV=prod in the
# secret, redeploy; no hook edit.

POST_SWITCH_SECRET = {"MATH_ENV": "python", "MATH_PYTHON_ENV": "python"}


@requires_after_install
def test_math_role_starts_only_the_math_service():
    roles = _role_up_lines()
    assert "math" in roles, "the math role branch must stay (its boxes still run the hook)"
    assert len(roles["math"]) == 1, roles["math"]
    assert _services_named(roles["math"][0]) == {"math"}


@requires_after_install
def test_only_the_math_role_can_start_the_clojure_math_service():
    roles = _role_up_lines()
    starting = {role for role, lines in roles.items() if any("math" in _services_named(l) for l in lines)}
    assert starting == {"math"}, f"roles starting the Clojure math service: {sorted(starting)}"


@requires_after_install
def test_hook_documents_the_readers_label_and_the_rollback_order():
    # Comment lines joined, so the checks do not depend on where lines wrap.
    text = re.sub(r"\s*\n\s*#\s*", " ", AFTER_INSTALL_PATH.read_text())
    assert "MATH_ENV=python" in text
    # Forward: a box deploy packages this hook (CodeDeploy runs the packaged
    # hook, and gives ASG replacements the last successful one) BEFORE the
    # secret moves; a second deploy then switches the readers (review 1439 R1).
    assert "merge to stable, then a box deploy while the secret still says MATH_ENV=prod" in text
    assert "then MATH_ENV=python in the secret, then a second box deploy" in text
    assert "last successful" in text
    # Rollback is the secret alone, then a redeploy: the hook follows the label.
    assert "Rollback: set MATH_ENV=prod in the secret, redeploy. No hook edit." in text


@requires_checkout
def test_after_the_switch_readers_serve_what_math_python_writes():
    delphi = _environment("docker-compose.yml", "delphi", POST_SWITCH_SECRET)
    writer = _environment("docker-compose.yml", "math-python", POST_SWITCH_SECRET)
    assert delphi["MATH_ENV"] == writer["MATH_ENV"] == "python"


@requires_checkout
def test_math_python_label_does_not_follow_the_readers_label():
    # The writer's label comes only from MATH_PYTHON_ENV, so moving the readers
    # (the switch, or a rollback to MATH_ENV=prod) never moves the writer.
    raw = yaml.safe_dump(yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"]["math-python"])
    assert "${MATH_ENV" not in raw
    rollback = {"MATH_ENV": "prod", "MATH_PYTHON_ENV": "python"}
    assert _environment("docker-compose.yml", "math-python", rollback)["MATH_ENV"] == "python"
    assert _environment("docker-compose.yml", "delphi", rollback)["MATH_ENV"] == "prod"


@requires_checkout
def test_math_python_has_no_env_file():
    # With an env_file, the secret's MATH_ENV=python would reach the poller's
    # process directly; the label must come only from the environment block.
    block = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"]["math-python"]
    assert "env_file" not in block


# --- The hook's role section, executed (reviews 1439 R3, 1441 R1b) ------------
#
# The text checks above only see compose lines that NAME services. These run the
# hook itself, from its service detection to the end, with inert stand-ins for
# sudo, docker, docker-compose, aws and sleep, so an unnamed `up`, an ignored
# cleanup failure or a missing postcondition shows up as behaviour, not as text.
#
# The stand-ins keep container state in $STATE across runs (one directory is one
# box): compose `up ... math` creates the `math` container, `down` and
# `docker rm -f` remove containers unless told to fail, and `docker ps`,
# `inspect` and `logs` read that state. The started container's state defaults
# to what math/bin/run does under the label Compose gives it: `prod` runs,
# anything else exits 78 and restarts. `compose config --format json` emulates
# Compose's precedence for the `math` service's MATH_ENV: a variable in the
# environment Compose sees ($STUB_COMPOSE_SHELL_MATH_ENV) beats the last .env
# definition, which beats the `${MATH_ENV:-prod}` default (checked against the
# real Compose binary below when one is installed).

_HOOK_PRELUDE = r"""
set -e
cd "$WORK"
mkdir -p "$STATE/math" "$STATE/other"
sudo() { "$@"; }
sleep() { echo "sleep $*" >> "$LOG"; }
_dotenv_math_env() {
  grep -E '^[[:space:]]*(export[[:space:]]+)?MATH_ENV[[:space:]]*=' .env 2>/dev/null | tail -n 1 \
    | sed -E 's/^[^=]*=//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/'
}
_effective_math_env() {
  if [ -n "${STUB_COMPOSE_SHELL_MATH_ENV+x}" ]; then printf '%s' "$STUB_COMPOSE_SHELL_MATH_ENV"; return; fi
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?MATH_ENV[[:space:]]*=' .env 2>/dev/null; then _dotenv_math_env; return; fi
  printf 'prod'
}
compose_stub() {
  echo "compose $*" >> "$LOG"
  case "$1" in
    config)
      # The hook's earlier `config --quiet` validation fails the deploy on its
      # own; this fails only the math role's read, to reach its handling.
      if [ "${STUB_CONFIG_FAIL:-}" = 1 ] && [ "$2" = --format ]; then echo "stub: config failed" >&2; return 1; fi
      if [ -n "${STUB_REAL_COMPOSE:-}" ]; then "$STUB_REAL_COMPOSE" "$@"; return; fi
      if [ -n "${STUB_CONFIG_JSON:-}" ]; then printf '%s\n' "$STUB_CONFIG_JSON"; return 0; fi
      printf '{"services":{"math":{"environment":{"MATH_ENV":"%s"}}}}\n' "$(_effective_math_env)"
      ;;
    down)
      if [ "${STUB_DOWN_FAIL:-}" = 1 ]; then return 1; fi
      rm -f "$STATE"/math/* "$STATE"/other/*
      ;;
    up)
      case " $* " in
        *" math "*)
          if [ "${STUB_UP_FAIL:-}" = 1 ]; then return 1; fi
          if [ -n "${STUB_MATH_STATE:-}" ]; then state="$STUB_MATH_STATE"
          elif [ "$(_effective_math_env)" = prod ]; then state="running 0 0"
          else state="restarting 78 2"; fi
          printf '%s\n' "$state" > "$STATE/math/math1"
          for extra in ${STUB_MATH_EXTRA:-}; do printf 'running 0 0\n' > "$STATE/math/$extra"; done
          ;;
        *) printf 'running 0 0\n' > "$STATE/other/svc1" ;;
      esac
      ;;
  esac
  return 0
}
docker() {
  echo "docker $*" >> "$LOG"
  case "$1" in
    ps)
      case " $* " in
        *" --filter "*)
          if [ "${STUB_PS_FAIL:-}" = 1 ]; then return 1; fi
          ls "$STATE/math"
          if [ -n "${STUB_MATH_LEFT:-}" ]; then printf '%s\n' $STUB_MATH_LEFT; fi
          ;;
        *)
          ls "$STATE/math" "$STATE/other" | grep -v -e '^$' -e ':$' || true
          if [ -n "${STUB_ALL:-}" ]; then printf '%s\n' $STUB_ALL; fi
          ;;
      esac
      return 0
      ;;
    rm)
      if [ "${STUB_RM_FAIL:-}" = 1 ]; then return 1; fi
      shift; [ "$1" = -f ] && shift
      for id in "$@"; do rm -f "$STATE/math/$id" "$STATE/other/$id"; done
      return 0
      ;;
    inspect)
      if [ "${STUB_INSPECT_FAIL:-}" = 1 ]; then return 1; fi
      for last in "$@"; do :; done
      cat "$STATE/math/$last"
      ;;
    logs)
      for last in "$@"; do :; done
      if [ "$(cat "$STATE/math/$last")" = "running 0 0" ]; then
        echo "math/bin/run: write label MATH_ENV=prod admitted"
      fi
      ;;
  esac
  return 0
}
aws() { return 1; }
"""

# The hook's single jq filter, for hosts without jq (the CI image): `-e` exits 1
# on null and 4 when nothing was produced; `strings` drops non-strings.
_JQ_SHIM = r"""#!/usr/bin/env python3
import json, sys
if sys.argv[1:] != ["-er", ".services.math.environment.MATH_ENV | strings"]:
    sys.exit("jq shim: unexpected arguments %r" % (sys.argv[1:],))
try:
    doc = json.load(sys.stdin)
    value = doc["services"]["math"]["environment"].get("MATH_ENV")
except (ValueError, KeyError, TypeError, AttributeError):
    sys.exit(5)
if not isinstance(value, str):
    sys.exit(4)
print(value)
"""

requires_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash is not available")
REAL_COMPOSE = shutil.which("docker-compose")
requires_real_compose = pytest.mark.skipif(REAL_COMPOSE is None, reason="no docker-compose binary to check precedence against")


def _run_hook_roles(tmp_path, role, *, dotenv=None, box=None, hook_env=None, compose_yml=None, **stubs):
    """Run after_install.sh from its service detection on, for `role` (None: no
    role file), with `dotenv` as the written .env (None: no .env). `box` is the
    state directory shared across runs (default: fresh). `hook_env` is added to
    the hook's own environment. Returns (returncode, stdout, stderr, log lines)."""
    text = AFTER_INSTALL_PATH.read_text()
    start = text.index("SERVICE_FROM_FILE=$(cat /etc/app-info/service_type.txt)")
    tail = text[start:].replace("/usr/local/bin/docker-compose", "compose_stub").replace("/etc/app-info/", "$APP_INFO/")
    tmp_path.mkdir(parents=True, exist_ok=True)
    app_info = tmp_path / "app-info"
    app_info.mkdir()
    if role is not None:
        (app_info / "service_type.txt").write_text(role + "\n" if role else "")
    work = tmp_path / "work"
    work.mkdir()
    if dotenv is not None:
        (work / ".env").write_text(dotenv)
    if compose_yml is not None:
        shutil.copy(compose_yml, work / "docker-compose.yml")
    stub_bin = tmp_path / "stub-bin"
    stub_bin.mkdir()
    if shutil.which("jq") is None:
        (stub_bin / "jq").write_text(_JQ_SHIM)
        (stub_bin / "jq").chmod(0o755)
    log = tmp_path / "stub.log"
    log.write_text("")
    script = tmp_path / "hook-tail.sh"
    script.write_text(_HOOK_PRELUDE + tail)
    env = {
        "PATH": f"{stub_bin}:" + os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", str(tmp_path)),
        "WORK": str(work),
        "STATE": str(box or tmp_path / "box"),
        "LOG": str(log),
        "APP_INFO": str(app_info),
        **(hook_env or {}),
        **{f"STUB_{key.upper()}": value for key, value in stubs.items()},
    }
    done = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, timeout=120)
    return done.returncode, done.stdout, done.stderr, log.read_text().splitlines()


def _compose_ups(log):
    return [line for line in log if line.startswith("compose up")]


def _math_ups(log):
    return [line for line in _compose_ups(log) if "math" in _services_named(line.split()[1:])]


PROD_ENV = "FOO=1\nMATH_ENV=prod\n"
PYTHON_ENV = "FOO=1\nMATH_ENV=python\nMATH_PYTHON_ENV=python\n"
PS_MATH = "docker ps -aq --filter label=com.docker.compose.service=math"


@requires_after_install
@requires_bash
@pytest.mark.parametrize("role", ["banana", "", "Math", "math ", "delphi-large"])
def test_unknown_or_empty_role_fails_without_starting_anything(tmp_path, role):
    code, out, err, log = _run_hook_roles(tmp_path, role, dotenv=PROD_ENV)
    assert code != 0
    assert _compose_ups(log) == [], f"role [{role}] started services: {_compose_ups(log)}"
    assert "Starting nothing" in err


@requires_after_install
@requires_bash
def test_missing_role_file_fails_without_starting_anything(tmp_path):
    code, _, _, log = _run_hook_roles(tmp_path, None, dotenv=PROD_ENV)
    assert code != 0
    assert _compose_ups(log) == []


# The math role under `python`: start nothing, prove retirement.


@requires_after_install
@requires_bash
def test_math_role_under_python_starts_nothing_and_verifies_retirement(tmp_path):
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=PYTHON_ENV, all="c1 c2")
    assert code == 0, err
    assert _compose_ups(log) == []
    assert "effective compose label for 'math': MATH_ENV=[python]" in out
    assert "math role: retirement verified" in out
    # The label is read from Compose, and retirement is checked after the cleanup it verifies.
    assert "compose config --format json" in log
    assert log.index(PS_MATH) > log.index("docker rm -f c1 c2")


@requires_after_install
@requires_bash
def test_math_role_under_python_stops_a_running_clojure(tmp_path):
    # Deploy #2 on a box where deploy #1 left Clojure running.
    box = tmp_path / "box"
    code, _, err, _ = _run_hook_roles(tmp_path / "d1", "math", dotenv=PROD_ENV, box=box)
    assert code == 0, err
    assert list((box / "math").iterdir())
    code, out, err, log = _run_hook_roles(tmp_path / "d2", "math", dotenv=PYTHON_ENV, box=box)
    assert code == 0, err
    assert _compose_ups(log) == []
    assert not list((box / "math").iterdir())
    assert "math role: retirement verified" in out


@requires_after_install
@requires_bash
def test_math_role_fails_when_a_math_container_survives_failed_cleanup(tmp_path):
    code, out, err, log = _run_hook_roles(
        tmp_path, "math", dotenv=PYTHON_ENV, down_fail="1", rm_fail="1", all="c1", math_left="c1"
    )
    assert code != 0
    assert "FAILED retirement check" in err and "c1" in err
    assert "retirement verified" not in out
    assert _compose_ups(log) == []


@requires_after_install
@requires_bash
def test_math_role_fails_when_docker_cannot_list_containers(tmp_path):
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=PYTHON_ENV, ps_fail="1")
    assert code != 0
    assert "cannot prove retirement" in err
    assert "retirement verified" not in out


@requires_after_install
@requires_bash
def test_math_role_under_python_succeeds_on_an_already_empty_box(tmp_path):
    # Idempotency: with no containers, `docker rm -f` (no arguments) fails and
    # is ignored; the postcondition still holds.
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=PYTHON_ENV, rm_fail="1", down_fail="1")
    assert code == 0, err
    assert "math role: retirement verified" in out


# The math role under `prod`: start the guarded Clojure, verify it came up.


@requires_after_install
@requires_bash
def test_math_role_under_prod_starts_clojure_and_verifies_readiness(tmp_path):
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=PROD_ENV, all="c1")
    assert code == 0, err
    (up,) = _compose_ups(log)
    assert up == "compose up -d math --build --force-recreate"
    # Resolved before the start; readiness read after it, following a wait.
    assert log.index("compose config --format json") < log.index(up) < log.index("sleep 30") < log.index(PS_MATH)
    assert any(line.startswith("docker inspect") and line.endswith("math1") for line in log)
    assert "effective compose label for 'math': MATH_ENV=[prod]" in out
    assert "guard log line seen" in out
    assert "writer readiness verified" in out


@requires_after_install
@requires_bash
@pytest.mark.parametrize(
    "state",
    ["restarting 78 2", "exited 78 0", "running 0 3", "exited 1 0", "created 0 0"],
    ids=["guard-restarting", "guard-exited", "restarted", "crashed", "not-started"],
)
def test_math_role_under_prod_fails_when_readiness_fails(tmp_path, state):
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=PROD_ENV, math_state=state)
    assert code != 0
    assert "FAILED readiness" in err and state in err
    assert "readiness verified" not in out


@requires_after_install
@requires_bash
@pytest.mark.parametrize(
    "stubs,message",
    [
        ({"up_fail": "1"}, ""),
        ({"ps_fail": "1"}, "cannot verify the writer"),
        ({"inspect_fail": "1"}, "FAILED to inspect"),
        ({"math_extra": "m2"}, "expected exactly one 'math' container, found 2"),
    ],
    ids=["up-fails", "ps-fails", "inspect-fails", "two-containers"],
)
def test_math_role_under_prod_fails_when_the_writer_cannot_be_verified(tmp_path, stubs, message):
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=PROD_ENV, **stubs)
    assert code != 0
    assert message in err
    assert "readiness verified" not in out


# The label: Compose's effective value, and fail closed on anything else.


@requires_after_install
@requires_bash
@pytest.mark.parametrize(
    "dotenv,stubs,message",
    [
        (PROD_ENV, {"config_fail": "1"}, "FAILED to read the compose config"),
        (PROD_ENV, {"config_json": "not json"}, "gives the 'math' service no MATH_ENV"),
        (PROD_ENV, {"config_json": '{"services":{}}'}, "gives the 'math' service no MATH_ENV"),
        (PROD_ENV, {"config_json": '{"services":{"math":{"environment":{"MATH_ENV":null}}}}'}, "no MATH_ENV"),
        (PROD_ENV, {"config_json": '{"services":{"math":{"environment":["MATH_ENV=prod"]}}}'}, "no MATH_ENV"),
        ("FOO=1\n", {}, "defines MATH_ENV 0 times"),
        ("MATH_ENV=prod\nMATH_ENV=python\n", {}, "defines MATH_ENV 2 times"),
        ("MATH_ENV=prod\nMATH_ENV=prod\n", {}, "defines MATH_ENV 2 times"),
        ("MATH_ENV=\n", {}, "unknown math label MATH_ENV=[]"),
        ("MATH_ENV=dev\n", {}, "unknown math label MATH_ENV=[dev]"),
        ("MATH_ENV=PROD\n", {}, "unknown math label MATH_ENV=[PROD]"),
        ("MATH_ENV=prod,python\n", {}, "unknown math label"),
        (PYTHON_ENV, {"compose_shell_math_env": "prod"}, "something outside .env overrides it"),
        (PROD_ENV, {"compose_shell_math_env": "python"}, "something outside .env overrides it"),
    ],
    ids=[
        "config-unreadable", "config-garbled", "no-math-service", "null-label", "list-env",
        "missing-key", "ambiguous-duplicate", "duplicate-same", "empty", "dev", "uppercase",
        "list-value", "stray-env-prod-over-python", "stray-env-python-over-prod",
    ],
)
def test_math_role_fails_closed_on_an_unresolved_label(tmp_path, dotenv, stubs, message):
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=dotenv, **stubs)
    assert code != 0
    assert message in err
    assert _compose_ups(log) == []
    assert PS_MATH not in log, "a refused label must not reach either branch"


@requires_after_install
@requires_bash
@pytest.mark.parametrize("dotenv,label", [('MATH_ENV="prod"\n', "prod"), ("export MATH_ENV=python \n", "python")])
def test_math_role_accepts_quoted_or_exported_dotenv_forms(tmp_path, dotenv, label):
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=dotenv)
    assert code == 0, err
    assert f"MATH_ENV=[{label}]" in out
    assert bool(_math_ups(log)) == (label == "prod")


@requires_after_install
@requires_bash
@pytest.mark.parametrize("dotenv,expected", [(PYTHON_ENV, "python"), (PROD_ENV, "prod")])
def test_hook_shell_math_env_does_not_choose_the_branch(tmp_path, dotenv, expected):
    # The hook never consults its own MATH_ENV: sudo does not hand it to Compose
    # here, so Compose's value (from .env) decides, whatever the hook's shell says.
    stray = "prod" if expected == "python" else "python"
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=dotenv, hook_env={"MATH_ENV": stray})
    assert code == 0, err
    assert f"MATH_ENV=[{expected}]" in out
    assert bool(_math_ups(log)) == (expected == "prod")


@requires_after_install
@requires_bash
@requires_real_compose
@requires_checkout
@pytest.mark.parametrize(
    "dotenv,compose_env,outcome",
    [
        (PYTHON_ENV, None, "python"),
        (PROD_ENV, None, "prod"),
        (PYTHON_ENV, "prod", "refused"),  # shell beats .env in Compose
        (PROD_ENV, "python", "refused"),
        ("FOO=1\n", None, "refused"),  # Compose would default to prod
        ("MATH_ENV=prod\nMATH_ENV=python\n", None, "refused"),  # Compose takes the last
    ],
    ids=["python", "prod", "stray-prod", "stray-python", "missing", "duplicate"],
)
def test_math_role_label_against_the_real_compose(tmp_path, dotenv, compose_env, outcome):
    # `config` goes to the installed docker-compose, run on the checkout's
    # docker-compose.yml; the variable reaches Compose as a leaked sudo env would.
    hook_env = {} if compose_env is None else {"MATH_ENV": compose_env}
    code, out, err, log = _run_hook_roles(
        tmp_path,
        "math",
        dotenv=dotenv,
        hook_env=hook_env,
        compose_yml=CHECKOUT / "docker-compose.yml",
        real_compose=REAL_COMPOSE,
    )
    if outcome == "refused":
        assert code != 0
        assert "Starting nothing" in err
        assert _compose_ups(log) == []
    else:
        assert code == 0, err
        assert f"MATH_ENV=[{outcome}]" in out
        assert bool(_math_ups(log)) == (outcome == "prod")


# Replacement and rollback.


@requires_after_install
@requires_bash
@pytest.mark.parametrize("dotenv,label", [(PROD_ENV, "prod"), (PYTHON_ENV, "python")])
def test_fresh_replacement_box_follows_the_label(tmp_path, dotenv, label):
    # An ASG replacement runs the last successful (this) hook on an empty box:
    # no containers, so `docker rm -f` gets no ids and fails (ignored).
    code, out, err, log = _run_hook_roles(tmp_path, "math", dotenv=dotenv, rm_fail="1")
    assert code == 0, err
    box = tmp_path / "box" / "math"
    if label == "prod":
        assert len(_math_ups(log)) == 1 and "writer readiness verified" in out
        assert [p.read_text().strip() for p in box.iterdir()] == ["running 0 0"]
    else:
        assert _compose_ups(log) == [] and "retirement verified" in out
        assert not list(box.iterdir())


@requires_after_install
@requires_bash
def test_rollback_python_to_prod_restarts_clojure(tmp_path):
    box = tmp_path / "box"
    code, _, err, log = _run_hook_roles(tmp_path / "switched", "math", dotenv=PYTHON_ENV, box=box)
    assert code == 0, err
    assert _compose_ups(log) == []
    # Rollback: only the secret changes; the same hook redeploys.
    code, out, err, log = _run_hook_roles(tmp_path / "rolled-back", "math", dotenv=PROD_ENV, box=box)
    assert code == 0, err
    assert _math_ups(log) == ["compose up -d math --build --force-recreate"]
    assert "writer readiness verified" in out


@requires_after_install
@requires_bash
def test_known_roles_still_start_their_services(tmp_path):
    for role, services in (
        ("server", {"server", "nginx-proxy", "client-participation-alpha"}),
        ("delphi", {"delphi", "math-python"}),
    ):
        code, _, err, log = _run_hook_roles(tmp_path / role, role, dotenv=PYTHON_ENV)
        assert code == 0, err
        (up,) = _compose_ups(log)
        assert _services_named(up.split()[1:]) == services
        assert "compose config --format json" not in log, "only the math role resolves the math label"


# --- Clojure's own write-label guard (math/bin/run, review 1439 R1) ------------
#
# CodeDeploy can run a hook packaged BEFORE the switch (an ASG replacement gets
# the last successful revision) against the current compose and secret. That
# hook's math role still runs `up -d math`, which builds math/ from the stable
# checkout, so the engine's entrypoint refuses any label but `prod` itself.

MATH_RUN = Path("math") / "bin" / "run"
MATH_RUN_TEST = Path("math") / "bin" / "test-run-guard.sh"


def _find_in_checkout(rel):
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / rel).is_file():
            return candidate / rel
    return None


MATH_RUN_PATH = _find_in_checkout(MATH_RUN)
MATH_RUN_TEST_PATH = _find_in_checkout(MATH_RUN_TEST)
requires_math_run = pytest.mark.skipif(
    MATH_RUN_PATH is None or shutil.which("sh") is None,
    reason=f"{MATH_RUN} not found in $POLIS_CHECKOUT_DIR nor any ancestor of this file",
)


def _run_math_entrypoint(tmp_path, env):
    """Run math/bin/run with `env` only; `timeout` (which wraps the JVM) is a
    stub that records the start and stops the loop. Returns (code, started, stderr)."""
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir()
    started = tmp_path / "started"
    stub = stub_dir / "timeout"
    stub.write_text('#!/bin/sh\necho "$*" > "$STARTED"\nkill -PIPE "$PPID"\n')
    stub.chmod(0o755)
    full_env = {"PATH": f"{stub_dir}:/usr/bin:/bin", "STARTED": str(started), **env}
    done = subprocess.run(["sh", str(MATH_RUN_PATH)], env=full_env, capture_output=True, text=True, timeout=60)
    return done.returncode, started.is_file(), done.stderr


@requires_math_run
@requires_checkout
@pytest.mark.parametrize(
    "secret",
    [POST_SWITCH_SECRET, {**POST_SWITCH_SECRET, "MATH_CLOJURE_ALLOW_NONPROD_ENV": "1"}],
    ids=["post-switch-secret", "post-switch-secret-with-opt-in"],
)
def test_old_hook_with_new_compose_and_python_secret_cannot_start_clojure(tmp_path, secret):
    math_env = _environment("docker-compose.yml", "math", secret)
    assert math_env["MATH_ENV"] == "python"
    # Production compose never forwards the dev/test opt-in, even from the secret.
    assert "MATH_CLOJURE_ALLOW_NONPROD_ENV" not in math_env
    code, started, err = _run_math_entrypoint(tmp_path, math_env)
    assert code == 78 and not started, err
    assert "refusing to start" in err


@requires_math_run
@requires_checkout
def test_clojure_starts_under_the_rollback_secret(tmp_path):
    math_env = _environment("docker-compose.yml", "math", {"MATH_ENV": "prod", "MATH_PYTHON_ENV": "python"})
    code, started, err = _run_math_entrypoint(tmp_path, math_env)
    assert started, err


@requires_math_run
@requires_checkout
def test_test_stack_opts_in_to_its_dev_label(tmp_path):
    math_env = _environment("docker-compose.test.yml", "math")
    assert math_env["MATH_ENV"] == "dev"
    assert math_env["MATH_CLOJURE_ALLOW_NONPROD_ENV"] == "1"
    code, started, err = _run_math_entrypoint(tmp_path, math_env)
    assert started, err


@pytest.mark.skipif(MATH_RUN_TEST_PATH is None or shutil.which("sh") is None, reason=f"{MATH_RUN_TEST} not found")
def test_math_run_guard_shell_suite():
    done = subprocess.run(["sh", str(MATH_RUN_TEST_PATH)], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "0 failed" in done.stdout
