#!/usr/bin/env python3
"""Print a PRIVATE per-conversation dry-run report; there is no apply option."""
import argparse
from contextlib import closing
import fcntl
import os
from pathlib import Path
import json
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from polismath.delphi_storage import production_import as imp
from polismath.delphi_storage import import_report
from polismath.delphi_storage.scan_pacing import ScanPaused


# The fixed text of every ValueError raised by this report path (this script,
# production_import, import_report and scan_pacing). None of them carries a
# source value. Only an exact ValueError whose text is listed here is printed;
# any other exception prints its class alone, because codec errors (a ValueError
# subclass) quote item values and library errors can quote connection details.
REFUSALS = frozenset({
    'ambiguous report binding',
    'artifact verification failed',
    'census checkpoint unreadable',
    'census database already exists',
    'conversation exceeds staged batch bound',
    'conversation family exceeds staged storage bound',
    'dedicated import environment required',
    'destination digest mismatch',
    'detached import identity mismatch',
    'detached source bytes mismatch',
    'detached source count mismatch',
    'duplicate source key during scan',
    'exactly one incomplete attempt required to resume',
    'existing database connection required',
    'import admission exceeds graph input bound',
    'import environment contains unrelated jobs',
    'import wait bound exceeded',
    'import worker failed',
    'instance role required',
    'invalid backoff bounds',
    'invalid import scope',
    'invalid scan checkpoint',
    'invalid snapshot reference',
    'narrow queue executor login required',
    'page limit must be 1..1000',
    'positive read rate required',
    'previously skipped family must stay skipped on resume',
    'private import mount required',
    'repeated source continuation',
    'report conservation failure',
    'skipped family was already scanned',
    'snapshot contract mismatch',
    'snapshot digest mismatch',
    'snapshot symlink refused',
    'source changed between census passes',
    'source identity mapping changed',
    'source key schema mismatch',
    'source table disappeared during scan',
    'unapproved missing source table',
    'unexpected published import',
    'unquarantined source row',
    'verified queue database TLS required',
    'verified source database TLS required',
})


def refusal(exc):
    """The stderr line for a refused run: the class, plus the listed fixed text."""
    reason = type(exc).__name__
    if type(exc) is ValueError and len(exc.args) == 1 and exc.args[0] in REFUSALS:
        reason += ': ' + exc.args[0]
    return 'import dry-run refused (' + reason + ')'


def pacing(pacer):
    # Aggregate counters only: no table names, keys or identifiers.
    if pacer is not None:
        print('scan pacing ' + json.dumps(pacer.summary(), sort_keys=True), file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', required=True)
    parser.add_argument('--local-endpoint', help='tests only: explicit loopback DynamoDB Local')
    parser.add_argument('--allow-missing', action='append', choices=sorted(imp.codec.FAMILIES), default=[])
    parser.add_argument('--skip-family', action='append', choices=sorted(imp.codec.FAMILIES), default=[],
                        help='never read this source table; report it as skipped')
    imp.pacing_arguments(parser)
    args = parser.parse_args(argv)
    os.umask(0o077)
    pacer = None
    try:
        scratch = Path('/import')
        if scratch.is_symlink() or not scratch.is_dir():
            raise ValueError('private import mount required')
        with open(scratch / '.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            pacer = imp.pacer_from(args)
            attempt = imp.attempt_directory(scratch, 'report-', args.resume)
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
            # Each pass resumes from its own per-table checkpoint inside the attempt.
            first = imp.census(source, attempt/'first.sqlite', conversations, reports,
                               args.allow_missing, validate_schema=False, pacer=pacer, resume=args.resume,
                               skipped=args.skip_family)
            second = imp.census(source, attempt/'second.sqlite', conversations, reports,
                                args.allow_missing, validate_schema=False, pacer=pacer, resume=args.resume,
                               skipped=args.skip_family)
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
            imp.finish_attempt(attempt)
            pacing(pacer)
            sys.stdout.buffer.write(raw)
        return 0
    except ScanPaused:
        pacing(pacer)
        print('import dry-run paused (ScanPaused); checkpoint kept, rerun with --resume', file=sys.stderr)
        return 3
    except Exception as exc:
        pacing(pacer)
        print(refusal(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
