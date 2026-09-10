#!/usr/bin/env python3
"""Verify a boundary receipt, explicitly refusing D07 admission claims."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re

from boundary import CASES, IMAGES, SQL, SQL_SHA256


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(r):
    require(r["schema"] == "polis-d07-boundary/1" and r["status"] == "BLOCKED", "not a boundary receipt")
    require(r["full_contract_gate"] == "FAIL" and r["rehearsal"] == "NOT_RUN"
            and r["capacity"] == "NOT_MEASURED", "unearned admission claim")
    require(r["blocker"] == "D06_READ_ONLY_OBSERVER_AUTHORITY", "missing boundary")
    require(tuple(c["name"] for c in r["checks"]) == CASES
            and all(c["passed"] is True for c in r["checks"]), "incomplete controls")
    require(set(r["remaining_resources"]) == {"container", "network", "volume"}
            and not any(r["remaining_resources"].values()), "incomplete cleanup")
    require(r["source_sha256"][SQL] == SQL_SHA256 and len(r["migrations"]) == 21
            and r["migrations"][Path(SQL).name] == SQL_SHA256, "wrong schema")
    require(set(r["public_inputs"]) == {"vw", "biodiversity"}, "wrong input scope")
    for slug, count in (("vw",4683),("biodiversity",29802)):
        row = r["public_inputs"][slug]
        require(row["vote_events"] == count and row["execution"] == "NOT_RUN"
                and re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), "wrong census/claim")
    require(set(r["images"]) == set(IMAGES), "incomplete images")
    for tag, image in r["images"].items():
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", image["id"])
                and image["execution"] == ("DB_ONLY" if tag == IMAGES[0] else "NOT_RUN"), "image attribution")
    require(r["transition"][:3] == ["legacy_reticked",80,81], "transition mismatch")
    require(set(r["artifact_sha256"]) == {"compose.json", "commands.log"}, "missing artifacts")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("directory", type=Path)
    p.add_argument("--controls", action="store_true")
    args = p.parse_args()
    r = json.loads((args.directory / "receipt.json").read_text())
    validate(r)
    for name, expected in r["artifact_sha256"].items():
        path = args.directory / name
        require(not path.is_symlink() and path.resolve().is_relative_to(args.directory.resolve()), "artifact path")
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, "artifact drift")
    count = 0
    if args.controls:
        mutations = (
            lambda r:r.update(status="PASS"), lambda r:r.update(full_contract_gate="PASS"),
            lambda r:r.update(rehearsal="PASS"), lambda r:r["checks"].pop(),
            lambda r:r["checks"].append(r["checks"][0]),
            lambda r:r["checks"][0].update(passed=False),
            lambda r:r["remaining_resources"]["container"].append("leftover"),
            lambda r:r["public_inputs"]["vw"].update(vote_events=24),
            lambda r:r["images"].pop(IMAGES[-1]),
            lambda r:r["images"][IMAGES[-1]].update(execution="PASS"),
            lambda r:r["source_sha256"].update({SQL:"0"*64}),
            lambda r:r["artifact_sha256"].clear(),
        )
        for mutate in mutations:
            broken = copy.deepcopy(r)
            mutate(broken)
            try:
                validate(broken)
            except ValueError:
                count += 1
            else:
                raise AssertionError("bad receipt accepted")
    print(json.dumps({"boundary_checks":len(CASES), "receipt_controls":count,
                      "verification":"PASS", "D07":"BLOCKED", "rehearsal":"NOT_RUN"}))


if __name__ == "__main__":
    main()
