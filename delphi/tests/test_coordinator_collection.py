"""Copied Delphi CI collection must not treat the projection scan root as a crate."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


@pytest.fixture
def copied_tree(tmp_path):
    root = tmp_path / "copied"
    coordinator = root / "coordinator"
    coordinator.mkdir(parents=True)
    shutil.copyfile(Path(__file__).parent / "coordinator/conftest.py", coordinator / "conftest.py")
    (coordinator / "test_needs_crate.py").write_text("def test_needs_crate():\n    assert False, 'crate unavailable'\n")
    (root / "test_unrelated.py").write_text("def test_unrelated():\n    assert True\n")
    env = dict(os.environ, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", PYTHONDONTWRITEBYTECODE="1")
    for key in ("POLIS_CHECKOUT_DIR", "POLIS_COORDINATOR_CHECKOUT_DIR"):
        env.pop(key, None)
    return root, env


def collect(root, env):
    return subprocess.run([sys.executable, "-m", "pytest", "-c", "/dev/null", "-p", "no:cacheprovider", "-q", str(root)],
                          cwd=root, env=env, text=True, capture_output=True, timeout=30)


@pytest.mark.parametrize("projection_override", [False, True])
def test_copied_tree_leaves_unrelated_tests_collectable(copied_tree, tmp_path, projection_override):
    root, env = copied_tree
    if projection_override:
        scan = tmp_path / "projgate"
        (scan / "delphi/scripts").mkdir(parents=True)
        (scan / "delphi/scripts/projection_inventory.py").write_text("# synthetic scan marker\n")
        env["POLIS_CHECKOUT_DIR"] = str(scan)
    result = collect(root, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 passed" in result.stdout
    assert "coordinator tests not collected" in result.stdout


def test_bad_explicit_coordinator_override_still_fails(copied_tree, tmp_path):
    root, env = copied_tree
    env["POLIS_COORDINATOR_CHECKOUT_DIR"] = str(tmp_path / "wrong-root")
    result = collect(root, env)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "POLIS_COORDINATOR_CHECKOUT_DIR" in result.stdout + result.stderr
    assert "does not contain coordinator-rs/Cargo.toml" in result.stdout + result.stderr


def test_explicit_coordinator_root_is_independent_of_projection_root(copied_tree, tmp_path):
    root, env = copied_tree
    checkout = tmp_path / "checkout"
    (checkout / "coordinator-rs").mkdir(parents=True)
    (checkout / "coordinator-rs/Cargo.toml").write_text("# synthetic marker\n")
    env.update(POLIS_COORDINATOR_CHECKOUT_DIR=str(checkout), POLIS_CHECKOUT_DIR=str(tmp_path / "other"))
    # Import only: the fixture root resolves, while the absent .git correctly
    # keeps process tests unavailable in this generated source-only tree.
    code = "import runpy; d=runpy.run_path('coordinator/conftest.py'); assert d['_FATAL'] is None; print(d['ROOT'])"
    result = subprocess.run([sys.executable, "-c", code], cwd=root, env=env,
                            text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == str(checkout)
