#!/usr/bin/env python3
"""Offline receipt completeness and tamper checks; no database or cloud access."""
import argparse
import copy
import hashlib
import json
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(receipt, inventory):
    require(receipt["schema"] == "polis-d05-public/1" and receipt["status"] == "PASS", "not a completed D05 receipt")
    require(receipt["full_contract_gate"] == "FAIL", "public fixture evidence is not full admission")
    require([c["name"] for c in receipt["cases"]] == inventory["cases"], "missing, duplicate or reordered case")
    require(all(c["passed"] is True for c in receipt["cases"]), "failed case")
    require(set(receipt["remaining_resources"]) == {"container", "network", "volume"}
            and not any(receipt["remaining_resources"].values()), "cleanup incomplete")
    require(len(receipt["migrations"]) == 21 and len(receipt["transition_receipts"]) == 12, "incomplete schema or transition coverage")
    require(bool(receipt["source_sha256"]) and bool(receipt["artifact_sha256"]), "missing byte attribution")
    require(all(value.startswith("sha256:") for value in receipt["images"].values()), "images must be content addressed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--controls", action="store_true")
    args = parser.parse_args()
    inventory = json.loads(Path(__file__).with_name("inventory.json").read_text())
    receipt = json.loads((args.directory/"receipt.json").read_text())
    validate(receipt, inventory)
    for name, expected in receipt["artifact_sha256"].items():
        path = args.directory/name
        require(path.resolve().is_relative_to(args.directory.resolve()) and not path.is_symlink(), "invalid artifact path")
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, "artifact drift: "+name)
    controls = 0
    if args.controls:
        mutations = [lambda r:r["cases"].pop(), lambda r:r["cases"].append(r["cases"][0]),
                     lambda r:r["cases"][0].update(passed=False),
                     lambda r:r["remaining_resources"]["container"].append("unexpected"),
                     lambda r:r.update(status="FAIL")]
        for mutate in mutations:
            broken = copy.deepcopy(receipt)
            mutate(broken)
            try:
                validate(broken, inventory)
            except ValueError:
                controls += 1
            else:
                raise AssertionError("missing-evidence control was accepted")
    print(json.dumps({"cases":len(receipt["cases"]), "failed":0, "skipped":0,
                      "receipt_controls":controls, "status":"PASS", "full_contract_gate":"FAIL"}))


if __name__ == "__main__":
    main()
