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
  server: polis-api is pulled on every deploy and starts independently when
      POLIS_API_START is 1 or nginx-proxy receives a nonempty route selection;
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
import json
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
    "docker-compose": RECORD + 'case "$*" in *"--profile rust-api down"*) rm -f "$HOME/rust-running";; *"up -d --no-deps --no-build --force-recreate polis-api"*) [ "$FAKE_RUST_START_FAILURE" = 1 ] || touch "$HOME/rust-running";; esac\n' + 'case "$*" in *"--force-recreate polis-api-shadow"*) [ "${FAKE_SHADOW_START_FAILURE:-0}" != 1 ] || exit 1;; esac\n' + 'case "$*" in *"up -d --no-deps --no-build --force-recreate polis-api"*) [ "$FAKE_RUST_START_FAILURE" != 1 ];; esac\n',
    "curl": RECORD + 'case "$*" in *instance-id*) echo i-0123456789abcdef0;; *) echo token;; esac\n',
    # Real jq consumes its input; the fake must too, or pipefail can report
    # SIGPIPE from the producer when this reader exits before it writes.
    # The hook reads RUST_API_ROUTES from the composed config with jq.
    # The comment observer's switch is answered as Compose would compose it:
    # from the override file the hook wrote in its working directory, unless
    # a test says what the composed configuration holds.
    # The read-back of the shadow service's own settings prints the names of
    # the ones that are wrong: none, unless a test says which.
    "jq": RECORD + 'cat >/dev/null\n' + 'case "$*" in *POLIS_API_ROLE*) printf "%s\\n" "${FAKE_SHADOW_SETTINGS_WRONG-}";; *POLIS_API_DB_TRANSPORT*) printf "%s\\n" "${FAKE_POLIS_API_TRANSPORT:-tls}";; *POLIS_API_START*) printf "%s\\n" "${FAKE_POLIS_API_START-0}";; *RUST_API_ROUTES*) printf "%s\\n" "$FAKE_RUST_API_ROUTES";; *POLIS_API_POST_COMMENTS*) if [ -n "${FAKE_SHADOW_COMMENTS_SWITCH+set}" ]; then printf "%s\\n" "$FAKE_SHADOW_COMMENTS_SWITCH"; elif grep -qx "      - POLIS_API_POST_COMMENTS=observe" docker-compose.images.yml 2>/dev/null; then echo observe; else echo; fi;; *) echo value;; esac\n',
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
        'if [ "$1" = login ]; then cat >/dev/null; fi\n'
        'if [ "$1" = "$FAKE_MIGRATION_FAILURE" ]; then exit 17; fi\n'
        'if [ "$1" = pull ] && [ "$2" = "$FAKE_PULL_FAILURE_REF" ]; then exit 17; fi\n'
        'if [ "$1" = ps ]; then\n'
        '  filter=""\n'
        '  while [ $# -gt 0 ]; do [ "$1" = --filter ] && filter="${2#name=}"; shift; done\n'
        '  while read -r id name; do\n'
        '    if [ -z "$filter" ] || printf "/%s\\n" "$name" | grep -Eq -- "$filter"; then echo "$id"; fi\n'
        '  done < "$FAKE_CONTAINERS"\n'
        'fi\n'),
}


@pytest.mark.parametrize("command", [
    ["jq", "-r", ".username"],
    ["jq", "-r", '.services["nginx-proxy"].environment.RUST_API_ROUTES // ""'],
    ["docker", "login", "--username", "AWS", "--password-stdin", "registry.invalid"],
])
def test_pipeline_fakes_consume_all_input(tmp_path, command):
    _, env = _box(tmp_path, "server")
    payload = tmp_path / "input"
    # Larger than a pipe buffer: a non-reading fake cannot pass just because
    # the producer happened to finish before the consumer exited.
    payload.write_bytes(b"x" * (1024 * 1024))
    proc = subprocess.run(
        ["bash", "-o", "pipefail", "-c", 'cat "$1" | "${@:2}"',
         "pipeline", str(payload), *command],
        env=env, capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


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
         "delphi": "polis/delphi", "math-python": "polis/delphi", "migrate": "polis",
         "polis-api": "polis"}
# math-python runs the delphi image (deploy/build-images.sh).
IMAGES = {name: f"{REGISTRY}/{repo}@sha256:"
                + hashlib.sha256(("delphi" if name == "math-python" else name).encode()).hexdigest()
          for name, repo in REPOS.items()}
# The fake jq prints "value"; the hook hashes what jq prints.
WEB_ARGS_SHA256 = hashlib.sha256(b"value\n").hexdigest()
ROLE_IMAGES = {"server": ["server", "nginx-proxy", "client-participation-alpha", "polis-api"],
               "delphi": ["delphi", "math-python"], "math": [],
               "delphi-large": ["delphi"], "delphi-worker": ["delphi"]}
COMPOSE_FILES = "-f docker-compose.yml -f docker-compose.images.yml "
RUST_CONFIG = "-f docker-compose.yml --profile rust-api config --format json"


def _manifest(revision=REVISION, changes=None):
    """The image manifest the deploy workflow writes; a None value drops a line."""
    lines = {"revision": revision, **IMAGES, "web-build-args-sha256": WEB_ARGS_SHA256, **(changes or {})}
    return "".join(f"{k}={v}\n" for k, v in lines.items() if v is not None)


def _deploy(tmp_path, service_type, migration_failure="", revision=REVISION,
            not_on_branch=False, images="default", previous=None, pull_failure_ref="", rust_api_routes="", polis_api_start="0", rust_start_failure=False, transport="tls",
            shadow_start_failure=False, shadow_comments_switch=None, shadow_settings_wrong=None, **kw):
    root, env = _box(tmp_path, service_type, **kw)
    if shadow_comments_switch is not None:
        env["FAKE_SHADOW_COMMENTS_SWITCH"] = shadow_comments_switch
    if shadow_settings_wrong is not None:
        env["FAKE_SHADOW_SETTINGS_WRONG"] = shadow_settings_wrong
    env["FAKE_MIGRATION_FAILURE"] = migration_failure
    env["FAKE_PULL_FAILURE_REF"] = pull_failure_ref
    env["FAKE_RUST_API_ROUTES"] = rust_api_routes
    env["FAKE_POLIS_API_START"] = polis_api_start
    env["FAKE_POLIS_API_TRANSPORT"] = transport
    env["FAKE_RUST_START_FAILURE"] = "1" if rust_start_failure else "0"
    env["FAKE_SHADOW_START_FAILURE"] = "1" if shadow_start_failure else "0"
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
        down = "--profile rust-api down" if service_type == "server" else "down"
        assert compose.index(down) < compose.index(UNCHANGED[service_type][0])
    assert _calls(log, "systemctl") == []
    assert not [c for c in _calls(log, "docker") if c.startswith(("rm ", "system prune"))]


# nginx's entrypoint splits RUST_API_ROUTES on commas and blanks; a value with
# no route in it renders no Rust route, so polis-api is not started either.
@pytest.mark.parametrize("routes,starts", [
    ("", False), (" ", False), (",", False), (" , ,", False),
    ("robots,about", True), ("pca2", True), (" robots ", True),
])
def test_route_selection_starts_polis_api_without_the_independent_start_flag(tmp_path, routes, starts):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    ups = [c for c in _compose(log) if c.startswith("up")]
    if starts:
        assert ups == UNCHANGED["server"] + ["up -d --no-deps --no-build --force-recreate polis-api"]
    else:
        assert ups == UNCHANGED["server"]
    # Environment comes from the new revision before its image-only override
    # is written; the old deployment's override is not needed to resolve it.
    assert RUST_CONFIG in _calls(log, "docker-compose")
    assert '-r .services["nginx-proxy"].environment.RUST_API_ROUTES // ""' in _calls(log, "jq")
    # Pulled either way, before the migration, so turning the switch on needs
    # no other change to the bundle.
    assert log.index(f"docker pull {IMAGES['polis-api']}") < log.index(
        "docker run --rm --network host --env-file .env polis-migrate:deploy deploy")


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
        "docker-compose down", "docker-compose --profile rust-api down", "docker rm ", "docker system prune",
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
    assert [c for c in _compose(log) if c not in ("config --format json", RUST_CONFIG)] == []
    assert _calls(log, "systemctl") == []
    docker = _calls(log, "docker")
    pulls = ["pull"] * (1 + len(ROLE_IMAGES[service_type]))
    assert [call.split()[0] for call in docker] == (["login", "pull"] if failure == "pull" else ["login", *pulls, "tag", "run"])


@pytest.mark.parametrize("start", ["0", "1"])
@pytest.mark.parametrize("routes", ["", " , ", "pca2"])
def test_rust_digest_pull_failure_only_fails_when_a_route_is_selected(tmp_path, start, routes):
    proc, log = _deploy(tmp_path, "server", polis_api_start=start,
                        rust_api_routes=routes, pull_failure_ref=IMAGES["polis-api"])
    selected = routes == "pca2"
    assert proc.returncode == (17 if selected else 0), proc.stdout + proc.stderr
    pulls = [c for c in _calls(log, "docker") if c.startswith("pull ")]
    assert pulls == [f"pull {IMAGES[name]}" for name in ["migrate", *ROLE_IMAGES["server"]]]
    assert log.index(f"docker-compose {RUST_CONFIG}") < log.index(f"docker pull {IMAGES['migrate']}")
    calls = _compose(log)
    assert not any(c.startswith("up") and c.endswith("polis-api") for c in calls)
    assert [c for c in calls if c.startswith("up")] == ([] if selected else UNCHANGED["server"])
    assert ("--profile rust-api down" in calls) == (not selected)
    assert proc.stderr.count("Could not pull polis-api;") == (0 if selected else 1)
    migrations = [c for c in _calls(log, "docker") if c.startswith("run ")]
    assert bool(migrations) == (not selected)
    deployed = tmp_path / "root/opt/polis/deployed-images.txt"
    assert deployed.exists() == (not selected)
    if not selected:
        assert deployed.read_text() == _manifest()


@pytest.mark.parametrize("name", ["migrate", "server", "nginx-proxy", "client-participation-alpha"])
def test_required_image_pull_failure_stays_fatal_with_warm_rust(tmp_path, name):
    proc, log = _deploy(tmp_path, "server", polis_api_start="1", pull_failure_ref=IMAGES[name])
    assert proc.returncode == 17, proc.stdout + proc.stderr
    assert not [c for c in _calls(log, "docker") if c.startswith("run ")]
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]
    assert "Could not pull polis-api;" not in proc.stderr


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
    assert all(c.startswith(COMPOSE_FILES) for c in _calls(log, "docker-compose") if c not in ("config --format json", RUST_CONFIG))
    override = (tmp_path / "root/opt/polis/polis/docker-compose.images.yml").read_text()
    for name in ROLE_IMAGES[service_type]:
        assert f"  {name}:\n    image: {IMAGES[name]}\n" in override
    assert ROLE_IMAGES[service_type] or override == "services: {}\n"


@pytest.mark.parametrize("images,reason", [
    (None, "has no image manifest for commit"),
    (_manifest(revision="0" * 40), "has no image manifest for commit"),
    (_manifest(changes={"server": None}), "no digest in this registry for 'server'"),
    (_manifest(changes={"polis-api": None}), "no digest in this registry for 'polis-api'"),
    (_manifest(changes={"server": f"{REGISTRY}/polis/server:{REVISION}"}), "no digest in this registry for 'server'"),
    (_manifest(changes={"server": IMAGES["server"].replace("123456789012", "999999999999")}),
     "no digest in this registry for 'server'"),
])
def test_a_bundle_without_its_images_deploys_nothing(tmp_path, images, reason):
    proc, log = _deploy(tmp_path, "server", images=images)
    assert proc.returncode != 0
    assert reason in proc.stdout
    assert not [c for c in _calls(log, "docker") if c.startswith("run")]
    assert all(c == RUST_CONFIG for c in _compose(log))


def test_a_web_image_built_with_other_public_settings_is_refused(tmp_path):
    proc, log = _deploy(tmp_path, "server", images=_manifest(changes={"web-build-args-sha256": "0" * 64}))
    assert proc.returncode != 0
    assert "other public settings" in proc.stdout
    assert not [c for c in _calls(log, "docker") if c.startswith("run")]
    assert _compose(log) == [RUST_CONFIG, RUST_CONFIG, "config --format json"]


def test_the_previous_deployments_replaced_images_are_removed(tmp_path):
    old = IMAGES["server"][:-64] + "c" * 64
    proc, log = _deploy(tmp_path, "server", previous=_manifest(changes={"server": old}))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [c for c in _calls(log, "docker") if c.startswith("image rm")] == [f"image rm {old}"]
    assert log.index(f"docker image rm {old}") > log.index(
        f"docker-compose {COMPOSE_FILES}{UNCHANGED['server'][0]}")
    assert (tmp_path / "root/opt/polis/deployed-images.txt").read_text() == _manifest()


@pytest.mark.parametrize("start", ["", "true", "2", " 1"])
def test_invalid_start_refuses_before_down(tmp_path, start):
    proc, log = _deploy(tmp_path, "server", polis_api_start=start)
    assert proc.returncode != 0
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]


@pytest.mark.parametrize("routes", ["", " , ", "pca2"])
def test_failed_rust_start_only_fails_deploy_when_a_route_is_selected(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", polis_api_start="1", rust_api_routes=routes, rust_start_failure=True)
    assert (proc.returncode != 0) == (routes == "pca2")
    if routes != "pca2":
        assert "continuing the Node deployment" in proc.stderr
        assert (tmp_path / "root/opt/polis/deployed-images.txt").read_text() == _manifest()
    calls = _compose(log)
    assert calls[-2:] == UNCHANGED["server"] + ["up -d --no-deps --no-build --force-recreate polis-api"]
    assert calls.count("--profile rust-api down") == 1


def test_warm_service_starts_with_no_selected_routes(tmp_path):
    proc, log = _deploy(tmp_path, "server", polis_api_start="1")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [c for c in _compose(log) if c.startswith("up")] == UNCHANGED["server"] + [
        "up -d --no-deps --no-build --force-recreate polis-api"]


@pytest.mark.parametrize("transport", ["docker-internal", "loopback", "local"])
def test_web_service_refuses_unverified_transport_before_down(tmp_path, transport):
    proc, log = _deploy(tmp_path, "server", polis_api_start="1", transport=transport)
    assert proc.returncode != 0
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]


@pytest.mark.parametrize("routes", ["", " , "])
def test_disabling_the_warm_start_removes_the_previous_profile_container(tmp_path, routes):
    # Model an already-running profile service: plain down does not remove it.
    running = tmp_path / "rust-running"
    running.touch()
    proc, log = _deploy(tmp_path, "server", polis_api_start="0", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not running.exists()
    calls = _compose(log)
    assert calls.index("--profile rust-api down") < calls.index(UNCHANGED["server"][0])
    assert not any(c.startswith("up") and c.endswith("polis-api") for c in calls)


# The vote shadow (RUST_API_ROUTES names votesShadow): nginx copies each vote
# Node answers to polis-api-shadow, which runs the polis-api image the hook
# already pulls. The route list is split on commas and blanks, as nginx's
# renderer splits it.
POLIS_API_UP = "up -d --no-deps --no-build --force-recreate polis-api"
SHADOW_UP = "up -d --no-deps --no-build --force-recreate polis-api-shadow"
SHADOW_TRANSPORT = '-r .services["polis-api-shadow"].environment.POLIS_API_DB_TRANSPORT // "tls"'


@pytest.mark.parametrize("routes", ["votesShadow", "pca2,votesShadow", " pca2 , votesShadow ",
                                    "pca2 votesShadow", "votesShadow,votesShadow", "votesRead,votesShadow"])
def test_the_vote_shadow_starts_after_polis_api_when_selected(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    calls = _compose(log)
    assert [c for c in calls if c.startswith("up")] == UNCHANGED["server"] + [POLIS_API_UP, SHADOW_UP]
    # The shared teardown removes the previous shadow container too.
    assert calls.index("--profile rust-api down") < calls.index(UNCHANGED["server"][0])
    # It runs the polis-api digest; nothing else is pulled for it.
    pulls = [c for c in _calls(log, "docker") if c.startswith("pull ")]
    assert pulls == [f"pull {IMAGES[name]}" for name in ["migrate", *ROLE_IMAGES["server"]]]
    override = (tmp_path / "root/opt/polis/polis/docker-compose.images.yml").read_text()
    assert f"  polis-api-shadow:\n    image: {IMAGES['polis-api']}\n" in override
    # Its database transport is checked before anything is replaced.
    assert SHADOW_TRANSPORT in _calls(log, "jq")
    assert log.index(f"jq {SHADOW_TRANSPORT}") < log.index(f"docker pull {IMAGES['migrate']}")


@pytest.mark.parametrize("routes", ["", " , ", "pca2", "votesRead", "votesShadows", "xvotesShadow",
                                    "votesshadow", "pca2,votesRead"])
def test_the_vote_shadow_is_not_started_unselected(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    calls = _compose(log)
    assert SHADOW_UP not in calls
    assert SHADOW_TRANSPORT not in _calls(log, "jq")
    # The shadow is in the rust-api profile, so a container from an earlier
    # selection is removed by the teardown before anything starts.
    assert calls.index("--profile rust-api down") < calls.index(UNCHANGED["server"][0])


@pytest.mark.parametrize("routes", ["postVotes,votesShadow", "votesShadow postVotes",
                                    "pca2, postVotes ,votesShadow"])
def test_the_shadow_and_the_live_vote_writer_are_refused_together(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode != 0
    assert "votesShadow and postVotes" in proc.stderr
    # Refused before any image, migration or service replacement.
    assert not [c for c in _calls(log, "docker") if c.startswith(("pull", "run"))]
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]


def test_a_shadow_start_failure_fails_the_deploy(tmp_path):
    proc, log = _deploy(tmp_path, "server", rust_api_routes="pca2,votesShadow", shadow_start_failure=True)
    assert proc.returncode != 0
    assert "polis-api-shadow start failed" in proc.stderr
    assert [c for c in _compose(log) if c.startswith("up")] == UNCHANGED["server"] + [POLIS_API_UP, SHADOW_UP]
    assert not (tmp_path / "root/opt/polis/deployed-images.txt").exists()


@pytest.mark.parametrize("transport", ["docker-internal", "loopback", "local"])
def test_the_shadow_refuses_unverified_transport_before_down(tmp_path, transport):
    proc, log = _deploy(tmp_path, "server", rust_api_routes="votesShadow", transport=transport)
    assert proc.returncode != 0
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]


def test_the_shadow_service_carries_its_own_writer_settings():
    # The writer's settings live in the service's own environment, so the
    # shared env document carries none of them; the signing key is blanked.
    compose = _find(Path("docker-compose.yml")).read_text()
    block = compose.split("\n  polis-api-shadow:\n", 1)[1].split("\n\n", 1)[0]
    lines = [line.strip() for line in block.splitlines()]
    for line in ["profiles: [rust-api]", "image: polis/polis-api:local",
                 "- POLIS_API_ROLE=shadow", "- POLIS_API_SHADOW_LISTEN=0.0.0.0:5101",
                 "- POLIS_API_POST_VOTES=observe",
                 "- POLIS_API_POST_VOTES_DATABASE_URL=${DATABASE_URL:-}",
                 "- TOPICAL_COMMENT_RATIO=0", "- SHOULD_USE_TRANSLATION_API=false",
                 "- POLIS_API_WRITER_PRIORITIES_CACHE_BYTES=134217728",
                 "- JWT_PRIVATE_KEY=", "- JWT_PRIVATE_KEY_PATH=",
                 "- POLIS_API_DB_TRANSPORT=${POLIS_API_DB_TRANSPORT:-tls}",
                 "- POLIS_API_DB_CA_FILE=${POLIS_API_DB_CA_FILE:-/etc/polis/rds-global-bundle.pem}",
                 "- POLIS_API_DB_HOST_ALLOWLIST=${POLIS_API_DB_HOST_ALLOWLIST:-}",
                 "cpus: 0.25", "mem_limit: 384m", "read_only: true", "cap_drop: [ALL]"]:
        assert line in lines, line
    (rate,) = [line for line in lines if line.startswith("- POLIS_API_SHADOW_MAX_PER_SECOND=")]
    assert 1 <= int(rate.split("=", 1)[1]) <= 25
    assert not [line for line in lines if line.startswith("ports:")], "the shadow publishes no port"


# The comment shadow (RUST_API_ROUTES names commentsShadow): nginx copies each
# comment Node answers to the same polis-api-shadow service, which starts when
# either shadow is selected. Its comment observer's switch is derived here
# from the route list and written into the Compose override the hook writes:
# observe exactly when commentsShadow is named, and otherwise nothing, which
# leaves docker-compose.yml's empty switch.
SHADOW_COMMENTS_SWITCH = '-r .services["polis-api-shadow"].environment.POLIS_API_POST_COMMENTS // ""'
SHADOW_CONFIG = COMPOSE_FILES + "--profile rust-api config --format json"
SHADOW_IMAGE_LINES = f"  polis-api-shadow:\n    image: {IMAGES['polis-api']}\n"
SHADOW_OBSERVE_LINES = "    environment:\n      - POLIS_API_POST_COMMENTS=observe\n"


def _override(tmp_path):
    return (tmp_path / "root/opt/polis/polis/docker-compose.images.yml").read_text()


@pytest.mark.parametrize("routes", ["commentsShadow", "pca2,commentsShadow", " pca2 , commentsShadow ",
                                    "pca2 commentsShadow", "commentsShadow,commentsShadow",
                                    "comments,commentsShadow", "pca2,votesShadow,commentsShadow",
                                    "commentsShadow,votesShadow,pca2", "pca2 votesShadow commentsShadow",
                                    "commentsShadow,postVotes"])
def test_the_shadow_service_starts_with_the_comment_observer_when_selected(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    calls = _compose(log)
    assert [c for c in calls if c.startswith("up")] == UNCHANGED["server"] + [POLIS_API_UP, SHADOW_UP]
    assert calls.index("--profile rust-api down") < calls.index(UNCHANGED["server"][0])
    # One service, started once, on the polis-api digest; nothing else is pulled.
    assert calls.count(SHADOW_UP) == 1
    pulls = [c for c in _calls(log, "docker") if c.startswith("pull ")]
    assert pulls == [f"pull {IMAGES[name]}" for name in ["migrate", *ROLE_IMAGES["server"]]]
    # The override names the image and switches the comment observer on, and
    # says nothing else about the service.
    override = _override(tmp_path)
    assert override.endswith(SHADOW_IMAGE_LINES + SHADOW_OBSERVE_LINES)
    assert override.count("POLIS_API_POST_COMMENTS") == 1 and override.count("environment:") == 1
    # The composed switch is read back before anything is replaced.
    assert SHADOW_COMMENTS_SWITCH in _calls(log, "jq")
    assert log.index(f"jq {SHADOW_COMMENTS_SWITCH}") < log.index(
        f"docker-compose {COMPOSE_FILES}--profile rust-api down")
    assert SHADOW_CONFIG in _calls(log, "docker-compose")
    assert SHADOW_TRANSPORT in _calls(log, "jq")


@pytest.mark.parametrize("routes", ["votesShadow", "pca2,votesShadow", " pca2 , votesShadow ",
                                    "pca2 votesShadow", "votesRead,votesShadow", "votesShadow,postComments"])
def test_the_vote_shadow_alone_leaves_the_comment_observer_off(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [c for c in _compose(log) if c.startswith("up")] == UNCHANGED["server"] + [POLIS_API_UP, SHADOW_UP]
    # The override is what it was before the comment shadow existed: images only.
    override = _override(tmp_path)
    expected = "services:\n" + "".join(f"  {name}:\n    image: {IMAGES[name]}\n"
                                       for name in ROLE_IMAGES["server"]) + SHADOW_IMAGE_LINES
    assert override == expected
    assert "environment" not in override and "POLIS_API_POST_COMMENTS" not in override
    # The composed switch is still read back, and must be empty.
    assert SHADOW_COMMENTS_SWITCH in _calls(log, "jq")


@pytest.mark.parametrize("routes", ["", " , ", "pca2", "pca2,version", "comments", "pca2,comments",
                                    "commentsShadows", "xcommentsShadow", "commentsshadow", "CommentsShadow",
                                    "commentShadow", "postComments"])
def test_no_shadow_selected_starts_no_shadow_service_and_writes_no_switch(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    calls = _compose(log)
    assert SHADOW_UP not in calls
    assert SHADOW_TRANSPORT not in _calls(log, "jq")
    assert SHADOW_COMMENTS_SWITCH not in _calls(log, "jq")
    override = _override(tmp_path)
    assert override.endswith(SHADOW_IMAGE_LINES)
    assert "environment" not in override and "POLIS_API_POST_COMMENTS" not in override
    assert calls.index("--profile rust-api down") < calls.index(UNCHANGED["server"][0])


@pytest.mark.parametrize("routes", ["postComments,commentsShadow", "commentsShadow postComments",
                                    "pca2,votesShadow, postComments ,commentsShadow"])
def test_the_comment_shadow_and_a_live_comment_route_are_refused_together(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode != 0
    assert "commentsShadow and postComments" in proc.stderr
    # Refused before any image, migration or service replacement.
    assert not [c for c in _calls(log, "docker") if c.startswith(("pull", "run"))]
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]


def test_the_vote_refusal_still_applies_beside_the_comment_shadow(tmp_path):
    proc, log = _deploy(tmp_path, "server", rust_api_routes="commentsShadow,postVotes,votesShadow")
    assert proc.returncode != 0
    assert "votesShadow and postVotes" in proc.stderr
    assert not [c for c in _calls(log, "docker") if c.startswith(("pull", "run"))]


@pytest.mark.parametrize("routes,composed", [
    ("pca2,commentsShadow", ""), ("pca2,commentsShadow", "0"), ("pca2,commentsShadow", "1"),
    ("pca2,votesShadow,commentsShadow", ""), ("pca2,votesShadow,commentsShadow", "Observe"),
    ("pca2,votesShadow", "observe"), ("pca2,votesShadow", "1"), ("pca2,votesShadow", "0"),
    ("votesShadow", "value"),
])
def test_a_composed_switch_that_does_not_follow_the_route_list_is_refused_before_replacement(tmp_path, routes, composed):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes, shadow_comments_switch=composed)
    assert proc.returncode != 0
    assert "comment observer switch does not follow RUST_API_ROUTES" in proc.stderr
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]
    assert not (tmp_path / "root/opt/polis/deployed-images.txt").exists()


@pytest.mark.parametrize("routes,composed", [("pca2,commentsShadow", "observe"), ("pca2,votesShadow", ""),
                                             ("pca2,votesShadow,commentsShadow", "observe")])
def test_a_composed_switch_that_follows_the_route_list_is_accepted(tmp_path, routes, composed):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes, shadow_comments_switch=composed)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert SHADOW_UP in _compose(log)


@pytest.mark.parametrize("routes", ["commentsShadow", "pca2,votesShadow,commentsShadow"])
def test_a_comment_shadow_start_failure_fails_the_deploy(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes, shadow_start_failure=True)
    assert proc.returncode != 0
    assert "polis-api-shadow start failed" in proc.stderr
    assert not (tmp_path / "root/opt/polis/deployed-images.txt").exists()


@pytest.mark.parametrize("transport", ["docker-internal", "loopback", "local"])
def test_the_comment_shadow_refuses_unverified_transport_before_down(tmp_path, transport):
    proc, log = _deploy(tmp_path, "server", rust_api_routes="commentsShadow", transport=transport)
    assert proc.returncode != 0
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]


@pytest.mark.parametrize("service_type,worker_class", [("delphi", None), ("math", None),
                                                       ("delphi-large", "large"), ("delphi-worker", "delphi")])
def test_other_roles_never_read_or_write_the_comment_switch(tmp_path, service_type, worker_class):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class,
                        rust_api_routes="pca2,votesShadow,commentsShadow")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert SHADOW_COMMENTS_SWITCH not in _calls(log, "jq")
    assert "polis-api-shadow" not in _override(tmp_path)


def test_the_shadow_service_carries_the_comment_observers_settings_with_its_switch_off():
    # The switch is a literal empty value, so neither this file nor the env
    # document can turn the comment observer on; what the observer requires is
    # always present, so the hook's override line is the only thing that changes.
    compose = _find(Path("docker-compose.yml")).read_text()
    block = compose.split("\n  polis-api-shadow:\n", 1)[1].split("\n\n", 1)[0]
    lines = [line.strip() for line in block.splitlines()]
    assert "- POLIS_API_POST_COMMENTS=" in lines
    assert not [line for line in lines if line.startswith("- POLIS_API_POST_COMMENTS=") and line != "- POLIS_API_POST_COMMENTS="]
    assert "- POLIS_API_POST_COMMENTS_DATABASE_URL=${DATABASE_URL:-}" in lines
    assert "- SHOULD_USE_TRANSLATION_API=false" in lines
    (rate,) = [line for line in lines if line.startswith("- POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND=")]
    assert 1 <= int(rate.split("=", 1)[1]) <= 6
    # The vote observer's settings are untouched.
    assert "- POLIS_API_POST_VOTES=observe" in lines
    assert "- POLIS_API_SHADOW_MAX_PER_SECOND=8" in lines
    # Nothing else in the file names the comment handler's switch: the main
    # polis-api takes it from the env document, as it takes the vote switch.
    assert compose.count("POLIS_API_POST_COMMENTS=") == 1


# The read-back also covers what makes the service the shadow service at all:
# the settings docker-compose.yml gives it and the hook's override never
# names. A composition that lost them (the service's environment list
# replaced by the override's one entry, say) would pass the switch's check
# and start the main role. The hook reads them from the same composed
# configuration, before anything is replaced, and jq prints only the names of
# the settings that are wrong.
SHADOW_SETTINGS = {"POLIS_API_ROLE": "shadow", "POLIS_API_SHADOW_LISTEN": "0.0.0.0:5101",
                   "POLIS_API_POST_VOTES": "observe", "JWT_PRIVATE_KEY": "", "JWT_PRIVATE_KEY_PATH": ""}
SHADOW_ROUTES = ["votesShadow", "pca2,votesShadow", "pca2,commentsShadow", "pca2,votesShadow,commentsShadow"]


def _settings_program():
    """The jq program the hook runs on the composed configuration."""
    (line,) = [line for line in HOOK_PATH.read_text().splitlines() if line.lstrip().startswith("SHADOW_SETTINGS_WRONG=$(")]
    assert line.count("'") == 2, "the read-back's jq program is not one single-quoted argument"
    command, program, closing = line.split("'")
    assert command.strip() == ("SHADOW_SETTINGS_WRONG=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml "
                               "-f docker-compose.images.yml --profile rust-api config --format json | jq -r")
    assert closing == ")"
    return program


def _settings_call():
    return "-r " + _settings_program()


@pytest.mark.parametrize("routes", SHADOW_ROUTES)
@pytest.mark.parametrize("wrong", [*SHADOW_SETTINGS, " ".join(SHADOW_SETTINGS),
                                   "POLIS_API_ROLE POLIS_API_SHADOW_LISTEN POLIS_API_POST_VOTES"])
def test_a_composed_shadow_service_without_its_own_settings_is_refused_before_replacement(tmp_path, routes, wrong):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes, shadow_settings_wrong=wrong)
    assert proc.returncode != 0
    assert f"composed settings are not the shadow service's ({wrong}); refusing service replacement" in proc.stderr
    # Nothing was torn down or started, and the box's record of what it runs
    # is untouched.
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]
    assert not (tmp_path / "root/opt/polis/deployed-images.txt").exists()
    # The comment switch's own check had passed: this is the case it cannot see.
    assert "comment observer switch does not follow" not in proc.stderr


@pytest.mark.parametrize("routes", SHADOW_ROUTES)
def test_the_shadow_services_own_settings_are_read_back_before_anything_is_replaced(tmp_path, routes):
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _calls(log, "jq").count(_settings_call()) == 1
    # From the composed configuration, override included (one such call for
    # the switch and one for these), after the switch's check and before the
    # teardown.
    assert _calls(log, "docker-compose").count(SHADOW_CONFIG) == 2
    read = log.index(f"jq {_settings_call()}")
    assert read < log.index(f"docker-compose {COMPOSE_FILES}--profile rust-api down")
    assert log.index(f"jq {SHADOW_COMMENTS_SWITCH}") < read
    assert SHADOW_UP in _compose(log)


@pytest.mark.parametrize("routes", ["pca2,votesShadow", "pca2,votesShadow,commentsShadow"])
def test_a_wrong_comment_switch_is_still_refused_first(tmp_path, routes):
    # Both wrong: the switch's verdict is the one given, as before.
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes, shadow_comments_switch="1",
                        shadow_settings_wrong="POLIS_API_ROLE")
    assert proc.returncode != 0
    assert "comment observer switch does not follow RUST_API_ROUTES" in proc.stderr
    assert "composed settings are not the shadow service's" not in proc.stderr
    assert not [c for c in _compose(log) if c.endswith("down") or c.startswith("up")]


@pytest.mark.parametrize("routes", ["", " , ", "pca2", "pca2,version", "comments", "votesRead", "postComments",
                                    "commentsShadows", "votesshadow"])
def test_no_shadow_selected_reads_back_no_shadow_setting(tmp_path, routes):
    # Even a composition that would be refused is not read when no shadow
    # starts: the deploy is what it was.
    proc, log = _deploy(tmp_path, "server", rust_api_routes=routes, shadow_settings_wrong="POLIS_API_ROLE")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _settings_call() not in _calls(log, "jq")
    assert SHADOW_UP not in _compose(log)


@pytest.mark.parametrize("service_type,worker_class", [("delphi", None), ("math", None),
                                                       ("delphi-large", "large"), ("delphi-worker", "delphi")])
def test_other_roles_never_read_back_the_shadow_services_settings(tmp_path, service_type, worker_class):
    proc, log = _deploy(tmp_path, service_type, worker_class=worker_class,
                        rust_api_routes="pca2,votesShadow,commentsShadow", shadow_settings_wrong="POLIS_API_ROLE")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _settings_call() not in _calls(log, "jq")


def test_the_read_back_names_settings_and_never_prints_a_value():
    # The program is exactly one comparison for each setting, each printing
    # the setting's name when it is not the value docker-compose.yml gives the
    # service: no part of it prints what a setting holds.
    comparisons = ", ".join(f'(if ($e.{name} // "") == "{value}" then empty else "{name}" end)'
                            for name, value in SHADOW_SETTINGS.items())
    assert _settings_program() == f'.services["polis-api-shadow"].environment as $e | [{comparisons}] | join(" ")'
    # And those values are the literals of the service in docker-compose.yml.
    compose = _find(Path("docker-compose.yml")).read_text()
    block = compose.split("\n  polis-api-shadow:\n", 1)[1].split("\n\n", 1)[0]
    lines = [line.strip() for line in block.splitlines()]
    for name, value in SHADOW_SETTINGS.items():
        assert [line for line in lines if line.startswith(f"- {name}=")] == [f"- {name}={value}"], name


# The program itself, run by the real jq on the shapes Compose prints for a
# service's environment (an object of names to strings; a setting given as
# `NAME=` is "", one Compose leaves unresolved is null, one it does not print
# is absent). The tests above give jq's answer; this one is jq's. A machine
# without jq skips it (the stack test runs the same program on what the real
# Compose composes).
_RIGHT = dict(SHADOW_SETTINGS, POLIS_API_POST_COMMENTS="", POLIS_API_DB_TRANSPORT="tls",
              DATABASE_URL="postgres://u:not-printed@db/polis", JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----")
_KEY = "-----BEGIN PRIVATE KEY-----not-printed"


def _without(*names):
    return {name: value for name, value in _RIGHT.items() if name not in names}


@pytest.mark.skipif(shutil.which("jq") is None, reason="runs the hook's jq program with the real jq")
@pytest.mark.parametrize("environment,named", [
    (_RIGHT, ""),
    (dict(_RIGHT, JWT_PRIVATE_KEY=None, JWT_PRIVATE_KEY_PATH=None), ""),
    (_without("JWT_PRIVATE_KEY", "JWT_PRIVATE_KEY_PATH"), ""),
    (dict(_RIGHT, POLIS_API_POST_COMMENTS="observe"), ""),
    (dict(_RIGHT, POLIS_API_ROLE="main"), "POLIS_API_ROLE"),
    (dict(_RIGHT, POLIS_API_ROLE=""), "POLIS_API_ROLE"),
    (dict(_RIGHT, POLIS_API_ROLE=None), "POLIS_API_ROLE"),
    (_without("POLIS_API_ROLE"), "POLIS_API_ROLE"),
    (dict(_RIGHT, POLIS_API_SHADOW_LISTEN="0.0.0.0:5100"), "POLIS_API_SHADOW_LISTEN"),
    (_without("POLIS_API_SHADOW_LISTEN"), "POLIS_API_SHADOW_LISTEN"),
    (dict(_RIGHT, POLIS_API_POST_VOTES="1"), "POLIS_API_POST_VOTES"),
    (dict(_RIGHT, POLIS_API_POST_VOTES=""), "POLIS_API_POST_VOTES"),
    (_without("POLIS_API_POST_VOTES"), "POLIS_API_POST_VOTES"),
    (dict(_RIGHT, JWT_PRIVATE_KEY=_KEY), "JWT_PRIVATE_KEY"),
    (dict(_RIGHT, JWT_PRIVATE_KEY_PATH="/run/secrets/not-printed"), "JWT_PRIVATE_KEY_PATH"),
    (dict(_RIGHT, JWT_PRIVATE_KEY=_KEY, JWT_PRIVATE_KEY_PATH="/run/secrets/not-printed"),
     "JWT_PRIVATE_KEY JWT_PRIVATE_KEY_PATH"),
    # The service's list replaced by the override's one entry, with the env
    # document's signing key then reaching the service.
    ({"POLIS_API_POST_COMMENTS": "observe", "JWT_PRIVATE_KEY": _KEY},
     "POLIS_API_ROLE POLIS_API_SHADOW_LISTEN POLIS_API_POST_VOTES JWT_PRIVATE_KEY"),
    ({}, "POLIS_API_ROLE POLIS_API_SHADOW_LISTEN POLIS_API_POST_VOTES"),
    (None, "POLIS_API_ROLE POLIS_API_SHADOW_LISTEN POLIS_API_POST_VOTES"),
])
def test_the_real_jq_names_exactly_the_wrong_settings_and_prints_no_value(environment, named):
    composed = {"services": {"polis-api": {"environment": {"POLIS_API_ROLE": "main"}},
                             "polis-api-shadow": {"environment": environment}}}
    if environment is None:
        del composed["services"]["polis-api-shadow"]
    proc = subprocess.run(["jq", "-r", _settings_program()], input=json.dumps(composed),
                          text=True, capture_output=True)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == named + "\n"
    assert "not-printed" not in proc.stdout + proc.stderr
