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
  delphi-large, delphi-worker: no compose service starts; the pulled Delphi
      image is tagged as the unit's image; polis-jobs.service alone is
      restarted (queued); the cleanup spares the polis-jobs container so the
      restart can drain its job; a box whose worker class or unit does not
      match its service type fails the deploy before anything is restarted.

Nothing is built on any box: every image is pulled by the digest the bundle's
manifest (scripts/deploy-images.txt) names, before the migration runs, and a
bundle without a well-formed manifest for its commit deploys nothing.

The hooks are located like ``test_compose_math_env.py`` locates them:
$POLIS_CHECKOUT_DIR, else an ancestor of this file.
"""

import hashlib
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
    "git": RECORD + ('case "$1" in clone) mkdir -p "${@: -1}";; rev-parse) echo 0123456789abcdef0123456789abcdef01234567;;\n'
                     '  merge-base) [ -z "$FAKE_NOT_ON_BRANCH" ] || exit 1;; esac\n'),
    "aws": RECORD + (
        'case "$*" in\n'
        '  *ollama*) exit 255;;\n'
        '  *polis-web-app-env-vars*) echo "PUBLIC_SERVICE_URL=https://example.invalid";;\n'
        '  *"ssm get-parameter"*) echo value;;\n'
        '  *"sts get-caller-identity"*) echo 123456789012;;\n'
        '  *"ecr get-login-password"*) echo token;;\n'
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
    (root / "etc/app-info/polis-jobs.env").write_text(f"POLIS_JOBS_IMAGE={JOBS_IMAGE}\n")
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


REVISION = "89abcdef0123456789abcdef0123456789abcdef"
REGISTRY = "123456789012.dkr.ecr.us-east-1.amazonaws.com"
JOBS_IMAGE = f"{REGISTRY}/polis/delphi:latest"
REPOS = {"server": "polis/server", "nginx-proxy": "polis/nginx-proxy",
         "client-participation-alpha": "polis/client-participation-alpha",
         "delphi": "polis/delphi", "math-python": "polis/delphi", "migrate": "polis"}
# math-python runs the delphi image (deploy/build-images.sh).
IMAGES = {name: f"{REGISTRY}/{repo}@sha256:"
                + hashlib.sha256(("delphi" if name == "math-python" else name).encode()).hexdigest()
          for name, repo in REPOS.items()}
# The fake jq prints "value"; the hook hashes what jq prints.
WEB_ARGS_SHA256 = hashlib.sha256(b"value\n").hexdigest()
ROLE_IMAGES = {"server": ["server", "nginx-proxy", "client-participation-alpha"],
               "delphi": ["delphi", "math-python"], "math": [],
               "delphi-large": ["delphi"], "delphi-worker": ["delphi"]}
COMPOSE_FILES = "-f docker-compose.yml -f docker-compose.images.yml "


def _manifest(revision=REVISION, changes=None):
    """The image manifest the deploy workflow writes; a None value drops a line."""
    lines = {"revision": revision, **IMAGES, "web-build-args-sha256": WEB_ARGS_SHA256, **(changes or {})}
    return "".join(f"{k}={v}\n" for k, v in lines.items() if v is not None)


def _deploy(tmp_path, service_type, migration_failure="", revision=REVISION,
            not_on_branch=False, images="default", previous=None, **kw):
    root, env = _box(tmp_path, service_type, **kw)
    env["FAKE_MIGRATION_FAILURE"] = migration_failure
    env["FAKE_NOT_ON_BRANCH"] = "1" if not_on_branch else ""
    # The deploy workflow writes the bundle's commit and image manifest next to the hook.
    if revision is not None:
        (tmp_path / "deploy-revision.txt").write_text(revision + "\n")
    if images is not None:
        (tmp_path / "deploy-images.txt").write_text(_manifest() if images == "default" else images)
    if previous is not None:
        (root / "opt/polis").mkdir()
        (root / "opt/polis/deployed-images.txt").write_text(previous)
    rules = [("/usr/local/bin/docker-compose", "docker-compose", 2),
             ("/etc/app-info/", f"{root}/etc/app-info/", 2),
             ("/etc/systemd/system/", f"{root}/etc/systemd/system/", 0),
             ("/opt/polis", f"{root}/opt/polis", 2)]
    return _run(tmp_path, HOOK_PATH, rules, root, env)


def _calls(log, tool):
    return [line[len(tool) + 1:] for line in log if line.split(" ", 1)[0] == tool]


def _compose(log):
    """docker-compose calls, without the image override every replacement carries."""
    return [c[len(COMPOSE_FILES):] if c.startswith(COMPOSE_FILES) else c for c in _calls(log, "docker-compose")]


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
    compose = _compose(log)
    assert [c for c in compose if c.startswith("up")] == UNCHANGED[service_type]
    assert not [c for c in compose if c.startswith("build")]
    if UNCHANGED[service_type]:
        assert compose.index("down") < compose.index(UNCHANGED[service_type][0])
    assert _calls(log, "systemctl") == []
    assert not [c for c in _calls(log, "docker") if c.startswith(("rm ", "system prune"))]


@pytest.mark.parametrize("service_type,worker_class", [("delphi-large", "large"),
                                                       ("delphi-worker", "delphi")])
def test_a_worker_box_restarts_only_its_daemon_unit(tmp_path, service_type, worker_class):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    compose = _compose(log)
    assert not [c for c in compose if c.startswith("up")], "a worker box starts no compose service"
    assert not [c for c in compose if c.startswith("build")]
    assert _calls(log, "systemctl") == ["restart --no-block polis-jobs.service"]
    # Tagged as the unit's image before the restart, so the restart runs it.
    assert log.index(f"docker tag {IMAGES['delphi']} {JOBS_IMAGE}") < log.index(
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
    assert not [c for c in _compose(log) if c.startswith(("build", "up"))]
    assert _calls(log, "systemctl") == []


@pytest.mark.parametrize("service_type", ["server", "delphi", "math", "delphi-large", "delphi-worker", "unknown"])
def test_the_stop_hook_leaves_every_service_running(tmp_path, service_type):
    root, env = _box(tmp_path, service_type)
    # No path rewrite: the revised hook has no external calls or absolute paths.
    proc, log = _run(tmp_path, STOP_PATH, [], root, env)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert log == []
    assert "AfterInstall" in proc.stdout


@pytest.mark.parametrize("service_type,worker_class", [
    ("server", None), ("delphi", None), ("math", None),
    ("delphi-large", "large"), ("delphi-worker", "delphi"),
])
def test_migration_succeeds_before_any_service_replacement(tmp_path, service_type, worker_class):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    pull = f"docker pull {IMAGES['migrate']}"
    apply = "docker run --rm --network host --env-file .env polis-migrate:deploy deploy"
    assert log.count(pull) == log.count(apply) == 1
    assert log.index(pull) < log.index(apply)
    assert not [c for c in log if c.startswith("docker build")]
    for name in ROLE_IMAGES[service_type]:
        assert log.index(f"docker pull {IMAGES[name]}") < log.index(apply)
    # Compose calls carry the image override files; compare their subcommands.
    unprefixed = [call.replace(f"docker-compose {COMPOSE_FILES}", "docker-compose ", 1) for call in log]
    replacements = [i for i, call in enumerate(unprefixed) if call.startswith((
        "docker-compose down", "docker rm ", "docker system prune",
        "docker-compose up", "systemctl restart"))]
    assert replacements or service_type == "math"
    assert not replacements or log.index(apply) < min(replacements)


@pytest.mark.parametrize("failure", ["pull", "run"])
@pytest.mark.parametrize("service_type,worker_class", [
    ("server", None), ("delphi", None), ("math", None),
    ("delphi-large", "large"), ("delphi-worker", "delphi"),
])
def test_migration_failure_preserves_every_running_service(tmp_path, service_type, worker_class, failure):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class,
                        migration_failure=failure)
    assert proc.returncode == 17, proc.stdout + proc.stderr
    assert [c for c in _compose(log) if c != "config --format json"] == []
    assert _calls(log, "systemctl") == []
    docker = _calls(log, "docker")
    pulls = ["pull"] * (1 + len(ROLE_IMAGES[service_type]))
    assert [call.split()[0] for call in docker] == (["login", "pull"] if failure == "pull" else ["login", *pulls, "tag", "run"])


def test_the_checkout_is_the_bundle_commit_not_the_branch_head(tmp_path):
    proc, log = _deploy(tmp_path, "server")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    git = _calls(log, "git")
    assert f"reset --hard {REVISION}" in git
    assert not [c for c in git if c.startswith(("pull", "reset --hard origin/"))]
    assert git.index(f"merge-base --is-ancestor {REVISION} origin/stable") < git.index(f"reset --hard {REVISION}")
    # Checked out before the runner image for this commit is pulled.
    assert log.index(f"git reset --hard {REVISION}") < log.index(f"docker pull {IMAGES['migrate']}")


@pytest.mark.parametrize("revision,not_on_branch,reason", [
    (None, False, "names no source commit"),
    ("stable", False, "names no source commit"),
    ("0123", False, "names no source commit"),
    (REVISION, True, "is not on origin/stable"),
])
def test_a_bundle_without_an_on_branch_commit_deploys_nothing(tmp_path, revision, not_on_branch, reason):
    proc, log = _deploy(tmp_path, "server", revision=revision, not_on_branch=not_on_branch)
    assert proc.returncode != 0
    assert reason in proc.stdout
    assert not [c for c in _calls(log, "git") if c.startswith("reset")]
    assert _calls(log, "docker") == [] and _calls(log, "docker-compose") == []


@pytest.mark.parametrize("service_type,worker_class", [
    ("server", None), ("delphi", None), ("math", None),
    ("delphi-large", "large"), ("delphi-worker", "delphi"),
])
def test_every_image_is_pulled_by_digest_and_nothing_is_built(tmp_path, service_type, worker_class):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    pulls = [c.split()[1] for c in _calls(log, "docker") if c.startswith("pull")]
    assert pulls == [IMAGES["migrate"]] + [IMAGES[name] for name in ROLE_IMAGES[service_type]]
    assert not [c for c in _compose(log) if c.startswith("build")]
    # Every replacement runs the override, which names the pulled digests.
    assert all(c.startswith(COMPOSE_FILES) for c in _calls(log, "docker-compose") if c != "config --format json")
    override = (tmp_path / "root/opt/polis/polis/docker-compose.images.yml").read_text()
    for name in ROLE_IMAGES[service_type]:
        assert f"  {name}:\n    image: {IMAGES[name]}\n" in override
    assert ROLE_IMAGES[service_type] or override == "services: {}\n"


@pytest.mark.parametrize("images,reason", [
    (None, "has no image manifest for commit"),
    (_manifest(revision="0" * 40), "has no image manifest for commit"),
    (_manifest(changes={"server": None}), "no digest in this registry for 'server'"),
    (_manifest(changes={"server": f"{REGISTRY}/polis/server:{REVISION}"}), "no digest in this registry for 'server'"),
    (_manifest(changes={"server": IMAGES["server"].replace("123456789012", "999999999999")}),
     "no digest in this registry for 'server'"),
])
def test_a_bundle_without_its_images_deploys_nothing(tmp_path, images, reason):
    proc, log = _deploy(tmp_path, "server", images=images)
    assert proc.returncode != 0
    assert reason in proc.stdout
    assert not [c for c in _calls(log, "docker") if c.startswith("run")]
    assert _calls(log, "docker-compose") == []


def test_a_web_image_built_with_other_public_settings_is_refused(tmp_path):
    proc, log = _deploy(tmp_path, "server", images=_manifest(changes={"web-build-args-sha256": "0" * 64}))
    assert proc.returncode != 0
    assert "other public settings" in proc.stdout
    assert not [c for c in _calls(log, "docker") if c.startswith("run")]
    assert _compose(log) == ["config --format json"]


def test_the_previous_deployments_replaced_images_are_removed(tmp_path):
    old = IMAGES["server"][:-64] + "c" * 64
    proc, log = _deploy(tmp_path, "server", previous=_manifest(changes={"server": old}))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [c for c in _calls(log, "docker") if c.startswith("image rm")] == [f"image rm {old}"]
    assert log.index(f"docker image rm {old}") > log.index(
        f"docker-compose {COMPOSE_FILES}{UNCHANGED['server'][0]}")
    assert (tmp_path / "root/opt/polis/deployed-images.txt").read_text() == _manifest()
