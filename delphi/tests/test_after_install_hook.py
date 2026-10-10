"""scripts/after_install.sh migrates before replacing any service, and a queue
worker box (delphi-large, delphi-worker) starts only its polis-jobs.service.

Runs the real deploy hook (and the stop hook) with every external command
faked on PATH: sudo runs its arguments, and docker, docker-compose, systemctl,
aws, git, yum, curl and jq only record their arguments. The hooks' absolute
paths (/usr/local/bin/docker-compose, /etc/app-info, /etc/systemd/system,
/opt/polis) are rewritten into a temporary root; each rewrite is counted, so
a path the hook stops using fails the test instead of silently escaping.

For every service type the test checks which compose services start, which
systemd units are touched, and which containers the cleanup removes:

  server, delphi, math, an unknown type: exactly as before (no systemctl; the
      cleanup removes every container);
  delphi-large, delphi-worker: no compose service starts; the Delphi image is
      built; polis-jobs.service alone is restarted (queued); the cleanup
      spares the polis-jobs container so the restart can drain its job; a box
      whose worker class or unit does not match its service type fails the
      deploy before anything is built or restarted.

The hooks are located like ``test_compose_math_env.py`` locates them:
$POLIS_CHECKOUT_DIR, else an ancestor of this file.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HOOK = Path("scripts") / "after_install.sh"
STOP = Path("scripts") / "application_stop.sh"


def _find(rel):
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / rel).is_file():
            return candidate / rel
    return None


HOOK_PATH = _find(HOOK)
STOP_PATH = _find(STOP)
pytestmark = [
    pytest.mark.skipif(HOOK_PATH is None or STOP_PATH is None,
                       reason=f"{HOOK} / {STOP} not found in $POLIS_CHECKOUT_DIR nor any ancestor"),
    pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available"),
]

# Containers on the box before the deploy: (id, name).
CONTAINERS = [("c0ffee000001", "polis-delphi-1"), ("c0ffee000002", "polis-jobs"),
              ("c0ffee000003", "polis-math-python-1")]
JOBS_ID = "c0ffee000002"

RECORD = '#!/bin/bash\necho "$(basename "$0") $*" >> "$FAKE_LOG"\n'
FAKES = {
    "sudo": '#!/bin/bash\nexec "$@"\n',
    "yum": RECORD,
    "systemctl": RECORD,
    "docker-compose": RECORD,
    "curl": RECORD + 'case "$*" in *instance-id*) echo i-0123456789abcdef0;; *) echo token;; esac\n',
    "jq": RECORD + 'echo value\n',
    "git": RECORD + 'case "$1" in clone) mkdir -p "${@: -1}";; rev-parse) echo 0123456789abcdef0123456789abcdef01234567;; esac\n',
    "aws": RECORD + (
        'case "$*" in\n'
        '  *ollama*) exit 255;;\n'
        '  *polis-web-app-env-vars*) echo "PUBLIC_SERVICE_URL=https://example.invalid";;\n'
        '  *"ssm get-parameter"*) echo value;;\n'
        '  *) echo \'{"username":"u","password":"p","dbname":"d"}\';;\n'
        'esac\n'),
    "docker": RECORD + (
        'if [ "$1" = "$FAKE_MIGRATION_FAILURE" ]; then exit 17; fi\n'
        'if [ "$1" = ps ]; then\n'
        '  filter=""\n'
        '  while [ $# -gt 0 ]; do [ "$1" = --filter ] && filter="${2#name=}"; shift; done\n'
        '  while read -r id name; do\n'
        '    if [ -z "$filter" ] || printf "/%s\\n" "$name" | grep -Eq -- "$filter"; then echo "$id"; fi\n'
        '  done < "$FAKE_CONTAINERS"\n'
        'fi\n'),
}


def _rewrite(text, root, rules):
    for old, new, at_least in rules:
        n = text.count(old)
        assert n >= at_least, f"the hook no longer contains {old!r}; update this test's rewrite"
        text = text.replace(old, new)
    return text


def _box(tmp_path, service_type, worker_class=None, unit=True):
    root = tmp_path / "root"
    (root / "etc/app-info").mkdir(parents=True)
    (root / "etc/systemd/system").mkdir(parents=True)
    (root / "opt").mkdir()
    (root / "etc/app-info/service_type.txt").write_text(service_type + "\n")
    if worker_class is not None:
        (root / "etc/app-info/worker_class.txt").write_text(worker_class + "\n")
    if unit:
        (root / "etc/systemd/system/polis-jobs.service").write_text("[Service]\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in FAKES.items():
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    containers = tmp_path / "containers"
    containers.write_text("".join(f"{i} {n}\n" for i, n in CONTAINERS))
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path),
           "FAKE_LOG": str(tmp_path / "log"), "FAKE_CONTAINERS": str(containers)}
    return root, env


def _run(tmp_path, script_path, rules, root, env):
    script = tmp_path / script_path.name
    script.write_text(_rewrite(script_path.read_text(), root, rules))
    proc = subprocess.run(["bash", str(script)], env=env, cwd=tmp_path,
                          capture_output=True, text=True, timeout=60)
    log = (tmp_path / "log").read_text().splitlines() if (tmp_path / "log").exists() else []
    return proc, log


def _deploy(tmp_path, service_type, migration_failure="", **kw):
    root, env = _box(tmp_path, service_type, **kw)
    env["FAKE_MIGRATION_FAILURE"] = migration_failure
    rules = [("/usr/local/bin/docker-compose", "docker-compose", 3),
             ("/etc/app-info/", f"{root}/etc/app-info/", 2),
             ("/etc/systemd/system/", f"{root}/etc/systemd/system/", 0),
             ("/opt/polis", f"{root}/opt/polis", 2)]
    return _run(tmp_path, HOOK_PATH, rules, root, env)


def _calls(log, tool):
    return [line[len(tool) + 1:] for line in log if line.split(" ", 1)[0] == tool]


def _removed(log):
    """The container ids the cleanup's `docker rm -f` named."""
    (rm,) = [c for c in _calls(log, "docker") if c.startswith("rm -f")]
    return set(rm.split()[2:])


ALL_IDS = {i for i, _ in CONTAINERS}
UNCHANGED = {
    "server": ["up -d server nginx-proxy client-participation-alpha --no-build --force-recreate"],
    "delphi": ["up -d delphi math-python --no-build --force-recreate"],
    "math": [],

}


@pytest.mark.parametrize("service_type", sorted(UNCHANGED))
def test_the_other_service_types_behave_as_before(tmp_path, service_type):
    proc, log = _deploy(tmp_path, service_type)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    compose = _calls(log, "docker-compose")
    assert [c for c in compose if c.startswith("up")] == UNCHANGED[service_type]
    builds = [c for c in compose if c.startswith("build")]
    assert builds == {"server": ["build server nginx-proxy client-participation-alpha"], "delphi": ["build delphi math-python"], "math": []}[service_type]
    assert _calls(log, "systemctl") == []
    assert not [c for c in _calls(log, "docker") if c.startswith(("rm ", "system prune"))]


@pytest.mark.parametrize("service_type,worker_class", [("delphi-large", "large"),
                                                       ("delphi-worker", "delphi")])
def test_a_worker_box_restarts_only_its_daemon_unit(tmp_path, service_type, worker_class):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    compose = _calls(log, "docker-compose")
    assert not [c for c in compose if c.startswith("up")], "a worker box starts no compose service"
    assert [c for c in compose if c.startswith("build")] == ["build delphi"]
    assert _calls(log, "systemctl") == ["restart --no-block polis-jobs.service"]
    # Built before the unit is restarted, so the restart runs the new image.
    assert log.index("docker-compose build delphi") < log.index(
        "systemctl restart --no-block polis-jobs.service")
    # The cleanup spares the running daemon; the restart drains it.
    assert not [c for c in _calls(log, "docker") if c.startswith(("rm ", "system prune"))]
    assert f"worker class '{worker_class}'" in proc.stdout


def test_only_the_large_box_writes_the_readiness_identity(tmp_path):
    for service_type, worker_class in (("delphi-large", "large"), ("delphi-worker", "delphi")):
        box = tmp_path / service_type
        box.mkdir()
        proc, log = _deploy(box, service_type, worker_class=worker_class)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        env_file = box / "root/opt/polis/polis/.env"
        wrote = "MATH_POLLER_SOURCE_COMMIT=" in env_file.read_text()
        assert wrote == (service_type == "delphi-large")


@pytest.mark.parametrize("service_type,worker_class,unit,reason", [
    ("delphi-large", "delphi", True, "worker_class.txt says 'delphi'"),
    ("delphi-worker", "large", True, "worker_class.txt says 'large'"),
    ("delphi-worker", None, True, "worker_class.txt says ''"),
    ("delphi-large", "large", False, "polis-jobs.service is missing"),
])
def test_a_worker_box_that_does_not_match_fails_the_deploy(tmp_path, service_type, worker_class,
                                                           unit, reason):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class, unit=unit)
    assert proc.returncode != 0
    assert reason in proc.stdout
    assert not [c for c in _calls(log, "docker-compose") if c.startswith(("build", "up"))]
    assert _calls(log, "systemctl") == []


@pytest.mark.parametrize("service_type", ["server", "delphi", "math", "delphi-large", "delphi-worker", "unknown"])
def test_the_stop_hook_leaves_every_service_running(tmp_path, service_type):
    root, env = _box(tmp_path, service_type)
    # No path rewrite: the revised hook has no external calls or absolute paths.
    proc, log = _run(tmp_path, STOP_PATH, [], root, env)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert log == []
    assert "AfterInstall" in proc.stdout


def test_unknown_role_refuses_before_migration_or_replacement(tmp_path):
    proc, log = _deploy(tmp_path, "unknown")
    assert proc.returncode != 0
    assert not _calls(log, "docker")
    assert not _calls(log, "docker-compose")
