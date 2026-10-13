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
            current = imp.mapping(conn)
        follow_up = None
        if current != (conversations, reports):
            # Counts only. Additions (conversations or reports created during
            # the census) are accepted and the census is rebound to them.
            print('identity mapping drift ' + json.dumps(imp.mapping_drift((conversations, reports), current),
                                                         sort_keys=True), file=sys.stderr)
            first = imp.rebind_additions(attempt/'first.sqlite', (conversations, reports), current,
                                         args.allow_missing)
            # Private record of the additions so a follow-up pass re-imports
            # anything whose rows landed after this run's scan passed their page.
            follow_up = imp.write_follow_up(attempt, (conversations, reports), current)
            conversations, reports = current
        # With the embeddings table on, read each embedded comment's text once
        # (bounded, read-only, released before the slow staging) so materialize can
        # record the text SHA-256 beside each embedding; off, nothing is read.
        embeddings_on = imp.embeddings_table_enabled()
        text_shas, embedding_report = None, {}
        if embeddings_on:
            with closing(imp.connect_readonly_source(local=bool(args.local_endpoint))) as conn:
                text_shas = imp.embedding_text_shas(conn, attempt/'first.sqlite')
        root = attempt / 'snapshot'
        # --apply refuses at the first family past the per-run bounds, before
        # anything is copied or admitted. A dry run reports them and continues.
        oversized = None if args.apply else []
        bundles = imp.materialize(attempt/'first.sqlite', root, first, oversized=oversized,
                                  embeddings_table=embeddings_on, text_shas=text_shas,
                                  embedding_report=embedding_report)
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
                      canonical_result_bytes=sum(b['bytes'] for b in bundles), completed_graphs=imported,
                      embedding_models=imp.embedding_model_counts(attempt/'first.sqlite'))
        if embeddings_on:
            # Counts only (rows stored, comments whose text was gone, per-model).
            result['embeddings'] = embedding_report
        if not args.apply:
            # Counts and byte sizes only, never ids.
            result['staging'] = imp.oversize_summary(oversized)
        if follow_up is not None:
            # Counts only; the identities are on the private mount (follow-up.json).
            result['follow_up'] = follow_up
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
