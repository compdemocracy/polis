"""deploy/build-images.sh builds and pushes every image a production box runs,
polis-api included, and deploy/build-on-box.sh accepts exactly the manifest it
prints.

Runs the real scripts with every external command faked on PATH: aws, docker,
docker-compose, python3, jq, flock and sleep only record their arguments (aws answers
the few reads the scripts make; docker login reads its password from stdin).
The build box's absolute paths (/run/polis-build, /var/log/polis-build) are
rewritten into a temporary root.

polis-api has no repository of its own: like the migration runner it goes to
`polis`, tagged `polis-api-<commit>` (the build box may push only to
cdk/buildBox.ts BUILD_REPOSITORIES), and scripts/after_install.sh pulls it by
the digest this manifest names.

The scripts are located like ``test_after_install_hook.py`` locates the hooks:
$POLIS_CHECKOUT_DIR, else an ancestor of this file.
"""

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

BUILD = Path("deploy") / "build-images.sh"
ON_BOX = Path("deploy") / "build-on-box.sh"


def _find(rel):
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / rel).is_file():
            return candidate / rel
    return None


BUILD_PATH = _find(BUILD)
ON_BOX_PATH = _find(ON_BOX)
pytestmark = [
    pytest.mark.skipif(BUILD_PATH is None or ON_BOX_PATH is None,
                       reason=f"{BUILD} / {ON_BOX} not found in $POLIS_CHECKOUT_DIR nor any ancestor"),
    pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available"),
]

REVISION = "89abcdef0123456789abcdef0123456789abcdef"
REGISTRY = "123456789012.dkr.ecr.us-east-1.amazonaws.com"
# The image regex after_install.sh and build-on-box.sh check each line against.
IMAGE_RE = re.compile(r"[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com/polis(/[a-z-]+)?@sha256:[0-9a-f]{64}")
REFS = {
    "server": f"{REGISTRY}/polis/server:{REVISION}",
    "nginx-proxy": f"{REGISTRY}/polis/nginx-proxy:{REVISION}",
    "client-participation-alpha": f"{REGISTRY}/polis/client-participation-alpha:{REVISION}",
    "delphi": f"{REGISTRY}/polis/delphi:{REVISION}",
    "migrate": f"{REGISTRY}/polis:migrate-{REVISION}",
    "polis-api": f"{REGISTRY}/polis:polis-api-{REVISION}",
}

RECORD = '#!/bin/bash\necho "$(basename "$0") $*" >> "$FAKE_LOG"\n'
FAKES = {
    "python3": RECORD + 'echo "{}"\n',
    "flock": RECORD,
    "sleep": RECORD,
    "jq": RECORD + "echo value\n",
    # `docker login --password-stdin` reads the password to EOF, as the real one
    # does. A fake that exits unread can close the pipe before the aws fake
    # writes the password; aws then dies of SIGPIPE and build-images.sh
    # (pipefail) fails "ECR login", as it did intermittently under pytest-xdist.
    "docker": RECORD + 'case "$1" in login) cat > /dev/null;; esac\n',
    "docker-compose": RECORD + 'case " $* " in *" config "*) echo "{}";; esac\n',
    # The registry digest of repo:tag is sha256("repo:tag").
    "aws": RECORD + (
        'case "$*" in\n'
        '  *"sts get-caller-identity"*) echo 123456789012;;\n'
        '  *"ecr get-login-password"*) echo token;;\n'
        '  *"ecr describe-images"*)\n'
        '    while [ $# -gt 0 ]; do case "$1" in --repository-name) repo=$2;; --image-ids) tag=${2#imageTag=};; esac; shift; done\n'
        '    echo "sha256:$(printf "%s" "$repo:$tag" | sha256sum | cut -d" " -f1)";;\n'
        '  *"ec2 run-instances"*) echo i-0123456789abcdef0;;\n'
        '  *"ssm describe-instance-information"*) echo Online;;\n'
        '  *"ec2 describe-instances"*) echo running;;\n'
        '  *"ssm send-command"*) echo 01234567-89ab-cdef-0123-456789abcdef;;\n'
        '  *"--query Status"*) echo Success;;\n'
        '  *"--query StandardOutputContent"*) cat "$FAKE_BUILD_OUTPUT";;\n'
        'esac\n'),
}


def _digest(repo, tag):
    return f"{REGISTRY}/{repo}@sha256:" + hashlib.sha256(f"{repo}:{tag}".encode()).hexdigest()


def _env(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in FAKES.items():
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    return {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path), "FAKE_LOG": str(tmp_path / "log")}


def _calls(tmp_path, tool):
    log = (tmp_path / "log").read_text().splitlines() if (tmp_path / "log").exists() else []
    return [line[len(tool) + 1:] for line in log if line.split(" ", 1)[0] == tool]


def _build(tmp_path):
    """Runs build-images.sh from a source tree in tmp_path/src; returns (proc, src)."""
    root = tmp_path / "root"
    src = tmp_path / "src"
    (src / "deploy").mkdir(parents=True)
    text = BUILD_PATH.read_text()
    for old in ("/run/polis-build", "/var/log/polis-build"):
        assert old in text, f"build-images.sh no longer uses {old}; update this test's rewrite"
        text = text.replace(old, f"{root}{old}")
    (src / "deploy" / "build-images.sh").write_text(text)
    (root / "run").mkdir(parents=True)
    (root / "var/log").mkdir(parents=True)
    env = _env(tmp_path)
    env.update({name: "x" for name in ("PUBLIC_SERVICE_URL", "AUTH_NAMESPACE", "OIDC_CACHE_KEY_PREFIX",
                                       "OIDC_CACHE_KEY_ID_TOKEN_SUFFIX")})
    proc = subprocess.run(["bash", str(src / "deploy" / "build-images.sh"), REVISION], env=env,
                          cwd=tmp_path, capture_output=True, text=True, timeout=60)
    return proc, src


def _manifest(stdout):
    lines = stdout.splitlines()
    body = lines[lines.index("POLIS_IMAGE_MANIFEST_BEGIN") + 1:lines.index("POLIS_IMAGE_MANIFEST_END")]
    return dict(line.split("=", 1) for line in body)


def test_polis_api_is_built_pushed_and_named_in_the_manifest(tmp_path):
    proc, src = _build(tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # The override names every image by repository and tag.
    override = yaml.safe_load((src / "docker-compose.build.yml").read_text())["services"]
    assert {name: block["image"] for name, block in override.items()} == REFS
    # One build of every service; polis-api's profile is named.
    builds = [c for c in _calls(tmp_path, "docker-compose") if " build " in f" {c} "]
    assert builds == ["-f docker-compose.yml -f docker-compose.build.yml --profile rust-api build "
                      f"--build-arg GIT_HASH={REVISION} --build-arg POLIS_BUILD_DISTANCE=unknown "
                      "--build-arg POLIS_BUILD_TAG= --build-arg POLIS_BUILD_SOURCE=unverified-archive "
                      "server nginx-proxy client-participation-alpha delphi migrate polis-api"]
    pushes = [c.split()[1] for c in _calls(tmp_path, "docker") if c.startswith("push ")]
    assert pushes == [*REFS.values(), f"{REGISTRY}/polis/server:latest"]
    # Each digest is read back from the image's own repository and tag.
    reads = [c for c in _calls(tmp_path, "aws") if c.startswith("ecr describe-images")]
    assert any("--repository-name polis --image-ids imageTag=polis-api-" + REVISION in c for c in reads)
    manifest = _manifest(proc.stdout)
    assert list(manifest) == ["revision", "server", "nginx-proxy", "client-participation-alpha", "delphi",
                              "migrate", "polis-api", "math-python", "web-build-args-sha256"]
    assert manifest["revision"] == REVISION
    assert manifest["polis-api"] == _digest("polis", f"polis-api-{REVISION}")
    assert manifest["migrate"] == _digest("polis", f"migrate-{REVISION}")
    assert manifest["server"] == _digest("polis/server", REVISION)
    assert manifest["math-python"] == manifest["delphi"]
    for name, ref in manifest.items():
        if name not in ("revision", "web-build-args-sha256"):
            assert IMAGE_RE.fullmatch(ref), (name, ref)


def _on_box(tmp_path, build_output):
    (tmp_path / "build-output.fake").write_text(build_output)
    env = _env(tmp_path)
    env.update({"GITHUB_SHA": REVISION, "GITHUB_RUN_ID": "1", "GITHUB_OUTPUT": str(tmp_path / "github-output"),
                "DEPLOY_BUCKET": "bucket", "BUILD_BOX_TEMPLATE": "template", "BUILD_BOX_TYPES": "c7i.4xlarge",
                "FAKE_BUILD_OUTPUT": str(tmp_path / "build-output.fake")})
    work = tmp_path / "work"
    work.mkdir()
    proc = subprocess.run(["bash", str(ON_BOX_PATH)], env=env, cwd=work,
                          capture_output=True, text=True, timeout=60)
    output = (tmp_path / "github-output").read_text() if (tmp_path / "github-output").exists() else ""
    return proc, output


def test_the_deploy_workflow_accepts_the_manifest_the_build_prints(tmp_path):
    build_dir = tmp_path / "build"
    build_dir.mkdir()
    proc, _ = _build(build_dir)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    box_dir = tmp_path / "box"
    box_dir.mkdir()
    box, output = _on_box(box_dir, proc.stdout)
    assert box.returncode == 0, box.stdout + box.stderr
    assert _calls(box_dir, "python3") == ["scripts/build_identity.py"]
    manifest = _manifest(proc.stdout)
    body = "".join(f"{k}={v}\n" for k, v in manifest.items())
    assert output == f"manifest<<POLIS_MANIFEST_EOF\n{body}POLIS_MANIFEST_EOF\n"


@pytest.mark.parametrize("drop,extra", [("polis-api", None), (None, "unexpected=line")])
def test_the_deploy_workflow_refuses_any_other_manifest(tmp_path, drop, extra):
    build_dir = tmp_path / "build"
    build_dir.mkdir()
    proc, _ = _build(build_dir)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = _manifest(proc.stdout)
    manifest.pop(drop, None)
    lines = [f"{k}={v}" for k, v in manifest.items()] + ([extra] if extra else [])
    box_dir = tmp_path / "box"
    box_dir.mkdir()
    box, output = _on_box(box_dir, "\n".join(["POLIS_IMAGE_MANIFEST_BEGIN", *lines, "POLIS_IMAGE_MANIFEST_END", ""]))
    assert box.returncode != 0
    assert "::error::" in box.stdout + box.stderr
    assert output == ""
