"""Startup guard: the shadow poller must not write under the served math_env.

``scripts/math_poller.py`` refuses to start (exit 2, before any database work)
when MATH_ENV is empty/whitespace, or is ``prod`` without
MATH_POLLER_ALLOW_SERVED_ENV=1.
"""

import pytest

from scripts import math_poller


@pytest.fixture
def built(monkeypatch):
    """Record whether main() got past the guard to _build_service."""
    calls = []

    def fake_build(config):
        calls.append(config.math_env)
        raise SystemExit(0)

    monkeypatch.setattr(math_poller, "_build_service", fake_build)
    monkeypatch.delenv("MATH_POLLER_ALLOW_SERVED_ENV", raising=False)
    return calls


def _run(monkeypatch, math_env):
    monkeypatch.setenv("MATH_ENV", math_env)
    with pytest.raises(SystemExit) as exc:
        math_poller.main(["--once"])
    return exc.value.code


@pytest.mark.parametrize("math_env", ["prod", " prod "])
def test_refuses_the_served_env(monkeypatch, capsys, built, math_env):
    assert _run(monkeypatch, math_env) == 2
    assert built == []
    err = capsys.readouterr().err
    assert "refusing to start: MATH_ENV=prod is the served namespace" in err
    assert "MATH_POLLER_ALLOW_SERVED_ENV=1" in err


@pytest.mark.parametrize("math_env", ["", "   "])
def test_refuses_an_empty_env(monkeypatch, capsys, built, math_env):
    assert _run(monkeypatch, math_env) == 2
    assert built == []
    assert "refusing to start: MATH_ENV is empty" in capsys.readouterr().err


@pytest.mark.parametrize("math_env", ["", "   "])
def test_override_does_not_admit_an_empty_env(monkeypatch, built, math_env):
    monkeypatch.setenv("MATH_POLLER_ALLOW_SERVED_ENV", "1")
    assert _run(monkeypatch, math_env) == 2
    assert built == []


@pytest.mark.parametrize("math_env", ["python", "python-shadow"])
def test_allows_a_distinct_env(monkeypatch, built, math_env):
    assert _run(monkeypatch, math_env) == 0
    assert built == [math_env]


def test_allows_the_default_when_math_env_is_unset(monkeypatch, built):
    monkeypatch.delenv("MATH_ENV", raising=False)
    with pytest.raises(SystemExit) as exc:
        math_poller.main(["--once"])
    assert exc.value.code == 0
    assert built == ["dev"]


def test_allows_prod_only_with_the_override(monkeypatch, built):
    monkeypatch.setenv("MATH_POLLER_ALLOW_SERVED_ENV", "1")
    assert _run(monkeypatch, "prod") == 0
    assert built == ["prod"]


@pytest.mark.parametrize("override", ["", "0", "true", "yes"])
def test_only_the_exact_override_value_admits_prod(monkeypatch, built, override):
    monkeypatch.setenv("MATH_POLLER_ALLOW_SERVED_ENV", override)
    assert _run(monkeypatch, "prod") == 2
    assert built == []


def test_compose_forwards_the_override_with_an_empty_default():
    from pathlib import Path

    compose = (Path(__file__).resolve().parents[3] / "docker-compose.yml").read_text()
    service = compose.split("  math-python:", 1)[1].split("\n  postgres:", 1)[0]
    assert (
        "- MATH_POLLER_ALLOW_SERVED_ENV=${MATH_POLLER_ALLOW_SERVED_ENV:-}"
        in service
    )
