#!/usr/bin/env python3
"""Check the selected fresh-image receipts and preserve them across restart."""
import collections
import hashlib
import json
import os
import pathlib
import re
import subprocess


# Observation-only retirement policy in polis_migrate::load/retired_absent.
# These are migration identities, not a count of the current release.
RETIRED = {"000004", "000005", "000007"}
ROOT = pathlib.Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "server/postgres/migrations"


def expected_receipts(directory):
    names = [line for line in (directory / "release.txt").read_text().splitlines()
             if line and not line.startswith("#")]
    assert names and len(names) == len(set(names)), "empty/duplicate release selection"
    assert all(re.fullmatch(r"[0-9]{6}_[A-Za-z0-9_]+\.sql", name) for name in names)
    return {
        name: {"status": "ADOPTED" if name[:6] in RETIRED else "APPLIED",
               "checksum": hashlib.sha256((directory / name).read_bytes()).hexdigest()}
        for name in names
    }


def assert_receipts(rows, expected):
    actual = {row["name"]: {"status": row["status"], "checksum": row["checksum"]}
              for row in rows}
    assert len(rows) == len(actual), "duplicate history names"
    assert actual == expected, f"fresh history differs from release: {actual!r} != {expected!r}"


def main():
    assert os.environ.get("COMPOSE_PROJECT_NAME", "").startswith("polis-migrate-test-")
    directory = pathlib.Path(__file__).resolve().parent
    compose = ["docker", "compose", "-f", str(directory / "compose.yml"),
               "-f", str(directory / "image.yml")]

    def run(*args):
        return subprocess.check_output(compose + list(args), text=True).strip()

    def query(sql):
        return run("exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
                   "-U", "postgres", "-d", "postgres", "-Atc", sql)

    def history():
        return [json.loads(line) for line in
                query("SELECT row_to_json(m) FROM migrations m ORDER BY name").splitlines()]

    expected = expected_receipts(MIGRATIONS)
    before = history()
    assert_receipts(before, expected)
    assert query("SELECT to_regclass('public.polis_coordinator_install') IS NULL") == "t"
    run("restart", "postgres")
    run("up", "-d", "--wait", "--wait-timeout", "120")
    assert history() == before, "restart changed migration receipts"
    assert run("exec", "-T", "-e",
               "DATABASE_URL=host=/var/run/postgresql user=postgres dbname=postgres sslmode=disable",
               "-e", "POLIS_MIGRATIONS_DIR=/migrations", "postgres", "polis-migrate", "check"
               ) == f"migration check: {len(expected)} ready"
    counts = dict(sorted(collections.Counter(row["status"] for row in before).items()))
    print(f"image proof: 4 checks PASS; {len(expected)} selected receipts; {counts}")


if __name__ == "__main__":
    main()
