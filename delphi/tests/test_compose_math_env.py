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


# --- The switch to Python (readers on `python`, Clojure out of the deploy) ---
#
# Production sets MATH_ENV=python in the env secret: the server (env_file) and
# Delphi (interpolation) read the label math-python writes. The Clojure `math`
# service writes under ${MATH_ENV} too, so it must not be started while that
# holds; the math role therefore starts nothing. Rollback = MATH_ENV=prod in the
# secret, restore the math role's `up -d math` line, redeploy.

POST_SWITCH_SECRET = {"MATH_ENV": "python", "MATH_PYTHON_ENV": "python"}


@requires_after_install
def test_math_role_starts_nothing():
    roles = _role_up_lines()
    assert "math" in roles, "the math role branch must stay (its boxes still run the hook)"
    assert roles["math"] == [], "the math role must not run any compose up line"


@requires_after_install
def test_no_role_starts_the_clojure_math_service():
    roles = _role_up_lines()
    starting = {role for role, lines in roles.items() if any("math" in _services_named(l) for l in lines)}
    assert starting == set(), f"roles still starting the Clojure math service: {sorted(starting)}"


@requires_after_install
def test_hook_documents_the_readers_label_and_the_rollback_order():
    # Comment lines joined, so the checks do not depend on where lines wrap.
    text = re.sub(r"\s*\n\s*#\s*", " ", AFTER_INSTALL_PATH.read_text())
    assert "MATH_ENV=python" in text
    # Forward: a box deploy packages this hook (CodeDeploy runs the packaged
    # hook, and gives ASG replacements the last successful one) BEFORE the
    # secret moves; a second deploy then switches the readers (review 1439 R1).
    assert (
        "merge to stable, then a box deploy while the secret still says MATH_ENV=prod, "
        "then MATH_ENV=python in the secret, then a second box deploy" in text
    )
    assert "last successful" in text
    # Rollback must change the secret before Clojure is restored, or Clojure
    # would start writing under `python` beside the Python poller.
    assert "set MATH_ENV=prod in the secret FIRST" in text


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


# --- The hook's role section, executed (review 1439 R3) ------------------------
#
# The text checks above only see compose lines that NAME services. These run the
# hook itself, from its service detection to the end, with inert stand-ins for
# sudo, docker, docker-compose and aws, so an unnamed `up`, an ignored cleanup
# failure or a missing postcondition shows up as behaviour, not as text.

_HOOK_PRELUDE = r"""
set -e
cd "$WORK"
sudo() { "$@"; }
compose_stub() {
  echo "compose $*" >> "$LOG"
  if [ "$1" = down ] && [ "${STUB_DOWN_FAIL:-}" = 1 ]; then return 1; fi
  return 0
}
docker() {
  echo "docker $*" >> "$LOG"
  case "$1" in
    ps)
      case " $* " in
        *" --filter "*)
          if [ "${STUB_PS_FAIL:-}" = 1 ]; then return 1; fi
          if [ -n "${STUB_MATH_LEFT:-}" ]; then printf '%s\n' $STUB_MATH_LEFT; fi
          ;;
        *)
          if [ -n "${STUB_ALL:-}" ]; then printf '%s\n' $STUB_ALL; fi
          ;;
      esac
      return 0
      ;;
    rm)
      if [ "${STUB_RM_FAIL:-}" = 1 ]; then return 1; fi
      return 0
      ;;
  esac
  return 0
}
aws() { return 1; }
"""

requires_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash is not available")


def _run_hook_roles(tmp_path, role, **stubs):
    """Run after_install.sh from its service detection on, for `role` (None: no
    role file). Returns (returncode, stdout, stderr, stub log lines)."""
    text = AFTER_INSTALL_PATH.read_text()
    start = text.index("SERVICE_FROM_FILE=$(cat /etc/app-info/service_type.txt)")
    tail = text[start:].replace("/usr/local/bin/docker-compose", "compose_stub").replace("/etc/app-info/", "$APP_INFO/")
    app_info = tmp_path / "app-info"
    app_info.mkdir()
    if role is not None:
        (app_info / "service_type.txt").write_text(role + "\n" if role else "")
    work = tmp_path / "work"
    work.mkdir()
    log = tmp_path / "stub.log"
    log.write_text("")
    script = tmp_path / "hook-tail.sh"
    script.write_text(_HOOK_PRELUDE + tail)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "WORK": str(work),
        "LOG": str(log),
        "APP_INFO": str(app_info),
        **{f"STUB_{key.upper()}": value for key, value in stubs.items()},
    }
    done = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, timeout=60)
    return done.returncode, done.stdout, done.stderr, log.read_text().splitlines()


def _compose_ups(log):
    return [line for line in log if line.startswith("compose up")]


@requires_after_install
@requires_bash
@pytest.mark.parametrize("role", ["banana", "", "Math", "math ", "delphi-large"])
def test_unknown_or_empty_role_fails_without_starting_anything(tmp_path, role):
    code, out, err, log = _run_hook_roles(tmp_path, role)
    assert code != 0
    assert _compose_ups(log) == [], f"role [{role}] started services: {_compose_ups(log)}"
    assert "Starting nothing" in err


@requires_after_install
@requires_bash
def test_missing_role_file_fails_without_starting_anything(tmp_path):
    code, _, _, log = _run_hook_roles(tmp_path, None)
    assert code != 0
    assert _compose_ups(log) == []


@requires_after_install
@requires_bash
def test_math_role_verifies_retirement_and_logs_it(tmp_path):
    code, out, err, log = _run_hook_roles(tmp_path, "math", all="c1 c2")
    assert code == 0, err
    assert _compose_ups(log) == []
    assert "docker ps -aq --filter label=com.docker.compose.service=math" in log
    assert "math role: retirement verified" in out
    # The check runs after the cleanup it verifies.
    assert log.index("docker ps -aq --filter label=com.docker.compose.service=math") > log.index("docker rm -f c1 c2")


@requires_after_install
@requires_bash
def test_math_role_fails_when_a_math_container_survives_failed_cleanup(tmp_path):
    # The reviewer's witness: both cleanup calls fail, the hook used to succeed.
    code, out, err, log = _run_hook_roles(
        tmp_path, "math", down_fail="1", rm_fail="1", all="c1", math_left="c1"
    )
    assert code != 0
    assert "FAILED retirement check" in err and "c1" in err
    assert "retirement verified" not in out
    assert _compose_ups(log) == []


@requires_after_install
@requires_bash
def test_math_role_fails_when_docker_cannot_list_containers(tmp_path):
    code, out, err, log = _run_hook_roles(tmp_path, "math", ps_fail="1")
    assert code != 0
    assert "cannot prove retirement" in err
    assert "retirement verified" not in out


@requires_after_install
@requires_bash
def test_math_role_succeeds_on_an_already_empty_box(tmp_path):
    # Idempotency: with no containers, `docker rm -f` (no arguments) fails and
    # is ignored; the postcondition still holds.
    code, out, err, log = _run_hook_roles(tmp_path, "math", rm_fail="1", down_fail="1")
    assert code == 0, err
    assert "math role: retirement verified" in out


@requires_after_install
@requires_bash
def test_known_roles_still_start_their_services(tmp_path):
    for role, services in (
        ("server", {"server", "nginx-proxy", "client-participation-alpha"}),
        ("delphi", {"delphi", "math-python"}),
    ):
        sub = tmp_path / role
        sub.mkdir()
        code, _, err, log = _run_hook_roles(sub, role)
        assert code == 0, err
        (up,) = _compose_ups(log)
        assert _services_named(up.split()[1:]) == services

