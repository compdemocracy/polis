"""Run the required public candidate campaign and retain a separate receipt.

No closure recorder is called. Reviewed evidence and prior local artifacts are
restored even on failure; fresh run output is retained in a new output directory.
Only this invocation's disposable Compose project is started or removed.
"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import uuid

from verify import comparisons, jest_cases, python_cases, require, rust_cases, sha, source_pins, stage_audit
from source_workspace import prepare, regular
from replay_pins import kernel_environment, select_pin, validate_kernel

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / "coordinator-rs/ci"
ART = ROOT / "coordinator-rs/artifacts"
EVIDENCE = ROOT / "coordinator-rs/evidence"
CARGO = {
    "cargo-default": ["test", "--locked"],
    "cargo-fault": ["test", "--locked", "--features", "fault-injection"],
    "clippy-default": ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
    "clippy-fault": ["clippy", "--locked", "--all-targets", "--features", "fault-injection", "--", "-D", "warnings"],
    "release": ["build", "--locked", "--release"],
    "fault-build": ["build", "--locked", "--features", "fault-injection", "--target-dir", "target/fault"],
}
D4 = ("d4-node-reader.json", "d4-node-reader-empty.json", "d4-bundle-reader.json", "d4-generation-zero.json")


def inputs():
    paths = set()
    for directory in ("coordinator-rs/src", "coordinator-rs/tests", "coordinator-rs/schemas",
                      "coordinator-rs/tools", "coordinator-rs/ci", "delphi/polismath",
                      "delphi/tests/coordinator", "server/src", "server/postgres/migrations"):
        paths.update(p for p in (ROOT / directory).rglob("*") if p.is_file() and
                     "__pycache__" not in p.parts and p.suffix not in (".pyc", ".log"))
    for name in ("coordinator-rs/Cargo.toml", "coordinator-rs/Cargo.lock", "coordinator-rs/build.rs",
                 "coordinator-rs/rust-toolchain.toml", "coordinator-rs/migration.sql",
                 "coordinator-rs/evidence/python-requirements.txt", "server/package.json",
                 "server/package-lock.json", "server/tsconfig.json", ".github/workflows/coordinator-ci.yml"):
        paths.add(ROOT / name)
    inv = json.loads((CI / "inventory-v2.json").read_text())
    paths.update(ROOT / "server" / p for p, _ in inv["jest_cases"])
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(paths)}


def main():
    global ROOT, CI, ART, EVIDENCE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="new directory for this invocation")
    parser.add_argument("--allow-local-changes", action="store_true", help="local review only; forbidden in Actions")
    parser.add_argument("--local-file", action="append", default=[], help="explicit untracked local review source")
    parser.add_argument("--local-remove", action="append", default=[], help="explicit deleted tracked local review source")
    args = parser.parse_args()
    output = args.output.resolve()
    require(not output.exists() and not output.is_relative_to(ROOT), "output must be new and outside checkout")
    project = os.environ.get("COMPOSE_PROJECT_NAME", "")
    port = os.environ.get("POLIS_RECOVERY_PG_PORT", "")
    require(re.fullmatch(r"[a-z][a-z0-9-]{7,62}", project), "choose a unique COMPOSE_PROJECT_NAME")
    require(port.isdigit() and 55432 <= int(port) <= 65535, "choose POLIS_RECOVERY_PG_PORT >= 55432")
    require(os.environ.get("RECOVERY_PG_PORT") == port, "both recovery port variables must match")
    require(not os.environ.get("P026_NODE_READER_OPTIONAL"), "Node opt-out is forbidden")
    require(not os.environ.get("PYTEST_ADDOPTS"), "PYTEST_ADDOPTS can alter the required inventory")
    require(not os.environ.get("PYTHONOPTIMIZE"), "optimized Python disables historical assertions")
    require((ROOT / "server/node_modules").is_dir(), "provision server/package-lock.json with npm ci")
    # Refuse reuse even of stopped containers, networks or volumes.
    for resource, args_list in (("container", ["ps", "-aq"]), ("network", ["network", "ls", "-q"]),
                                ("volume", ["volume", "ls", "-q"])):
        found = subprocess.check_output(["docker", *args_list, "--filter", f"label=com.docker.compose.project={project}"], text=True)
        require(not found.strip(), f"project already owns {resource}s; select another project")
    output.mkdir(parents=True)
    original_root = ROOT
    workspace = output / "source-workspace"
    source_report = None
    inventory = json.loads((CI / "inventory-v2.json").read_text())
    baseline = {}
    receipt = {"schema": "polis-coordinator-ci-receipt/1", "run_id": uuid.uuid4().hex,
               "candidate_gate": "FAIL", "full_contract_gate": "FAIL", "hosted_stack_ci": "NOT_EVALUATED",
               "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "github_run_id": os.environ.get("GITHUB_RUN_ID"),
               "source_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
               "platform": platform.platform(), "python": platform.python_version(),
               "compose_project": project, "postgres_port": int(port), "commands": []}
    parked = output / "prior-artifacts"
    compose = ["docker", "compose", "-f", str(CI / "compose.yml")]
    env = dict(os.environ, POLIS_COORDINATOR_CHECKOUT_DIR=str(ROOT), PYTHONDONTWRITEBYTECODE="1",
               PYTHONPATH=os.pathsep.join((str(CI), str(ROOT / "delphi"))),
               PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1",
               POLIS_TEST_POSTGRES_URL=f"postgresql://postgres@127.0.0.1:{port}/p026")
    env = kernel_environment(env, platform.system(), platform.machine())
    receipt["requested_kernel"] = env.get("OPENBLAS_CORETYPE", "not-forced")
    changed_artifacts = False
    started = False

    def run(name, argv, cwd=None, expected=0, command_env=None):
        cwd = ROOT if cwd is None else cwd
        command_env = env if command_env is None else command_env
        print(f"Running {name}", flush=True)
        start = time.time()
        with (output / f"{name}.log").open("w") as log:
            result = subprocess.run(argv, cwd=cwd, env=command_env, stdout=log, stderr=subprocess.STDOUT)
        receipt["commands"].append({"name": name, "argv": list(map(str, argv)),
                                    "cwd": str(cwd.relative_to(ROOT)), "exit": result.returncode,
                                    "expected_exit": expected, "elapsed_seconds": time.time() - start})
        require(result.returncode == expected, f"{name}: exit {result.returncode}, expected {expected}; see {name}.log")
        return (output / f"{name}.log").read_text()

    try:
        source_report = prepare(original_root, workspace, allow_local=args.allow_local_changes,
                                local_files=tuple(args.local_file), local_removed=tuple(args.local_remove))
        (output / "source-reconciliation.json").write_text(json.dumps(source_report, indent=2) + "\n")
        ROOT, CI = workspace, workspace / "coordinator-rs/ci"
        ART, EVIDENCE = ROOT / "coordinator-rs/artifacts", ROOT / "coordinator-rs/evidence"
        baseline = {p.name: p.read_bytes() for p in EVIDENCE.iterdir() if p.is_file()}
        # Retain the historical receipts and exact transformed metadata separately.
        for name in source_report["metadata_transforms"]:
            for label, base in (("historical-metadata", original_root), ("campaign-metadata", ROOT)):
                target = output / label / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(base / name, target)
        compose = ["docker", "compose", "-f", str(CI / "compose.yml")]
        env.update(POLIS_COORDINATOR_CHECKOUT_DIR=str(ROOT),
                   PYTHONPATH=os.pathsep.join((str(CI), str(ROOT / "delphi"))))
        receipt["source_reconciliation_sha256"] = sha(output / "source-reconciliation.json")
        receipt["historical_pin_drift"] = source_report["drift"]
        receipt["local_source_changes"] = source_report["local_changes"]
        receipt["source_pins"] = source_pins(ROOT)
        receipt["source_sha256"] = inputs()
        receipt["historical_evidence_sha256"] = {p: sha(EVIDENCE / p) for p in baseline}
        receipt["packages"] = {line.split("==")[0]: importlib.metadata.version(line.split("==")[0])
                               for line in (EVIDENCE / "python-requirements.txt").read_text().splitlines() if "==" in line}
        for line in (EVIDENCE / "python-requirements.txt").read_text().splitlines():
            if "==" in line:
                name, version = line.split("==")
                require(receipt["packages"][name] == version, f"Python dependency mismatch: {name}")
        receipt["node"] = subprocess.check_output(["node", "--version"], text=True).strip()
        require(receipt["node"].startswith("v24."), "Node 24 required")
        receipt["replay_runtime"] = json.loads(subprocess.check_output(
            [sys.executable, "-B", str(CI / "replay_pins.py")], env=env, text=True))
        validate_kernel(receipt["replay_runtime"])
        receipt["kernel_validation"] = "PASS"
        receipt["rustc"] = run("rustc", ["rustc", "--version", "--verbose"], ROOT / "coordinator-rs")
        run("controls", [sys.executable, "-m", "pytest", "-o", "addopts=", "-p", "no:cacheprovider",
                         "--confcutdir=coordinator-rs/ci/tests", "coordinator-rs/ci/tests", "-q",
                         f"--basetemp={output / 'control-artifacts'}",
                         f"--junitxml={output / 'controls.xml'}"])
        receipt["control_tests"] = python_cases(output / "controls.xml", {"python_junit": inventory["control_junit"]})
        if ART.exists():
            ART.rename(parked)
        ART.mkdir()
        changed_artifacts = True
        for name in D4:
            (EVIDENCE / name).unlink()
        receipt["rust_tests"] = {}
        for name, argv in CARGO.items():
            log = run(name, ["cargo", *argv], ROOT / "coordinator-rs")
            (ART / f"s1-{name}.log").write_text(log)
            (ART / f"s1-{name}.status").write_text("0\n")
            if name.startswith("cargo-"):
                receipt["rust_tests"][name] = rust_cases(log, inventory)
        receipt["binary_sha256"] = {str(p.relative_to(ROOT)): sha(p) for p in (
            ROOT / "coordinator-rs/target/release/polis-coordinator",
            ROOT / "coordinator-rs/target/fault/debug/polis-coordinator")}
        started = True
        run("compose-up", [*compose, "up", "-d", "--wait"])
        # Bind the actual local runtime, not an inferred tag.
        receipt["postgres_container"] = subprocess.check_output([*compose, "ps", "-q", "postgres"], env=env, text=True).strip()
        receipt["postgres_image"] = subprocess.check_output(["docker", "inspect", "--format", "{{.Image}}", receipt["postgres_container"]], text=True).strip()
        import psycopg2
        conn = psycopg2.connect(env["POLIS_TEST_POSTGRES_URL"])
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("SELECT version()")
            receipt["postgres_version"] = cur.fetchone()[0]
            cur.execute("CREATE DATABASE d02_bundle")
        conn.close()
        bundle_url = f"postgresql://postgres@127.0.0.1:{port}/d02_bundle"
        conn = psycopg2.connect(bundle_url)
        with conn:
            with conn.cursor() as cur:
                for path in sorted((ROOT / "server/postgres/migrations").glob("*.sql")):
                    cur.execute(path.read_text())
        conn.close()
        log = run("pytest", [sys.executable, "-m", "pytest", "-o", "addopts=", "-p", "no:cacheprovider",
                             "-p", "required_inventory", "--confcutdir=delphi/tests/coordinator",
                             "delphi/tests/coordinator", "-q", f"--junitxml={ART / 's1-pytest.xml'}"])
        (ART / "s1-pytest.log").write_text(log)
        receipt["python_tests"] = python_cases(ART / "s1-pytest.xml", inventory)
        jest_env = dict(env, DATABASE_URL=bundle_url, NODE_ENV="test", AWS_REGION="us-east-1",
                        AWS_ACCESS_KEY_ID="public-fixture", AWS_SECRET_ACCESS_KEY="public-fixture", AWS_EC2_METADATA_DISABLED="true",
                        DYNAMODB_ENDPOINT="http://127.0.0.1:1", AWS_S3_ENDPOINT="http://127.0.0.1:1",
                        SES_ENDPOINT="http://127.0.0.1:1", DD_TRACE_ENABLED="false")
        files = sorted({p for p, _ in inventory["jest_cases"]})
        run("jest", ["./node_modules/.bin/jest", "--config", str(CI / "jest.config.cjs"),
                     "--runInBand", "--runTestsByPath", *files, "--json", f"--outputFile={output / 'jest.json'}"],
            ROOT / "server", command_env=jest_env)
        receipt["jest_tests"] = jest_cases(json.loads((output / "jest.json").read_text()), inventory)
        run("stage-audit", [sys.executable, "delphi/tests/coordinator/audit_stages.py"], expected=1)
        receipt["stages"] = stage_audit(json.loads((EVIDENCE / "stage-inventory.json").read_text()), inventory)
        require(source_pins(ROOT) == receipt["source_pins"], "reviewed sources changed during campaign")
        require(inputs() == receipt["source_sha256"], "campaign inputs changed during execution")
        require(all(sha(regular(original_root, p)) == expected for p, expected in
                    source_report["source_sha256"].items()), "original source changed during campaign")
        require(all(not (original_root / p).exists() and not (original_root / p).is_symlink()
                    for p in source_report["local_removed"]), "removed source reappeared during campaign")
        # Full fresh evidence is retained before historical key admission. A
        # new forced-kernel measurement still FAILS until independently pinned;
        # this is not a discovery/fallback admission or an optional comparator.
        receipt["replay_pin"] = select_pin(receipt["replay_runtime"], CI / "replay-pins.json")
        receipt["comparisons"] = comparisons(ART, EVIDENCE, baseline, receipt["replay_pin"])
        receipt["candidate_gate"] = "PASS"
    except Exception as error:
        receipt["error"] = str(error)
        print(str(error), file=sys.stderr)
    finally:
        if started:
            try:
                run("compose-down", [*compose, "down", "-v"])
                for kind, argv in (("containers", ["ps", "-aq"]), ("networks", ["network", "ls", "-q"]),
                                   ("volumes", ["volume", "ls", "-q"])):
                    remaining = subprocess.check_output(["docker", *argv, "--filter", f"label=com.docker.compose.project={project}"], text=True)
                    require(not remaining.strip(), f"owned {kind} remain")
                receipt["cleanup"] = "zero owned containers/networks/volumes"
            except Exception as error:
                receipt["cleanup_error"] = str(error)
                receipt["candidate_gate"] = "FAIL"
        if changed_artifacts:
            shutil.copytree(EVIDENCE, output / "fresh-evidence")
            ART.rename(output / "artifacts")
            if parked.exists():
                parked.rename(ART)
        for name, data in baseline.items():
            (EVIDENCE / name).write_bytes(data)
        receipt["evidence_restored"] = all((EVIDENCE / name).read_bytes() == data for name, data in baseline.items())
        if workspace.exists():
            shutil.rmtree(workspace)
        receipt["source_workspace_removed"] = not workspace.exists()
        receipt["artifact_sha256"] = {str(p.relative_to(output)): sha(p) for p in sorted(output.rglob("*")) if p.is_file()}
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: receipt[k] for k in ("candidate_gate", "full_contract_gate", "hosted_stack_ci")}))
    return 0 if receipt["candidate_gate"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
