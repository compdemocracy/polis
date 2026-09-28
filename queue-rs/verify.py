"""Exact local case inventory, not a math/retention/transfer admission."""
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent


def verify(path):
    expected = json.loads((ROOT / "case-inventory.json").read_text())
    cases = ET.parse(path).getroot().findall(".//testcase")
    identities = [c.attrib["classname"].replace(".", "/") + ".py::" + c.attrib["name"] for c in cases]
    if sorted(identities) != expected or len(set(identities)) != len(cases):
        raise ValueError("queue_case_inventory_mismatch")
    if any(c.find(tag) is not None for c in cases for tag in ("failure", "error", "skipped")):
        raise ValueError("queue_case_not_passed")
    return {"schema": "polis-queue-local-cases/1", "tests": len(cases),
        "failures": 0, "errors": 0, "skips": 0, "local_cases": "PASS",
        "full_D04": "NOT_ADMITTED", "math_queue_admission": "NOT_IMPLEMENTED",
        "inventory_sha256": hashlib.sha256((ROOT / "case-inventory.json").read_bytes()).hexdigest(),
        "junit_sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}


if __name__ == "__main__":
    print(json.dumps(verify(sys.argv[1]), indent=2, sort_keys=True))
