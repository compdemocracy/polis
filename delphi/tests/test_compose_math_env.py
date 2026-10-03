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


# --- The large memory class (P-073): math-python-large and the forwarding ----
# Compose forwards only what a service lists, so a MATH_CAPACITY_* setting the
# code reads but the service does not list is invisible in production. Every
# key is checked against the names the code itself declares.

LARGE = "math-python-large"
LARGE_LABEL = "python-large"
# Read only by the large worker (its promotion target); the small poller
# promotes into its own label.
LARGE_ONLY_CAPACITY_KEYS = {"MATH_CAPACITY_PROMOTE_INTO"}
# Read only with routing on, which only the small poller does; the large
# worker's routing is pinned off, so it does not list them.
ROUTING_ONLY_CAPACITY_KEYS = {"MATH_CAPACITY_ROUTE_FRACTION", "MATH_CAPACITY_KEEP_FRACTION",
                              "MATH_CAPACITY_RESIZE_S"}
# What the large worker must never take from a shared env document: pinned in
# its service block, whatever the document says.
LARGE_PINNED = {
    "MATH_CAPACITY_CLASS": "large",
    "MATH_CAPACITY_ROUTING": "0",
    "MATH_CAPACITY_PROMOTE": "0",
    "MATH_CAPACITY_RESTAGE": "",
    "MATH_CAPACITY_STATE_PATH": "",
    "MATH_BACKFILL": "0",
    "MATH_POLLER_ALLOW_SERVED_ENV": "",
    "POLL_SHARD_INDEX": "0",
    "POLL_SHARD_COUNT": "1",
}
# Read from their own variables on the large worker (its own label, pool and
# cache), so the small poller's values never size the large class.
LARGE_OWN = {
    "MATH_ENV": "${MATH_PYTHON_LARGE_ENV:-python-large}",
    "MATH_CAPACITY_STAGED_LABEL": "${MATH_PYTHON_LARGE_ENV:-python-large}",
    "MATH_CAPACITY_PROMOTE_INTO": "${MATH_PYTHON_ENV:-python}",
    "MATH_WORKER_POOL_SIZE": "${MATH_LARGE_WORKER_POOL_SIZE:-2}",
    "MATH_CONV_CACHE_CAP": "${MATH_LARGE_CONV_CACHE_CAP:-10}",
    "MATH_CONV_CACHE_MB": "${MATH_LARGE_CONV_CACHE_MB:-}",
}
# A shared env document as production could hold it for the small poller:
# none of it may reach, or stop, the large worker.
SHARED_DOCUMENT = {
    "MATH_ENV": "python",
    "MATH_PYTHON_ENV": "python",
    "MATH_CAPACITY_CLASS": "small",
    "MATH_CAPACITY_ROUTING": "1",
    "MATH_CAPACITY_PROMOTE": "1",
    "MATH_CAPACITY_RESTAGE": "0123456789abcdef",
    "MATH_CAPACITY_STATE_PATH": "/app/backfill-state/capacity.json",
    "MATH_CAPACITY_MANIFEST_URI": "s3://generated-bucket/math-capacity/python/manifest.json",
    "MATH_BACKFILL": "1",
    "MATH_POLLER_ALLOW_SERVED_ENV": "1",
    "POLL_SHARD_INDEX": "1",
    "POLL_SHARD_COUNT": "2",
    "MATH_WORKER_POOL_SIZE": "4",
    "MATH_CONV_CACHE_CAP": "200",
}
AWS_CLIENT_KEYS = ("AWS_REGION", "AWS_S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")


def _capacity_keys_read() -> set:
    """Every MATH_CAPACITY_* name polismath.poller.capacity declares."""
    from polismath.poller import capacity

    keys = {value for name, value in vars(capacity).items()
            if name.endswith("_ENV") and isinstance(value, str) and value.startswith("MATH_CAPACITY_")}
    assert {"MATH_CAPACITY_ROUTING", "MATH_CAPACITY_MANIFEST_URI"} <= keys, "found no settings"
    return keys


def _raw_environment(service: str) -> dict:
    block = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"][service]
    return {e.partition("=")[0]: e.partition("=")[2] for e in block["environment"]}


def _service(service: str) -> dict:
    return yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"][service]


@requires_checkout
def test_math_python_forwards_every_capacity_setting():
    env = _environment("docker-compose.yml", "math-python")
    missing = _capacity_keys_read() - LARGE_ONLY_CAPACITY_KEYS - set(env)
    assert not missing, f"math-python does not forward {sorted(missing)}"


@requires_checkout
def test_the_large_worker_receives_every_capacity_setting():
    env = _environment("docker-compose.yml", LARGE)
    missing = _capacity_keys_read() - ROUTING_ONLY_CAPACITY_KEYS - set(env)
    assert not missing, f"{LARGE} does not forward {sorted(missing)}"


@requires_checkout
@pytest.mark.parametrize("key", sorted(
    {"MATH_CAPACITY_ROUTING", "MATH_CAPACITY_ROUTE_FRACTION", "MATH_CAPACITY_KEEP_FRACTION",
     "MATH_CAPACITY_RESIZE_S", "MATH_CAPACITY_STATE_PATH", "MATH_CAPACITY_LARGE_BUDGET_MB",
     "MATH_CAPACITY_MANIFEST_URI", "MATH_CAPACITY_PROMOTE", "MATH_CAPACITY_RESTAGE"}))
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
    assert settings.manifest_uri is None and settings.state_path is None
    assert settings.staged_label == LARGE_LABEL


@requires_checkout
def test_math_python_is_always_the_small_class():
    # A shared env document that names the large class must not turn the
    # small poller (the `python` writer) into the large worker.
    env = _environment("docker-compose.yml", "math-python", {"MATH_CAPACITY_CLASS": "large"})
    assert env["MATH_CAPACITY_CLASS"] == "small"


@requires_checkout
def test_the_large_worker_refuses_to_start_until_a_manifest_is_set():
    from polismath.poller.capacity import CapacitySettings
    from polismath.poller.large_class import LargeStartupError, check_large_startup

    env = _environment("docker-compose.yml", LARGE, {})
    settings = CapacitySettings.from_env(env)
    assert settings.large and settings.manifest_uri is None
    with pytest.raises(LargeStartupError, match="MANIFEST_URI"):
        check_large_startup(settings, env["MATH_ENV"], served_env="prod", env=env,
                            shard_count=int(env["POLL_SHARD_COUNT"]))


@requires_checkout
@pytest.mark.parametrize("document", [
    {"MATH_CAPACITY_MANIFEST_URI": "s3://generated-bucket/m.json"},
    SHARED_DOCUMENT,
], ids=["manifest-only", "shared-small-document"])
def test_the_large_worker_starts_under_a_shared_env_document(document):
    # The production env document is shared by every box; with the small
    # poller's settings in it (routing, promotion, a nonce, backfill, shards,
    # the served-label override) the large worker must still pass its own
    # startup refusals rather than exit 2.
    from polismath.poller.capacity import CapacitySettings
    from polismath.poller.large_class import check_large_startup

    env = _environment("docker-compose.yml", LARGE, document)
    settings = CapacitySettings.from_env(env)
    check_large_startup(settings, env["MATH_ENV"], served_env="prod", env=env,
                        shard_count=int(env["POLL_SHARD_COUNT"]))
    assert settings.large and not settings.routing and not settings.promote
    assert settings.restage is None and settings.state_path is None
    assert env["MATH_BACKFILL"] == "0"
    assert (env["MATH_WORKER_POOL_SIZE"], env["MATH_CONV_CACHE_CAP"]) == ("2", "10")


@requires_checkout
@pytest.mark.parametrize("env", [
    {}, {"MATH_ENV": "python"}, {"MATH_PYTHON_ENV": PROBE},
    {"MATH_PYTHON_LARGE_ENV": "probe-large"}, SHARED_DOCUMENT,
], ids=["unset", "served-python", "small-label", "large-label", "shared-document"])
def test_the_two_pollers_never_share_a_label_and_agree_on_the_hand_off(env):
    small = _environment("docker-compose.yml", "math-python", env)
    large = _environment("docker-compose.yml", LARGE, env)
    # Different labels, hence different single-writer locks.
    assert large["MATH_ENV"] != small["MATH_ENV"]
    assert large["MATH_ENV"] not in ("prod", "")
    # The small poller promotes from the label the large worker writes, and
    # the large worker's target is the small poller's label.
    assert small["MATH_CAPACITY_STAGED_LABEL"] == large["MATH_ENV"] == large["MATH_CAPACITY_STAGED_LABEL"]
    assert large["MATH_CAPACITY_PROMOTE_INTO"] == small["MATH_ENV"]
    # Both read one manifest.
    assert large["MATH_CAPACITY_MANIFEST_URI"] == small["MATH_CAPACITY_MANIFEST_URI"]


@requires_checkout
def test_the_large_worker_shares_every_other_setting_with_math_python():
    # Written out rather than `extends` (which would merge the profiles); this
    # pins the two lists against drift. The backfill and routing settings are
    # absent from the large worker (both are pinned off and refused).
    small, large = _raw_environment("math-python"), _raw_environment(LARGE)
    for key, value in LARGE_PINNED.items():
        assert large.get(key) == value, f"{LARGE} must pin {key}={value}"
    for key, value in LARGE_OWN.items():
        assert large.get(key) == value, f"{LARGE} must read {key} as {value}"
    shared = set(small) - set(LARGE_PINNED) - set(LARGE_OWN) - ROUTING_ONLY_CAPACITY_KEYS - {
        k for k in small if k.startswith("MATH_BACKFILL_")}
    assert set(large) == shared | set(LARGE_PINNED) | set(LARGE_OWN)
    differing = {k for k in shared if small[k] != large[k]}
    assert not differing, f"{LARGE} reads {sorted(differing)} differently from math-python"


@requires_checkout
@pytest.mark.parametrize("service", ["math-python", LARGE])
def test_the_manifest_client_settings_are_forwarded(service):
    env = _environment("docker-compose.yml", service, {})
    # Unset credentials stay empty, so the client falls through to the
    # instance role; the region has the Delphi default.
    assert {k: env.get(k) for k in AWS_CLIENT_KEYS} == {
        "AWS_REGION": "us-east-1", "AWS_S3_ENDPOINT": "", "AWS_ACCESS_KEY_ID": "",
        "AWS_SECRET_ACCESS_KEY": ""}
    probe = {k: f"probe-{k.lower()}" for k in AWS_CLIENT_KEYS}
    assert {k: v for k, v in _environment("docker-compose.yml", service, probe).items()
            if k in AWS_CLIENT_KEYS} == probe


@requires_checkout
def test_the_large_worker_is_profile_gated_on_its_own_profile():
    # `make start`, the dev overlay and `--profile math-python` never run it.
    assert _service(LARGE).get("profiles") == [LARGE]
    assert _service("math-python").get("profiles") == ["math-python"]
    assert "extends" not in _service(LARGE)


@requires_checkout
def test_the_large_worker_runs_the_poller_image_and_entrypoint():
    small, large = _service("math-python"), _service(LARGE)
    for key in ("image", "build", "command", "networks", "extra_hosts", "restart"):
        assert large[key] == small[key], key


@requires_checkout
def test_the_large_memory_limit_has_its_own_knob():
    raw = _service(LARGE)["deploy"]["resources"]["limits"]["memory"]
    assert raw == "${MATH_LARGE_CONTAINER_MEMORY:-52g}"
    assert _interpolate(raw, {}) == "52g"
    assert _interpolate(raw, {"MATH_LARGE_CONTAINER_MEMORY": "4g"}) == "4g"
    # The small poller's knob moves only the small poller.
    assert _interpolate(raw, {"DELPHI_POLLER_CONTAINER_MEMORY": "6g"}) == "52g"
    small = _math_python_memory()
    assert _interpolate(small, {"MATH_LARGE_CONTAINER_MEMORY": "4g"}) == "16g"


@requires_checkout
def test_the_large_worker_keeps_its_own_state_volume():
    document = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())
    assert _service(LARGE)["volumes"] == ["math-large-state:/app/backfill-state"]
    assert "math-large-state" in document["volumes"]
    assert "math-large-state" not in str(_service("math-python")["volumes"])


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
def test_the_large_box_starts_only_the_large_worker():
    roles = _role_up_lines()
    assert len(roles.get("delphi-large", [])) == 1
    (line,) = roles["delphi-large"]
    assert _services_named(line) == {LARGE}
    assert {"-d", "--build", "--force-recreate"} <= set(line)


@requires_after_install
def test_only_the_large_box_starts_the_large_worker():
    roles = _role_up_lines()
    starting = {role for role, lines in roles.items() if any(LARGE in _services_named(l) for l in lines)}
    assert starting == {"delphi-large"}
    # The Delphi box is unchanged.
    (delphi,) = roles["delphi"]
    assert _services_named(delphi) == {"delphi", "math-python"}


@requires_after_install
@pytest.mark.parametrize("role", ["delphi", "delphi-large"])
def test_both_poller_boxes_write_the_readiness_identity_before_starting(role):
    body = _role_bodies()[role]
    assert "poller_identity" in body
    up = next(i for i, line in enumerate(body) if line.startswith("sudo /usr/local/bin/docker-compose up"))
    assert body.index("poller_identity") < up
    text = AFTER_INSTALL_PATH.read_text()
    assert text.index("poller_identity() {") < text.index('"$SERVICE_FROM_FILE" == "server"')


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
def test_the_stop_hook_stops_the_large_worker_on_the_large_box_only():
    roles = _stop_lines()
    (line,) = roles["delphi-large"]
    assert line[line.index("stop") + 1] == LARGE
    others = {role for role, lines in roles.items() if role != "delphi-large"
              and any(LARGE in l for l in lines)}
    assert not others
