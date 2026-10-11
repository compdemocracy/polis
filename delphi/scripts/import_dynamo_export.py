#!/usr/bin/env python3
"""Export local DynamoDB to codec/1; preview or enqueue an immutable Postgres import."""
import argparse
from contextlib import closing
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from polismath.delphi_storage import legacy_import as legacy


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export-local")
    export.add_argument("directory")
    export.add_argument("--endpoint", required=True)
    export.add_argument("--family", action="append", choices=sorted(legacy.FAMILIES), required=True)
    for command in ("preview", "enqueue"):
        action = sub.add_parser(command)
        action.add_argument("directory")
        action.add_argument("--zid", type=int, required=True)
        action.add_argument("--report-id", action="append", default=[])
        if command == "enqueue":
            action.add_argument("--env", required=True)
            action.add_argument("--scope", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "export-local":
            result = legacy.export_local(legacy.local_client(args.endpoint), args.directory, args.family)
        else:
            files = legacy.read_export(args.directory)
            output = legacy.import_output(files, args.zid, args.report_id)
            result = dict(source_sha256=output["source_sha256"], counts=output["counts"])
            if args.command == "enqueue":
                import psycopg2
                from job_graph_client import GraphClient
                if args.report_id:
                    with closing(psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=5)) as source:
                        source.set_session(readonly=True)
                        legacy.validate_report_mapping(source, args.zid, args.report_id)
                spec = legacy.build_spec(files, args.zid, args.report_id)
                # Includes code/runtime/config to avoid reusing a request key across versions.
                request_key = "legacy-" + legacy.digest(legacy.json_bytes(spec))
                with closing(psycopg2.connect(os.environ["QUEUE_DATABASE_URL"], connect_timeout=5)) as connection:
                    result.update(GraphClient(connection, args.env).admit(
                        args.zid, args.scope, request_key, spec))
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as exc:
        # Never print source content, report IDs, or a credential-bearing DB error.
        print(f"legacy import refused ({type(exc).__name__})", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
