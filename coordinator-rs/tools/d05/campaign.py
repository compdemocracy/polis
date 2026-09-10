#!/usr/bin/env python3
"""Prepare immutable attributed source, build, and run the public D05 profile."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/"coordinator-rs/ci"))
from source_workspace import prepare


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-local-changes", action="store_true")
    parser.add_argument("--local-file", action="append", default=[])
    args = parser.parse_args()
    for required in ("COMPOSE_PROJECT_NAME", "POLIS_RECOVERY_PG_PORT", "RECOVERY_PG_PORT"):
        if not os.environ.get(required):
            parser.error(required+" must identify the owned test project")
    if os.environ["POLIS_RECOVERY_PG_PORT"] != os.environ["RECOVERY_PG_PORT"]:
        parser.error("Postgres ports must agree")
    output = args.output.resolve()
    if output.is_relative_to(ROOT):
        parser.error("output must be outside the checkout")
    output.mkdir(parents=True, exist_ok=False)
    local = set(args.local_file)
    if args.allow_local_changes:
        local.update(str(p.relative_to(ROOT)) for p in Path(__file__).parent.iterdir() if p.is_file())
    report = prepare(ROOT, output/"source", allow_local=args.allow_local_changes, local_files=tuple(sorted(local)))
    (output/"source-reconciliation.json").write_text(json.dumps(report,indent=2)+"\n")
    with (output/"build.log").open("w") as log:
        subprocess.run(["cargo", "build", "--locked", "--features", "fault-injection", "--target-dir", "target/fault"],
                       cwd=output/"source/coordinator-rs", stdout=log, stderr=subprocess.STDOUT, check=True)
    with (output/"run.log").open("w") as log:
        subprocess.run([sys.executable, "-B", "coordinator-rs/tools/d05/run.py", "--output", str(output/"results")],
                       cwd=output/"source", stdout=log, stderr=subprocess.STDOUT, check=True)
    subprocess.run([sys.executable, "-B", str(output/"source/coordinator-rs/tools/d05/verify.py"),
                    str(output/"results"), "--controls"], check=True)


if __name__ == "__main__":
    main()
