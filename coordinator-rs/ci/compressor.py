"""Observe the actual Node executable; never learn replay admission from output."""
import hashlib
import json
from pathlib import Path
import subprocess

FIELDS = ("node", "zlib", "platform", "arch", "executable_sha256")


def observe_node():
    row = json.loads(subprocess.check_output(["node", "-e", """
console.log(JSON.stringify({node:process.version,zlib:process.versions.zlib,
 platform:process.platform,arch:process.arch,executable:process.execPath}));
"""], text=True))
    executable = Path(row["executable"]).resolve(strict=True)
    row["executable"] = str(executable)
    row["executable_sha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    return row


def validate_compressor(observed, expected):
    if (not isinstance(expected, dict) or set(expected) != set(FIELDS)
            or not isinstance(observed, dict)
            or any(observed.get(field) != expected[field] for field in FIELDS)):
        raise ValueError("REPLAY_COMPRESSOR_UNADMITTED: reviewed Node build required")


def admit_node(runtime, path):
    registry = json.loads(Path(path).read_text())
    matches = [pin for pin in registry["pins"] if
               (pin["system"], pin["machine"], pin["forced_kernel"]) ==
               (runtime["system"], runtime["machine"], runtime["forced_kernel"])]
    if len(matches) != 1:
        raise ValueError("REPLAY_PLATFORM_UNADMITTED: compressor platform")
    if "compressor" in matches[0]:
        validate_compressor(runtime.get("compressor"), matches[0]["compressor"])
