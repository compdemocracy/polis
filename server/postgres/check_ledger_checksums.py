#!/usr/bin/env python3
"""Check the ledger self-checksum of every migration from 000025 on, and of
every operation file.

Rule (docs/migrations.md): each migration file numbered 000025 or later ends
(000023, the Delphi job table, and the held 000024 predate the ledger and
carry no marker; 000025 records what the catalog shows for them instead)
with an INSERT of its own public.schema_migrations row, on the one line that
carries the marker comment below. Each operation file in
server/postgres/operations/ (run by an operator, never by the runner) carries
the same marker on the INSERT that records it in public.vote_convention, with
its own file stem as the operation name. The checksum in that row is the sha256
of the file's bytes with exactly that line removed. This script recomputes it
for every such file in server/postgres/migrations/, its held/ directory and
server/postgres/operations/, and fails on a missing or duplicate marker, a row
naming another file, or a mismatch. No database is needed.

    python3 server/postgres/check_ledger_checksums.py
    python3 server/postgres/check_ledger_checksums.py --print <file>   # the checksum to write into <file>
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import sys

MARKER = b"-- ledger-" + b"self-checksum"
FIRST = 25
ROOT = Path(__file__).resolve().parent / "migrations"
OPERATIONS = Path(__file__).resolve().parent / "operations"
MIGRATION_ROW = re.compile(rb"INSERT INTO public\.schema_migrations \(name, checksum(?:, note)?\) VALUES \('([0-9a-z_]+)', '([0-9a-f]{64})'")
OPERATION_ROW = re.compile(rb"'([a-z0-9_]+)', '([0-9a-f]{64})'\);")


def ledger_checksum(raw: bytes) -> str:
    return hashlib.sha256(b"\n".join(line for line in raw.split(b"\n") if MARKER not in line)).hexdigest()


def check(path: Path) -> list[str]:
    raw = path.read_bytes()
    marked = [line for line in raw.split(b"\n") if MARKER in line]
    if len(marked) != 1:
        return [f"{path.name}: {len(marked)} ledger marker lines (exactly 1 required)"]
    operation = path.parent.name == "operations"
    row = (OPERATION_ROW if operation else MIGRATION_ROW).search(marked[0])
    if not row:
        what = "vote_convention INSERT naming this operation" if operation else "schema_migrations INSERT"
        return [f"{path.name}: the marker line is not this file's {what} with a 64-hex checksum"]
    problems = []
    if row.group(1).decode() != path.stem:
        problems.append(f"{path.name}: the ledger row names {row.group(1).decode()!r}, not {path.stem!r}")
    expected = ledger_checksum(raw)
    if row.group(2).decode() != expected:
        problems.append(f"{path.name}: ledger checksum {row.group(2).decode()} but the file hashes to {expected}")
    return problems


def files() -> list[Path]:
    migrations = sorted(p for d in (ROOT, ROOT / "held") if d.is_dir() for p in d.glob("[0-9]" * 6 + "_*.sql")
                        if int(p.name[:6]) >= FIRST)
    operations = sorted(OPERATIONS.glob("*.sql")) if OPERATIONS.is_dir() else []
    return migrations + operations


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--print"] and len(argv) == 2:
        print(ledger_checksum(Path(argv[1]).read_bytes()))
        return 0
    found = files()
    problems = [problem for path in found for problem in check(path)]
    for path in found:
        print(f"{'FAIL' if any(p.startswith(path.name + ':') for p in problems) else 'ok  '} "
              f"{path.relative_to(ROOT.parent)} {ledger_checksum(path.read_bytes())}")
    for problem in problems:
        print(problem, file=sys.stderr)
    if not found:
        print("no ledger-bearing migrations found", file=sys.stderr)
        return 1
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
