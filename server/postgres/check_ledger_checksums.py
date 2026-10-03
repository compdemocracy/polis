#!/usr/bin/env python3
"""Check the ledger self-checksum of every migration from 000023 on.

Rule (docs/migrations.md): each migration file numbered 000023 or later ends
with an INSERT of its own public.schema_migrations row, on the one line that
carries the marker comment below. The checksum in that row is the sha256 of
the file's bytes with exactly that line removed. This script recomputes it
for every such file in server/postgres/migrations/ and its held/ directory,
and fails on a missing or duplicate marker, a row naming another file, or a
mismatch. No database is needed.

    python3 server/postgres/check_ledger_checksums.py
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import sys

MARKER = b"-- ledger-" + b"self-checksum"
FIRST = 23
ROOT = Path(__file__).resolve().parent / "migrations"


def ledger_checksum(raw: bytes) -> str:
    return hashlib.sha256(b"\n".join(line for line in raw.split(b"\n") if MARKER not in line)).hexdigest()


def check(path: Path) -> list[str]:
    raw = path.read_bytes()
    marked = [line for line in raw.split(b"\n") if MARKER in line]
    if len(marked) != 1:
        return [f"{path.name}: {len(marked)} ledger marker lines (exactly 1 required)"]
    row = re.search(rb"INSERT INTO public\.schema_migrations \(name, checksum(?:, note)?\) VALUES \('([0-9a-z_]+)', '([0-9a-f]{64})'", marked[0])
    if not row:
        return [f"{path.name}: the marker line is not this file's schema_migrations INSERT with a 64-hex checksum"]
    problems = []
    if row.group(1).decode() != path.stem:
        problems.append(f"{path.name}: the ledger row names {row.group(1).decode()!r}, not {path.stem!r}")
    expected = ledger_checksum(raw)
    if row.group(2).decode() != expected:
        problems.append(f"{path.name}: ledger checksum {row.group(2).decode()} but the file hashes to {expected}")
    return problems


def main() -> int:
    files = sorted(p for d in (ROOT, ROOT / "held") if d.is_dir() for p in d.glob("[0-9]" * 6 + "_*.sql")
                   if int(p.name[:6]) >= FIRST)
    problems = [problem for path in files for problem in check(path)]
    for path in files:
        print(f"{'FAIL' if any(p.startswith(path.name + ':') for p in problems) else 'ok  '} {path.relative_to(ROOT)} {ledger_checksum(path.read_bytes())}")
    for problem in problems:
        print(problem, file=sys.stderr)
    if not files:
        print("no ledger-bearing migrations found", file=sys.stderr)
        return 1
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
