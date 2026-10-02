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
@pytest.mark.parametrize("env", [{}, {"MATH_ENV": PROBE}], ids=["unset", "MATH_ENV-set"])
def test_test_stack_delphi_and_math_agree_on_math_env(env):
    delphi = _environment("docker-compose.test.yml", "delphi", env)
    math = _environment("docker-compose.test.yml", "math", env)
    assert math["MATH_ENV"] == env.get("MATH_ENV", "dev")
    assert delphi["MATH_ENV"] == math["MATH_ENV"], (
        "docker-compose.test.yml: delphi reads a different math_env than math writes"
    )


# --- The served-label switch (docker-compose.yml) -----------------------------
# The shared MATH_ENV sets the label the readers serve (the server via .env,
# delphi here). Neither writer follows it: Clojure writes MATH_ENV_CLOJURE
# (default prod), math-python writes MATH_PYTHON_ENV (default python). So the
# switch (MATH_ENV=python) and its rollback (MATH_ENV=prod) move only the
# readers, and Clojure keeps writing prod through both.


@requires_checkout
@pytest.mark.parametrize(
    "env",
    [{}, {"MATH_ENV": "prod"}, {"MATH_ENV": "python"}, {"MATH_ENV": PROBE}, {"MATH_ENV_CLOJURE": ""}],
    ids=["unset", "prod", "python", "probe", "clojure-empty"],
)
def test_clojure_writes_prod_whatever_the_readers_serve(env):
    assert _environment("docker-compose.yml", "math", env)["MATH_ENV"] == "prod"


@requires_checkout
def test_clojure_label_comes_only_from_math_env_clojure():
    env = {"MATH_ENV": "python", "MATH_ENV_CLOJURE": PROBE}
    assert _environment("docker-compose.yml", "math", env)["MATH_ENV"] == PROBE
    assert _environment("docker-compose.yml", "delphi", env)["MATH_ENV"] == "python"
    assert _environment("docker-compose.yml", "math-python", env)["MATH_ENV"] == "python"


@requires_checkout
@pytest.mark.parametrize("served", ["prod", "python"], ids=["shadow-or-rollback", "switched"])
def test_switch_moves_only_the_readers(served):
    env = {"MATH_ENV": served}
    labels = {
        service: _environment("docker-compose.yml", service, env)["MATH_ENV"]
        for service in ("delphi", "math", "math-python")
    }
    assert labels == {"delphi": served, "math": "prod", "math-python": "python"}
    # Two writers never share a label.
    assert labels["math"] != labels["math-python"]


@requires_checkout
def test_delphi_does_not_follow_the_shadow_poller_env():
    # docker-compose.yml gives math-python its own write label; reports must
    # follow the server's MATH_ENV (the served label), not the writer's.
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


# --- Production shadow wiring (scripts/after_install.sh, Delphi role) --------
#
# Production boxes do not pass --profile: each CodeDeploy role starts its
# services BY NAME, and Compose enables the profiles of services named on the
# command line. The shadow poller therefore runs exactly where the Delphi
# role's `up` line names it. CI copies the script into the checkout-shaped
# root ($POLIS_CHECKOUT_DIR) beside the projection-gate inputs.

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


# --- Pre-switch backfill (P-070) ---------------------------------------------
# The backfill runs inside math-python, off unless the secret sets
# MATH_BACKFILL=1; switching it on or off is a secret change and a redeploy.


@requires_checkout
def test_math_python_backfill_is_off_by_default_and_its_settings_parse():
    from polismath.poller.backfill import ENV_NAMES, BackfillConfig

    env = _environment("docker-compose.yml", "math-python", {})
    forwarded = {k: v for k, v in env.items() if k.startswith("MATH_BACKFILL")}
    assert set(forwarded) <= set(ENV_NAMES.values())
    config = BackfillConfig.from_env(forwarded)
    assert not config.enabled
    assert config.source_env == "prod" and config.concurrency == 1
    assert config.gate_after_largest == 10 and not config.gate_approved
    # No extra per-job ceiling by default: the shared memory budget decides.
    assert config.memory_ceiling_mb == 0
    # Source-ahead stays unresolved (excluded, counted) until a ruling.
    assert config.source_ahead_ruling == "unresolved" and not config.accept_source_ahead
    ruled = BackfillConfig.from_env(_environment(
        "docker-compose.yml", "math-python",
        {"MATH_BACKFILL_SOURCE_AHEAD_RULING": "accept_input"}))
    assert ruled.accept_source_ahead

    on = BackfillConfig.from_env(
        _environment("docker-compose.yml", "math-python", {"MATH_BACKFILL": "1"})
    )
    assert on.enabled and on.state_path == "/app/backfill-state/state.json"


@requires_checkout
def test_math_python_keeps_backfill_state_on_a_named_volume():
    document = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())
    block = document["services"]["math-python"]
    assert "math-backfill-state:/app/backfill-state" in block.get("volumes", [])
    assert "math-backfill-state" in document["volumes"]
    assert block.get("profiles") == ["math-python"]


@requires_checkout
def test_math_python_forwards_the_shared_memory_admission_settings(monkeypatch):
    """Every compute path in math-python reserves against the cgroup limit
    (the deploy.resources limit) minus a headroom; the settings parse."""
    from polismath.poller.service import PollerConfig

    env = _environment("docker-compose.yml", "math-python", {})
    assert env["MATH_POLLER_MEMORY_HEADROOM"] == "0.15"
    assert env["MATH_CONV_CACHE_MB"] == ""
    for key, value in env.items():
        if key.startswith(("MATH_POLLER_MEM", "MATH_CONV_CACHE")):
            monkeypatch.setenv(key, value)
    cfg = PollerConfig.from_env()
    assert cfg.memory_headroom == 0.15 and cfg.conv_cache_mb is None
    assert (cfg.mem_per_mcell_mb, cfg.mem_per_vote_row_bytes, cfg.mem_safety) == (133, 1000, 1.15)
    assert cfg.mem_job_floor_mb == 64
