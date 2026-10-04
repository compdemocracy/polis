"""scripts/before_install.sh stops only the exact containers it names.

Docker's ``name`` filter is an unanchored regex, so ``--filter name=polis-math``
also matched the Delphi box's ``polis-math-python-1``; the hook then ran
``docker stop polis-math-1``, which exists only on the math box, and the
production BeforeInstall failed with ``No such container: polis-math-1``.

Runs the real hook against a fake ``docker`` on PATH that applies the filter
the way the daemon does (regex search against the name, with and without its
leading ``/``) and fails ``stop`` for a container that is not running. The hook
is located like ``test_compose_math_env.py`` locates after_install.sh:
$POLIS_CHECKOUT_DIR, else an ancestor of this file (CI copies it into the
checkout-shaped root).
"""

import os
import re
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

FAKE_DOCKER = r"""#!/bin/bash
# Fake docker: running containers come from $FAKE_DOCKER_RUNNING.
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps)
    filter=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--filter" ]; then filter="$2"; shift; fi
      shift
    done
    regex="${filter#name=}"
    for n in $FAKE_DOCKER_RUNNING; do
      if printf '%s\n' "$n" | grep -Eq -- "$regex" || printf '%s\n' "/$n" | grep -Eq -- "$regex"; then
        echo "id-$n"
      fi
    done
    ;;
  stop)
    for n in $FAKE_DOCKER_RUNNING; do
      if [ "$n" = "$2" ]; then echo "$2"; exit 0; fi
    done
    echo "Error response from daemon: No such container: $2" >&2
    exit 1
    ;;
  *)
    echo "fake docker: unexpected command: $*" >&2
    exit 2
    ;;
esac
"""


@pytest.fixture
def fake_docker(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    log.write_text("")

    def run(*running, script=None):
        env = dict(os.environ)
        env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
        env["FAKE_DOCKER_RUNNING"] = " ".join(running)
        env["FAKE_DOCKER_LOG"] = str(log)
        log.write_text("")
        if script is None:
            args = ["bash", str(BEFORE_INSTALL_PATH)]
        else:
            args = ["bash", "-c", script]
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=30)
        stops = [line.split()[1] for line in log.read_text().splitlines() if line.startswith("stop ")]
        return result, stops

    return run


def test_fake_docker_filters_by_substring_like_the_daemon(fake_docker):
    # Guards the fake: an unanchored filter must reproduce the production failure.
    result, _ = fake_docker(
        "polis-math-python-1",
        script="docker ps -q --filter name=polis-math",
    )
    assert result.stdout.strip() == "id-polis-math-python-1"


def test_delphi_box_with_math_python_stops_nothing_math(fake_docker):
    result, stops = fake_docker("polis-math-python-1")
    assert result.returncode == 0, result.stderr
    assert stops == []


def test_delphi_box_stops_delphi_but_not_math_python(fake_docker):
    result, stops = fake_docker("polis-delphi-1", "polis-math-python-1")
    assert result.returncode == 0, result.stderr
    assert stops == ["polis-delphi-1"]


def test_large_box_stops_nothing(fake_docker):
    # The large memory class box (service type delphi-large) runs only
    # polis-math-python-large-1, which no anchored filter names; AfterInstall
    # removes it before starting the new revision.
    result, stops = fake_docker("polis-math-python-large-1")
    assert result.returncode == 0, result.stderr
    assert stops == []


def test_math_box_stops_math(fake_docker):
    result, stops = fake_docker("polis-math-1")
    assert result.returncode == 0, result.stderr
    assert stops == ["polis-math-1"]


def test_server_box_stops_server(fake_docker):
    result, stops = fake_docker("polis-server-1", "polis-server-helper-1")
    assert result.returncode == 0, result.stderr
    assert stops == ["polis-server-1"]


def test_no_containers_is_a_clean_exit(fake_docker):
    result, stops = fake_docker()
    assert result.returncode == 0, result.stderr
    assert stops == []


def test_every_name_filter_is_anchored_to_the_container_it_stops():
    text = BEFORE_INSTALL_PATH.read_text()
    filters = re.findall(r'--filter "name=([^"]*)"', text)
    stopped = re.findall(r"docker stop (\S+)", text)
    assert filters, "before_install.sh no longer filters by name"
    assert "--filter name=" not in text and "--filter 'name=" not in text
    assert [f"^/?{name}$" for name in stopped] == filters
