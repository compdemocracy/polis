"""One host-port policy for disposable local and hosted test harnesses.

Explicit publications stay below the default ephemeral ranges on Linux and
macOS. Container-internal listeners and the OS-assigned sockets inside tests
are not host publications. Host-side PostgreSQL URLs use IPv4 loopback.
"""
import argparse
import json
import os
import re
import sys
from urllib.parse import urlsplit

MIN_PORT = 1
MAX_PORT = 32767
DEFAULT_WINDOW = (25930, 25939)


def port(value, label="host port"):
    text = str(value)
    if not re.fullmatch(r"[0-9]+", text) or not MIN_PORT <= int(text) <= MAX_PORT:
        raise ValueError(
            f"{label}: choose an explicit port in {MIN_PORT}..{MAX_PORT}; "
            "host publications must avoid Linux and macOS ephemeral ports"
        )
    return int(text)


def database_port(value, label="database port"):
    value = port(value, label)
    if value == 5432:
        raise ValueError(f"{label}: choose a disposable database port other than 5432")
    return value


def published(value, label="published port"):
    parts = str(value).split("-")
    if len(parts) not in (1, 2):
        raise ValueError(f"{label}: invalid published range")
    bounds = [port(part, label) for part in parts]
    if bounds[0] > bounds[-1]:
        raise ValueError(f"{label}: reversed published range")


def environment(environ, names):
    """Validate only named inputs consumed by the calling launcher."""
    for key in names:
        if key not in environ:
            continue  # The launcher supplies defaults or requires its inputs.
        value = environ[key]
        if key.endswith("_PORT") or key in ("P027_PORT_MIN", "P027_PORT_MAX"):
            check = database_port if key.endswith("_PG_PORT") else port
            check(value, key)
        elif "DATABASE_URL" in key or key.endswith("PG_ADMIN_URL"):
            url = urlsplit(value)
            if url.scheme in ("postgres", "postgresql"):
                if url.hostname in ("localhost", "::1"):
                    raise ValueError(f"{key}: use 127.0.0.1 for a host-side test database")
                if url.hostname == "127.0.0.1":
                    database_port(5432 if url.port is None else url.port, key)
        else:
            raise ValueError(f"{key}: not a host-port or database input")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("env", "ports", "database-ports", "compose"))
    parser.add_argument("values", nargs="*")
    args = parser.parse_args()
    if args.mode == "env":
        if not args.values:
            parser.error("env requires explicit variable names")
        environment(os.environ, args.values)
    elif args.mode in ("ports", "database-ports"):
        check = database_port if args.mode == "database-ports" else port
        for value in args.values:
            check(value)
    else:
        for name, service in json.load(sys.stdin)["services"].items():
            for item in service.get("ports", []):
                published(item.get("published", 0), name)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError) as error:
        sys.exit(str(error))
