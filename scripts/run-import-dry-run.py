#!/usr/bin/env python3
"""Run the reviewed report once beside the existing Delphi container (SSM host).

No deploy, pull, credential bootstrap, service restart or apply operation. Use a
reviewed checkout and a running Delphi container. Private results stay on this host.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

# Pass existing database settings by environment name, never command-line values.
DATABASE_NAMES = {"DATABASE_URL", "DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME",
    "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_SSL_MODE", "PGSSLROOTCERT",
    "PGSSLCERT", "PGSSLKEY", "PGSSLCRL"}


def command(container, image, scratch, source, region, environment, missing):
    result = ["docker", "run", "--rm", "--network", "host", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--volumes-from", container + ":ro",
        "--mount", "type=bind,src=" + str(scratch) + ",dst=/import",
        "--mount", "type=bind,src=" + str(source) + ",dst=/app,readonly",
        "--workdir", "/app", "--env", "PYTHONDONTWRITEBYTECODE=1",
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
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--output', required=True, type=Path, help='new absolute private directory on this box')
    parser.add_argument('--region', default='us-east-1')
    parser.add_argument('--allow-missing', action='append', default=[])
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        if not args.output.is_absolute() or args.output.exists() or args.output.is_symlink():
            raise ValueError('new absolute output directory required')
        # Reject symlink ancestors to keep the private evidence destination explicit.
        if any(p.is_symlink() for p in args.output.parents):
            raise ValueError('symlink output ancestor refused')
        info = json.loads(subprocess.check_output(['docker', 'inspect', args.container], stderr=subprocess.DEVNULL))[0]
        if not info['State']['Running'] or info['Config'].get('Labels', {}).get('com.docker.compose.service') != 'delphi':
            raise ValueError('running Delphi compose container required')
        environment = {key: value for key, value in (entry.split('=', 1) for entry in info['Config']['Env']) if key in DATABASE_NAMES}
        args.output.mkdir(mode=0o700)
        scratch = args.output / 'scratch'
        scratch.mkdir(mode=0o700)
        root = Path(__file__).resolve().parents[1]
        # docker run accepts the immutable local image ID. Bind the reviewed
        # source read-only; do not build, pull or alter the running service.
        image = info['Image']
        (args.output/'runtime.json').write_text(json.dumps(dict(image=image, source=str(root/'delphi'))))
        with (args.output/'report.jsonl').open('xb') as report, (args.output/'stderr.log').open('xb') as errors:
            result = subprocess.run(command(args.container,image,scratch,root/'delphi',args.region,environment,args.allow_missing),
                env={**os.environ, **environment},stdout=report,stderr=errors)
        if result.returncode:
            raise ValueError('report failed; inspect private stderr')
        # Intentional private display requested by the operator; SSM output can
        # truncate. The byte-complete report always remains in --output.
        sys.stdout.buffer.write((args.output/'report.jsonl').read_bytes())
        return 0
    except Exception as exc:
        print('import report launcher refused (' + type(exc).__name__ + '); inspect private output directory', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
