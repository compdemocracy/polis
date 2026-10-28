"""Read-only checks and source/image pins for the isolated treevite recorder."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from isolation import isolated_environment

env = isolated_environment(os.environ)
root = Path(__file__).resolve().parents[3]
project = env["COMPOSE_PROJECT_NAME"]


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True)


ids = docker("ps", "-q", "--filter", f"label=com.docker.compose.project={project}").split()
assert len(ids) == 6, "six running services required"
containers = json.loads(docker("inspect", *ids))
networks = {n["NetworkID"] for c in containers for n in c["NetworkSettings"]["Networks"].values()}
assert len(networks) == 1
network = json.loads(docker("network", "inspect", *networks))[0]
assert network["Internal"] and network["Labels"]["com.docker.compose.project"] == project
for c in containers:
    assert not c["HostConfig"]["Privileged"] and not c["HostConfig"].get("CapAdd")
    if c["Config"]["Labels"]["com.docker.compose.service"] == "server":
        mounts = {m["Destination"]: m for m in c["Mounts"]}
        for name in ["/app/src", "/app/app.ts", "/app/characterization"]:
            assert not mounts[name]["RW"]
files = sorted(set(
    list((root / "server/src").rglob("*.ts"))
    + list((root / "server/postgres/migrations").glob("*.sql"))
    + list((root / "server/characterization").glob("*.cjs"))
    + list((root / "server/characterization/treevite").glob("*.*"))
    + [root / "server/app.ts", root / "server/package-lock.json", root / "VERSION"]
))
result = {
    "source_commit": env["P027_SOURCE_COMMIT"],
    "internal_network": True,
    "services": {c["Config"]["Labels"]["com.docker.compose.service"]: c["Image"] for c in containers},
    "files": {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()},
}
(root / "server/characterization/artifacts/treevite-provenance.json").write_text(json.dumps(result, indent=2) + "\n")
