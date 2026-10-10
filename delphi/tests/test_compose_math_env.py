"""Every compose stack must hand delphi the math_env its math engine writes.

The report pipeline reads ``math_main`` / ``math_ptptstats`` scoped by
``math_env`` (see ``tests/test_report_math_env.py``). The delphi service has no
``env_file:``, so ``--env-file`` only feeds ``${...}`` interpolation, never the
container environment, and nothing on the report import path calls
``load_dotenv()``: unless the service block lists ``MATH_ENV``, the report
container falls back to the library default in
``polismath/components/config.py`` regardless of what the stack is configured
for. If that resolves to a different env than the one the math engine
(``math-python``) writes under, ``GroupDataProcessor.get_math_main_by_conversation`` finds no row
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
    math = _environment("docker-compose.test.yml", "math-python", env)
    assert math["MATH_ENV"] == env.get("MATH_ENV", "dev")
    assert delphi["MATH_ENV"] == math["MATH_ENV"], (
        "docker-compose.test.yml: delphi reads a different math_env than math-python writes"
    )


@requires_checkout
@pytest.mark.parametrize("compose_file", sorted(COMPOSE_FILES))
def test_math_python_has_a_memory_limit(compose_file):
    # The poller refuses to start when the cgroup reports no memory limit.
    block = yaml.safe_load((CHECKOUT / compose_file).read_text())["services"]["math-python"]
    assert block["deploy"]["resources"]["limits"]["memory"]


@requires_checkout
@pytest.mark.parametrize("compose_file", sorted(COMPOSE_FILES))
def test_the_retired_clojure_engine_is_not_wired(compose_file):
    # The Clojure `math` service is retired; its `prod` rows stay in the
    # database, but nothing in a compose stack builds, runs or labels it.
    document = yaml.safe_load((CHECKOUT / compose_file).read_text())
    assert "math" not in document["services"]
    assert "MATH_ENV_CLOJURE" not in (CHECKOUT / compose_file).read_text()


# --- The served label (docker-compose.yml) ------------------------------------
# The shared MATH_ENV sets the label the readers serve (the server via .env,
# delphi here). The writer does not follow it: math-python writes
# MATH_PYTHON_ENV (default python). So moving the readers (MATH_ENV=python, or
# back to the frozen `prod` rows) never moves the writer.


@requires_checkout
@pytest.mark.parametrize("served", ["prod", "python"], ids=["frozen-prod", "python"])
def test_switch_moves_only_the_readers(served):
    env = {"MATH_ENV": served}
    labels = {
        service: _environment("docker-compose.yml", service, env)["MATH_ENV"]
        for service in ("delphi", "math-python")
    }
    assert labels == {"delphi": served, "math-python": "python"}


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
def test_the_retired_math_role_starts_nothing():
    # A box still tagged `math` must neither start the removed Clojure service
    # nor fall through to the hook's start-everything catch-all.
    roles = _role_up_lines()
    assert roles.get("math") == []


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


# --- LLM selection keys (delphi service) --------------------------------------
# The delphi service has no env_file, so a provider/model key the code reads is
# invisible unless the service block lists it: a deployment env document that
# sets LLM_PROVIDER or ANTHROPIC_TOPIC_MODEL would otherwise be silently ignored
# and topic naming would fall back to ANTHROPIC_MODEL.

# key -> value the container sees when the stack leaves it unset. Each default
# must be one the code accepts: TOPIC_BATCH_MAX_WAIT_SECONDS is parsed with
# float() and SENTENCE_TRANSFORMER_MODEL is used as given, so neither may be "".
LLM_SELECTION_DEFAULTS = {
    "LLM_PROVIDER": "anthropic",
    "ANTHROPIC_MODEL": "",
    "ANTHROPIC_TOPIC_MODEL": "",
    "TOPIC_BATCH_MAX_WAIT_SECONDS": "1800",
    "SENTENCE_TRANSFORMER_MODEL": "all-MiniLM-L6-v2",
    "OLLAMA_HOST": "",
    "OLLAMA_ENDPOINT": "",
    "OLLAMA_MODEL": "",
}
_LLM_KEY_READ = re.compile(
    r"""(?:environ\.get|getenv|environ\[)\(?\s*["'](?P<key>(?:LLM_|ANTHROPIC_|OLLAMA_)[A-Z_]+|SENTENCE_TRANSFORMER_MODEL|TOPIC_BATCH_[A-Z_]+)["']"""
)
# Read by the code but not a selection knob: the API key is already forwarded
# on its own line and checked below as part of the environment block.
_NOT_SELECTION = {"ANTHROPIC_API_KEY"}


def _llm_keys_read_by_delphi() -> set:
    """Every LLM-selection key some Delphi module reads, found by scanning the
    source beside tests/ (the delphi dir in a checkout, /app in the CI image)."""
    root = Path(__file__).resolve().parent.parent
    keys = set()
    for path in root.rglob("*.py"):
        parts = path.relative_to(root).parts
        # Skip the tests and any installed packages (a local .venv, site-packages).
        if "tests" in parts or "site-packages" in parts or any(p.startswith(".") for p in parts):
            continue
        keys |= {m["key"] for m in _LLM_KEY_READ.finditer(path.read_text(errors="ignore"))}
    return keys - _NOT_SELECTION


def test_every_llm_key_the_code_reads_is_listed_here():
    read = _llm_keys_read_by_delphi()
    assert {"LLM_PROVIDER", "ANTHROPIC_TOPIC_MODEL"} <= read, "source scan found nothing"
    assert read <= set(LLM_SELECTION_DEFAULTS), (
        f"Delphi reads {sorted(read - set(LLM_SELECTION_DEFAULTS))} but this test "
        "(and docker-compose.yml's delphi service) does not forward them"
    )


@requires_checkout
@pytest.mark.parametrize("key", sorted(LLM_SELECTION_DEFAULTS))
def test_delphi_forwards_llm_selection_key(key):
    probe = f"probe-{key.lower()}"
    forwarded = _environment("docker-compose.yml", "delphi", {key: probe})
    assert forwarded.get(key) == probe, (
        f"docker-compose.yml's delphi service does not forward {key}; a value set "
        "in .env or the deployment env document never reaches the container"
    )


@requires_checkout
def test_delphi_llm_selection_defaults_when_unset():
    env = _environment("docker-compose.yml", "delphi", {})
    assert {key: env.get(key) for key in LLM_SELECTION_DEFAULTS} == LLM_SELECTION_DEFAULTS
    assert "ANTHROPIC_API_KEY" in env


# --- Datadog tracer gate (delphi image CMD) -----------------------------------
# The job poller runs under ddtrace-run only when DD_TRACE_ENABLED=true. With no
# Datadog agent listening the tracer only logs failed sends, so the default is
# off; the ddtrace package stays installed so tracing can be switched back on.

DOCKERFILE = Path(__file__).resolve().parent.parent / "Dockerfile"
requires_dockerfile = pytest.mark.skipif(
    not DOCKERFILE.is_file(), reason=f"{DOCKERFILE} not found (CI copies only tests/)"
)


def _image_cmd() -> list:
    """The final stage's CMD exec form, with Dockerfile line continuations joined."""
    import json

    text = DOCKERFILE.read_text()
    start = text.index('CMD ["bash", "-c"')
    end = text.index('"]', start) + 2
    return json.loads(text[start + len("CMD "):end].replace("\\\n", ""))


def _run_cmd(tmp_path, env: dict) -> list:
    """Run the image CMD with stub `python`/`ddtrace-run` on PATH; return the
    commands the stubs saw."""
    import subprocess

    log = tmp_path / "calls"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("python", "ddtrace-run"):
        stub = bin_dir / name
        stub.write_text(f'#!/bin/sh\necho "{name} $*" >> "{log}"\n')
        stub.chmod(0o755)
    argv = _image_cmd()
    assert argv[:2] == ["bash", "-c"]
    full_env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "AWS_REGION": "us-east-1", **env}
    subprocess.run(argv, env=full_env, cwd=tmp_path, check=True, capture_output=True, timeout=30)
    return [line for line in log.read_text().splitlines() if "job_poller.py" in line]


@requires_dockerfile
@pytest.mark.parametrize(
    "env,traced",
    [({}, False), ({"DD_TRACE_ENABLED": "false"}, False), ({"DD_TRACE_ENABLED": ""}, False),
     ({"DD_TRACE_ENABLED": "true"}, True)],
    ids=["unset", "false", "empty", "true"],
)
def test_job_poller_runs_under_ddtrace_only_when_enabled(tmp_path, env, traced):
    (call,) = _run_cmd(tmp_path, env)
    assert call.startswith("ddtrace-run python ") == traced
    if not traced:
        assert call.startswith("python scripts/job_poller.py")


@requires_checkout
def test_compose_leaves_the_tracer_off_unless_enabled():
    assert _environment("docker-compose.yml", "delphi")["DD_TRACE_ENABLED"] == "false"
    on = _environment("docker-compose.yml", "delphi", {"DD_TRACE_ENABLED": "true"})
    assert on["DD_TRACE_ENABLED"] == "true"


# --- The large memory class (P-073, r2): the forwarding on math-python ---------
# Compose forwards only what a service lists, so a MATH_CAPACITY_* setting the
# code reads but the service does not list is invisible in production. Every
# key is checked against the names the code itself declares. There is no large
# poller service: the large class runs as queue jobs (a child under the
# polis-jobs daemon on the large box), never as a resident poller.

LARGE_LABEL = "python-large"
CAPACITY_KEYS = {
    "MATH_CAPACITY_ROUTING", "MATH_CAPACITY_ROUTE_FRACTION", "MATH_CAPACITY_KEEP_FRACTION",
    "MATH_CAPACITY_RESIZE_S", "MATH_CAPACITY_STATE_PATH", "MATH_CAPACITY_LARGE_BUDGET_MB",
    "MATH_CAPACITY_PROMOTE", "MATH_CAPACITY_RESTAGE", "MATH_CAPACITY_QUEUE_DSN",
    "MATH_CAPACITY_QUEUE_ENV",
}
# Read only by the queue child (its own side of the hand-off), never a
# small-poller setting.
CHILD_ONLY_CAPACITY_KEYS = {"MATH_CAPACITY_PROMOTE_INTO"}
AWS_KEYS = ("AWS_REGION", "AWS_S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")


def _capacity_keys_read() -> set:
    """Every MATH_CAPACITY_* name polismath.poller.capacity declares."""
    from polismath.poller import capacity

    keys = {value for name, value in vars(capacity).items()
            if name.endswith("_ENV") and isinstance(value, str) and value.startswith("MATH_CAPACITY_")}
    assert {"MATH_CAPACITY_ROUTING", "MATH_CAPACITY_QUEUE_DSN"} <= keys, "found no settings"
    assert "MATH_CAPACITY_MANIFEST_URI" not in keys, "the manifest is gone (P-073 r2)"
    return keys


def _raw_environment(service: str) -> dict:
    block = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"][service]
    return {e.partition("=")[0]: e.partition("=")[2] for e in block["environment"]}


def _service(service: str) -> dict:
    return yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"][service]


@requires_checkout
def test_math_python_forwards_every_capacity_setting():
    env = _environment("docker-compose.yml", "math-python")
    missing = _capacity_keys_read() - CHILD_ONLY_CAPACITY_KEYS - set(env)
    assert not missing, f"math-python does not forward {sorted(missing)}"
    assert CAPACITY_KEYS <= _capacity_keys_read()


@requires_checkout
@pytest.mark.parametrize("key", sorted(CAPACITY_KEYS))
def test_math_python_passes_each_capacity_value_through(key):
    probe = f"probe-{key.lower()}"
    assert _environment("docker-compose.yml", "math-python", {key: probe})[key] == probe


@requires_checkout
def test_math_python_capacity_defaults_are_off_and_equal_the_code_defaults():
    from polismath.poller.capacity import CapacitySettings

    env = _environment("docker-compose.yml", "math-python", {})
    settings = CapacitySettings.from_env(env)
    assert settings == CapacitySettings()
    assert not settings.routing and not settings.promote and not settings.large
    assert settings.queue_dsn is None and settings.queue_env is None
    assert settings.state_path is None
    assert settings.staged_label == LARGE_LABEL


@requires_checkout
def test_math_python_is_always_the_small_class():
    # A shared env document that names the large class must not turn the
    # small poller (the `python` writer) into a large worker; the CLI refuses
    # MATH_CAPACITY_CLASS=large outright (the large class is a queue child).
    env = _environment("docker-compose.yml", "math-python", {"MATH_CAPACITY_CLASS": "large"})
    assert env["MATH_CAPACITY_CLASS"] == "small"


@requires_checkout
@pytest.mark.parametrize("env", [{}, {"MATH_ENV": "python"}, {"MATH_PYTHON_ENV": PROBE},
                                 {"MATH_CAPACITY_STAGED_LABEL": "python"}],
                         ids=["unset", "served-python", "small-label", "label-is-not-a-knob"])
def test_the_staged_label_is_the_literal_and_never_the_small_one(env):
    small = _environment("docker-compose.yml", "math-python", env)
    assert small["MATH_CAPACITY_STAGED_LABEL"] == LARGE_LABEL
    assert small["MATH_CAPACITY_STAGED_LABEL"] != small["MATH_ENV"]
    assert small["MATH_ENV"] not in ("prod", "")


@requires_checkout
def test_there_is_no_large_poller_service_and_no_manifest():
    document = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())
    assert "math-python-large" not in document["services"]
    assert "math-large-state" not in (document.get("volumes") or {})
    text = (CHECKOUT / "docker-compose.yml").read_text()
    assert "MATH_CAPACITY_MANIFEST_URI" not in text
    # The queue is reached over its own DSN; the broad DATABASE_URL login is
    # never the queue login, and the small poller receives no AWS client
    # settings (the manifest store that needed them is gone).
    raw = _raw_environment("math-python")
    assert raw["MATH_CAPACITY_QUEUE_DSN"] == "${MATH_CAPACITY_QUEUE_DSN:-}"
    assert raw["MATH_CAPACITY_QUEUE_ENV"] == "${MATH_CAPACITY_QUEUE_ENV:-}"
    forwarded = _environment("docker-compose.yml", "math-python",
                             {k: f"probe-{k.lower()}" for k in AWS_KEYS})
    assert not set(AWS_KEYS) & set(forwarded)


# --- The large box's deploy hooks (service type `delphi-large`) ---------------

APPLICATION_STOP = Path("scripts") / "application_stop.sh"
_ROLE_BLOCK = re.compile(r'^(?:if|elif) \[ "\$SERVICE_FROM_FILE" == "(?P<role>[a-z-]+)" \]; then$')
_STOP_BRANCH = re.compile(r'^  (?:if|elif) \[ "\$SERVICE_TYPE" == "(?P<role>[a-z-]+)" \]; then$')


def _role_bodies() -> dict:
    """{role: [code lines]} for each top-level role branch of after_install.sh."""
    roles, current = {}, None
    for line in AFTER_INSTALL_PATH.read_text().splitlines():
        match = _ROLE_BLOCK.match(line)
        if match:
            current = match["role"]
            roles[current] = []
            continue
        if line.startswith(("else", "fi")):
            current = None
            continue
        code = line.split("#", 1)[0].strip()
        if current and code:
            roles[current].append(code)
    return roles


@requires_after_install
def test_the_large_box_starts_no_compose_service():
    # The large box's worker is the polis-jobs daemon (class large), whose
    # service lands with the daemon; until then the branch starts nothing.
    roles = _role_up_lines()
    assert roles.get("delphi-large", []) == []
    assert "delphi-large" in _role_bodies()


@requires_after_install
def test_no_role_starts_a_large_poller():
    roles = _role_up_lines()
    starting = {role for role, lines in roles.items()
                if any("math-python-large" in _services_named(l) for l in lines)}
    assert starting == set()
    # The Delphi box is unchanged.
    (delphi,) = roles["delphi"]
    assert _services_named(delphi) == {"delphi", "math-python"}


@requires_after_install
def test_the_delphi_box_writes_the_readiness_identity_before_starting():
    body = _role_bodies()["delphi"]
    assert "poller_identity" in body
    up = next(i for i, line in enumerate(body) if line.startswith("sudo /usr/local/bin/docker-compose up"))
    assert body.index("poller_identity") < up
    text = AFTER_INSTALL_PATH.read_text()
    assert text.index("poller_identity() {") < text.index('"$SERVICE_FROM_FILE" == "server"')


@requires_after_install
def test_the_large_box_still_writes_the_readiness_identity():
    # The queue child's version-skew guard reads MATH_POLLER_SOURCE_COMMIT.
    body = _role_bodies()["delphi-large"]
    assert "poller_identity" in body
    assert not any(line.startswith("sudo /usr/local/bin/docker-compose") for line in body)


def _find_stop_hook():
    if AFTER_INSTALL_PATH is None:
        return None
    path = AFTER_INSTALL_PATH.parent / APPLICATION_STOP.name
    return path if path.is_file() else None


STOP_HOOK = _find_stop_hook()
requires_stop_hook = pytest.mark.skipif(STOP_HOOK is None, reason=f"{APPLICATION_STOP} not found")


def _stop_lines() -> dict:
    roles, current = {}, None
    for line in STOP_HOOK.read_text().splitlines():
        match = _STOP_BRANCH.match(line)
        if match:
            current = match["role"]
            roles[current] = []
            continue
        if line.startswith(("  else", "  fi", "else", "fi")):
            current = None
            continue
        code = line.split("#", 1)[0].split()
        if current and code[:1] and code[0].endswith("docker-compose") and "stop" in code:
            roles[current].append(code)
    return roles


@requires_stop_hook
def test_the_stop_hook_stops_nothing_on_the_large_box_and_no_large_poller_anywhere():
    roles = _stop_lines()
    assert roles.get("delphi-large", []) == []
    assert not any("math-python-large" in l for lines in roles.values() for l in lines)
    assert "delphi-large" in STOP_HOOK.read_text()
