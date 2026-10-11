#!/usr/bin/env python3
"""Print a PRIVATE per-conversation dry-run report; there is no apply option."""
import argparse
from contextlib import closing
import fcntl
import os
from pathlib import Path
import sqlite3
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from polismath.delphi_storage import production_import as imp
from polismath.delphi_storage import import_report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', required=True)
    parser.add_argument('--local-endpoint', help='tests only: explicit loopback DynamoDB Local')
    parser.add_argument('--allow-missing', action='append', choices=sorted(imp.codec.FAMILIES), default=[])
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        scratch = Path('/import')
        if scratch.is_symlink() or not scratch.is_dir():
            raise ValueError('private import mount required')
        with open(scratch / '.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            attempt = scratch / ('report-' + uuid.uuid4().hex)
            attempt.mkdir(mode=0o700)
            if not args.local_endpoint:
                # This launcher deliberately uses the existing box's instance role.
                for name in ('AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ACCESS_KEY_ID',
                             'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE',
                             'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
                             'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_EC2_METADATA_SERVICE_ENDPOINT'):
                    os.environ.pop(name, None)
                os.environ['AWS_SHARED_CREDENTIALS_FILE'] = '/nonexistent'
                os.environ['AWS_CONFIG_FILE'] = '/nonexistent'
                os.environ['AWS_EC2_METADATA_DISABLED'] = 'false'
            source = imp.source_client(args.region, args.local_endpoint)
            with closing(import_report.connect_existing()) as conn:
                conversations, reports = imp.mapping(conn)
            first = imp.census(source, attempt/'first.sqlite', conversations, reports, args.allow_missing)
            second = imp.census(source, attempt/'second.sqlite', conversations, reports, args.allow_missing)
            if first != second:
                raise ValueError('source changed between census passes')
            with closing(sqlite3.connect(attempt/'first.sqlite')) as db:
                zids = [row[0] for row in db.execute('SELECT DISTINCT zid FROM rows WHERE zid IS NOT NULL')]
            with closing(import_report.connect_existing()) as conn:
                if imp.mapping(conn) != (conversations, reports):
                    raise ValueError('source identity mapping changed')
                details = import_report.metadata(conn, zids)
            # Same size/binding validation as the reviewed importer, no admission.
            imp.materialize(attempt/'first.sqlite', attempt/'snapshot', first)
            raw = import_report.encode(import_report.report(attempt/'first.sqlite', details, first))
            imp.write_private(attempt/'report.jsonl', raw)
            sys.stdout.buffer.write(raw)
        return 0
    except Exception as exc:
        print('import dry-run refused (' + type(exc).__name__ + ')', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
