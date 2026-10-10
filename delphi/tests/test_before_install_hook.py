"""BeforeInstall leaves every healthy service running until AfterInstall migrates.

Run the exact hook with forbidden external commands on PATH. A reintroduced
stop, removal, daemon restart or migration here must fail these controls.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest


BEFORE_INSTALL = Path("scripts") / "before_install.sh"


def _find_before_install():
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / BEFORE_INSTALL).is_file():
            return candidate / BEFORE_INSTALL
    return None


BEFORE_INSTALL_PATH = _find_before_install()
pytestmark = [
    pytest.mark.skipif(
        BEFORE_INSTALL_PATH is None,
        reason=f"{BEFORE_INSTALL} not found in $POLIS_CHECKOUT_DIR nor any ancestor of this file",
    ),
    pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available"),
]

@pytest.mark.parametrize("running", [
    "polis-math-python-1", "polis-delphi-1 polis-math-python-1",
    "polis-math-python-large-1 polis-jobs", "polis-math-1",
    "polis-server-1 polis-server-helper-1", "",
])
def test_before_install_never_touches_running_services(tmp_path, running):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls"
    for name in ("docker", "docker-compose", "systemctl", "sudo", "polis-migrate"):
        stub = bin_dir / name
        stub.write_text('#!/bin/sh\necho "$0 $*" >> "$FAKE_LOG"\nexit 91\n')
        stub.chmod(0o755)
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE_LOG": str(log),
           "FAKE_DOCKER_RUNNING": running}
    result = subprocess.run(["bash", str(BEFORE_INSTALL_PATH)], env=env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not log.exists(), "BeforeInstall must not invoke service or migration commands"
    assert "AfterInstall" in result.stdout
