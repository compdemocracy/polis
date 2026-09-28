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
    # The guard runs before single-writer admission (which needs Postgres);
    # admission itself is covered in test_single_writer_lock.py.
    monkeypatch.setattr(math_poller, "_hold_single_writer_lock", lambda config, log: None)
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

