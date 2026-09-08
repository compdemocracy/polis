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
    # docker-compose.yml deliberately gives math-python a DISTINCT env so its
    # shadow rows stay invisible; reports must follow the server's MATH_ENV.
    env = {"MATH_ENV": PROBE}
    assert _environment("docker-compose.yml", "delphi", env)["MATH_ENV"] == PROBE
    assert _environment("docker-compose.yml", "math-python", env)["MATH_ENV"] == "python"


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
