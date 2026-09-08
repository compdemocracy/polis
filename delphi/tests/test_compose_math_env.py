"""Every compose stack must hand delphi the math_env its math service writes.

The report pipeline reads ``math_main`` / ``math_ptptstats`` scoped by
``math_env`` (see ``tests/test_report_math_env.py``). The delphi service has no
``env_file:``, so ``--env-file`` only feeds ``${...}`` interpolation and never
the container environment: unless the service block lists ``MATH_ENV``, the
report container falls back to the library default in
``polismath/components/config.py`` regardless of what the stack is configured
for. If that resolves to a different env than the one the ``math`` service
writes under, ``GroupDataProcessor.get_math_main_by_conversation`` finds no row
and silently synthesises groups from raw votes.

These assertions are static (the compose files are parsed, not run) so they hold
in a CI without a docker daemon; ``docker compose config`` renders the same
values.
"""

from pathlib import Path

import pytest
import yaml

from polismath.components.config import ConfigManager


REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILES = {
    "docker-compose.yml": "prod",
    "docker-compose.test.yml": "dev",
}


def _environment(compose_file: str, service: str) -> dict:
    document = yaml.safe_load((REPO_ROOT / compose_file).read_text())
    assert service in document["services"], f"{compose_file} defines no {service} service"
    entries = document["services"][service].get("environment") or []
    if isinstance(entries, dict):
        return {key: value for key, value in entries.items()}
    parsed = {}
    for entry in entries:
        key, _, value = entry.partition("=")
        parsed[key] = value
    return parsed


@pytest.mark.parametrize("compose_file,default", sorted(COMPOSE_FILES.items()))
def test_delphi_receives_math_env(compose_file, default):
    delphi = _environment(compose_file, "delphi")
    assert "MATH_ENV" in delphi, (
        f"{compose_file}: the delphi service does not set MATH_ENV, so the report "
        "pipeline would read math rows under the library default instead of this "
        "stack's math_env"
    )
    assert delphi["MATH_ENV"] == "${MATH_ENV:-%s}" % default


@pytest.mark.parametrize("compose_file,default", sorted(COMPOSE_FILES.items()))
def test_delphi_and_math_agree_on_math_env(compose_file, default):
    delphi = _environment(compose_file, "delphi")
    math = _environment(compose_file, "math")
    assert math["MATH_ENV"] == "${MATH_ENV:-%s}" % default
    assert delphi["MATH_ENV"] == math["MATH_ENV"], (
        f"{compose_file}: delphi reads a different math_env than math writes"
    )


def test_delphi_does_not_follow_the_shadow_poller_env():
    # docker-compose.yml deliberately gives math-python a DISTINCT env so its
    # shadow rows stay invisible; reports must follow the server's MATH_ENV.
    delphi = _environment("docker-compose.yml", "delphi")
    math_python = _environment("docker-compose.yml", "math-python")
    assert math_python["MATH_ENV"] == "${MATH_PYTHON_ENV:-python}"
    assert "MATH_PYTHON_ENV" not in delphi["MATH_ENV"]


def test_library_default_matches_the_deployed_stack(monkeypatch):
    # With MATH_ENV unset, docker-compose.yml resolves to `prod`; the library
    # default must agree so an unwired container still reads the right rows.
    monkeypatch.delenv("MATH_ENV", raising=False)
    monkeypatch.setattr(ConfigManager, "_instance", None)
    assert ConfigManager.get_config().get("math-env") == COMPOSE_FILES["docker-compose.yml"]
