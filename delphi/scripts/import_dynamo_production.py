#!/usr/bin/env python3
"""One-shot DynamoDB census/import. Defaults to dry-run; stdout is aggregates only."""
import argparse
import fcntl
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from polismath.delphi_storage import production_import as imp
from polismath.delphi_storage import legacy_import as legacy
from polismath.delphi_storage.scan_pacing import ScanPaused


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--region', required=True)
    p.add_argument('--local-endpoint', help='test only: explicit loopback DynamoDB Local endpoint')
    p.add_argument('--apply', action='store_true')
    p.add_argument('--source-frozen', action='store_true', help='operator confirms all relevant source writers are stopped')
    p.add_argument('--allow-missing', action='append', choices=sorted(imp.codec.FAMILIES), default=[])
    p.add_argument('--environment', default='import-dry-run')
    p.add_argument('--scope', default='delphi')
    p.add_argument('--wait-seconds', type=int, default=3600)
    imp.pacing_arguments(p)
    args = p.parse_args(argv)
    os.umask(0o077)
    try:
        if args.apply and not args.source_frozen:
            raise ValueError('apply requires frozen source')
        if args.wait_seconds < 1:
            raise ValueError('positive wait bound required')
        # The container's only persistent writable mount; retain it inside AWS.
        scratch = Path('/import')
        if scratch.is_symlink() or not scratch.is_dir():
            raise ValueError('private import mount required')
        lock = open(scratch / '.lock', 'a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not args.local_endpoint and os.environ.get('POLIS_JOBS_TRANSPORT', 'tls') != 'tls':
            raise ValueError('production transport must verify TLS')
        pacer = imp.pacer_from(args)
        attempt = imp.attempt_directory(scratch, 'census-', args.resume)
        source = imp.source_client(args.region, args.local_endpoint)
        import psycopg2
        with closing(imp.connect_readonly_source(local=bool(args.local_endpoint))) as conn:
            conversations, reports = imp.mapping(conn)
        first = imp.census(source, attempt/'first.sqlite', conversations, reports, args.allow_missing,
                           pacer=pacer, resume=args.resume)
        second = imp.census(source, attempt/'second.sqlite', conversations, reports, args.allow_missing,
                            pacer=pacer, resume=args.resume)
        if first != second:
            raise ValueError('source changed between census passes')
        with closing(imp.connect_readonly_source(local=bool(args.local_endpoint))) as conn:
            if imp.mapping(conn) != (conversations, reports):
                raise ValueError('source identity mapping changed')
        root = attempt / 'snapshot'
        bundles = imp.materialize(attempt/'first.sqlite', root, first)
        imported = 0
        if args.apply:
            imp.SNAPSHOTS.mkdir(mode=0o700, exist_ok=True)
            for bundle in bundles:
                source_dir, destination = root/bundle['digest'], imp.SNAPSHOTS/bundle['digest']
                if destination.exists():
                    # Bind every existing byte, not just a preexisting manifest.
                    for original in source_dir.iterdir():
                        if original.is_symlink() or legacy.read_regular_file(destination/original.name, imp.FAMILY_LIMIT) != original.read_bytes():
                            raise ValueError('existing snapshot differs')
                else:
                    shutil.copytree(source_dir, destination)
            imported = imp.import_all(bundles, reports, args.environment, args.wait_seconds, args.scope)
        result = dict(mode='applied-unpublished' if args.apply else 'dry-run',
                      source_sha256=first['source_sha256'], counts=first['counts'],
                      missing_tables=len(first['missing']), conversations=len(bundles),
                      large_conversations=sum(b['bytes'] > legacy.MAX_BYTES for b in bundles),
                      canonical_result_bytes=sum(b['bytes'] for b in bundles), completed_graphs=imported)
        imp.finish_attempt(attempt)
        print(json.dumps(result, sort_keys=True))
        return 0
    except ScanPaused:
        print('production import paused (ScanPaused); checkpoint kept, rerun with --resume', file=sys.stderr)
        return 3
    except Exception as exc:
        # No SDK/SQL exception content, paths, identifiers, endpoints or credentials.
        print('production import refused (' + type(exc).__name__ + ')', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
