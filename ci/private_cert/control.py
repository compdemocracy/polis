"""Canonical byte helpers shared by the certification image tooling."""
import hashlib
import json


def encoded(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha(value: object) -> str:
    return hashlib.sha256(encoded(value)).hexdigest()
