#!/usr/bin/env python3
"""Run the reviewed report once beside the existing Delphi container (SSM host).

No deploy, pull, credential bootstrap, service restart or apply operation. Use a
reviewed checkout and a running Delphi container. Private results stay on this host.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

# Pass existing database settings by environment name, never command-line values.
DATABASE_NAMES = {"DATABASE_URL", "DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME",
    "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_SSL_MODE", "PGSSLROOTCERT",
    "PGSSLCERT", "PGSSLKEY", "PGSSLCRL"}


# This launcher's own refusals: fixed text, no box identifiers or source values.
REFUSALS = frozenset({
    'absolute output directory required',
    'new output directory required, or --resume with the paused one',
    'symlink output ancestor refused',
    'running Delphi compose container required',
    'paused run with the same image and source required',
    'output already holds a report',
    'report failed; inspect private stderr',
})
# The report's own refusal line (already reduced to a class and fixed text).
REPORT_REFUSAL = re.compile(r"import dry-run refused \([A-Za-z_][A-Za-z0-9_]{0,63}(: [A-Za-z0-9 ,;.'/()_-]{1,120})?\)")


def reason(exc):
    """Exception class, plus its text only when it is one of this launcher's fixed refusals."""
    text = type(exc).__name__
    if type(exc) is ValueError and len(exc.args) == 1 and exc.args[0] in REFUSALS:
        text += ': ' + exc.args[0]
    return text


def report_refusal(stderr_log):
    """The report's last refusal line from its stderr log, when it has the expected shape."""
    try:
        lines = stderr_log.read_bytes()[-65536:].decode('ascii', 'replace').splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if REPORT_REFUSAL.fullmatch(line):
            return line
    return None


def command(container, image, scratch, source, region, environment, missing, extra=(), skipped=()):
    # Keep reviewed source separate from inherited mounts such as /app/data.
    # Docker must not create their mountpoints inside the read-only source bind.
    result = ["docker", "run", "--rm", "--network", "host", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--volumes-from", container + ":ro",
        "--mount", "type=bind,src=" + str(scratch) + ",dst=/import",
        "--mount", "type=bind,src=" + str(source) + ",dst=/opt/polis-import-source,readonly",
        "--workdir", "/opt/polis-import-source", "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--entrypoint", "python"]
    for name in sorted(DATABASE_NAMES & environment.keys()):
        result.extend(["--env", name])
    # Explicitly disable env/profile credential overrides inherited from an image.
    # Host networking reaches the box's existing IMDSv2 instance-profile access.
    for value in ["AWS_ACCESS_KEY_ID=", "AWS_SECRET_ACCESS_KEY=", "AWS_SESSION_TOKEN=",
                  "AWS_PROFILE=", "AWS_SHARED_CREDENTIALS_FILE=/nonexistent",
                  "AWS_CONFIG_FILE=/nonexistent", "AWS_EC2_METADATA_DISABLED=false",
                  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=", "AWS_CONTAINER_CREDENTIALS_FULL_URI=",
                  "AWS_WEB_IDENTITY_TOKEN_FILE=", "AWS_ROLE_ARN="]:
        result.extend(["--env", value])
    result.extend([image, "scripts/report_dynamo_import.py", "--region", region])
    for family in missing:
        result.extend(["--allow-missing", family])
    for family in skipped:
        result.extend(["--skip-family", family])
    # Scan pacing/resume flags only; validated again by the report itself.
    result.extend(extra)
    return result


def report_extra(args):
    extra = []
    for flag, value in (("--max-read-units-per-second", args.max_read_units_per_second),
                        ("--scan-page-limit", args.scan_page_limit),
                        ("--max-throttle-retries", args.max_throttle_retries)):
        if value is not None:
            extra.extend([flag, str(value)])
    if args.resume:
        extra.append("--resume")
    return extra


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--output', required=True, type=Path, help='new absolute private directory on this box')
    parser.add_argument('--region', default='us-east-1')
    parser.add_argument('--allow-missing', action='append', default=[])
    parser.add_argument('--skip-family', action='append', default=[],
                        help='never read this source table (e.g. a legacy table outside the role\'s permission)')
    parser.add_argument('--max-read-units-per-second', type=float,
                        help='report default: 2 read units/s, safe for 5-unit tables')
    parser.add_argument('--scan-page-limit', type=int)
    parser.add_argument('--max-throttle-retries', type=int)
    parser.add_argument('--resume', action='store_true',
                        help='continue a paused run in its existing --output directory')
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        if not args.output.is_absolute() or args.output.is_symlink():
            raise ValueError('absolute output directory required')
        if args.output.exists() != args.resume:
            raise ValueError('new output directory required, or --resume with the paused one')
        # Reject symlink ancestors to keep the private evidence destination explicit.
        if any(p.is_symlink() for p in args.output.parents):
            raise ValueError('symlink output ancestor refused')
        info = json.loads(subprocess.check_output(['docker', 'inspect', args.container], stderr=subprocess.DEVNULL))[0]
        if not info['State']['Running'] or info['Config'].get('Labels', {}).get('com.docker.compose.service') != 'delphi':
            raise ValueError('running Delphi compose container required')
        environment = {key: value for key, value in (entry.split('=', 1) for entry in info['Config']['Env']) if key in DATABASE_NAMES}
        root = Path(__file__).resolve().parents[1]
        # docker run accepts the immutable local image ID. Bind the reviewed
        # source read-only; do not build, pull or alter the running service.
        image = info['Image']
        runtime = json.dumps(dict(image=image, source=str(root/'delphi')))
        scratch = args.output / 'scratch'
        if args.resume:
            # Continue only the same image and source over the same checkpoints.
            kept = [scratch] + [args.output/name for name in ('runtime.json', 'report.jsonl', 'stderr.log')]
            if (not args.output.is_dir() or any(p.is_symlink() for p in kept) or not scratch.is_dir()
                    or (args.output/'runtime.json').read_text() != runtime):
                raise ValueError('paused run with the same image and source required')
            if (args.output/'report.jsonl').stat().st_size:
                raise ValueError('output already holds a report')
            report_mode, error_mode = 'wb', 'ab'
        else:
            args.output.mkdir(mode=0o700)
            scratch.mkdir(mode=0o700)
            (args.output/'runtime.json').write_text(runtime)
            report_mode, error_mode = 'xb', 'xb'
        with (args.output/'report.jsonl').open(report_mode) as report, (args.output/'stderr.log').open(error_mode) as errors:
            result = subprocess.run(command(args.container,image,scratch,root/'delphi',args.region,environment,
                                            args.allow_missing,report_extra(args),skipped=args.skip_family),
                env={**os.environ, **environment},stdout=report,stderr=errors)
        if result.returncode == 3:
            print('import report paused by DynamoDB throttling; checkpoint kept. Rerun the same command '
                  'with --resume (same --output).', file=sys.stderr)
            return 3
        if result.returncode:
            refused = report_refusal(args.output/'stderr.log')
            if refused:
                print(refused, file=sys.stderr)
            raise ValueError('report failed; inspect private stderr')
        # Intentional private display requested by the operator; SSM output can
        # truncate. The byte-complete report always remains in --output.
        sys.stdout.buffer.write((args.output/'report.jsonl').read_bytes())
        return 0
    except Exception as exc:
        print('import report launcher refused (' + reason(exc) + '); inspect private output directory', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
