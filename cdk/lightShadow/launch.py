"""Light-shadow launcher. Runs inside the delphi image as the container's entrypoint.

It reads the database secret from Secrets Manager into this process's memory,
builds DATABASE_URL, and replaces itself with the math poller. The credential is
never written to disk, never passed on a command line and never set in the
container's configuration (so `docker inspect` does not show it).

It refuses to start unless MATH_ENV is exactly `python-shadow` and
DATABASE_SSL_MODE is exactly `require`. Every refusal message is a fixed string
and never includes a secret value.
"""

import json
import os
import sys

REQUIRED_MATH_ENV = "python-shadow"
REQUIRED_SSL_MODE = "require"
POLLER = "/app/scripts/math_poller.py"
# The poller splits DATABASE_URL with urllib.parse and does not percent-decode,
# so any of these characters in the login or password would be misread. The
# RDS generated secret excludes them; refuse rather than mangle if that changes.
URL_UNSAFE = set("@/:?#%[]\\'\" \t\r\n")


def refuse(reason):
    sys.stderr.write("light-shadow launcher refused: " + reason + "\n")
    sys.exit(64)


def check_environment(env):
    if env.get("MATH_ENV") != REQUIRED_MATH_ENV:
        refuse("MATH_ENV must be " + REQUIRED_MATH_ENV)
    if env.get("DATABASE_SSL_MODE") != REQUIRED_SSL_MODE:
        refuse("DATABASE_SSL_MODE must be " + REQUIRED_SSL_MODE)
    if "DATABASE_URL" in env:
        refuse("DATABASE_URL must not be supplied from outside the launcher")
    for name in ("DB_SECRET_ARN", "DB_EXPECTED_HOST", "AWS_REGION"):
        if not env.get(name):
            refuse(name + " is required")


def database_url(secret, expected_host):
    try:
        user = secret["username"]
        password = secret["password"]
        host = secret["host"]
        port = int(secret.get("port", 5432))
        name = secret.get("dbname", "polisdb")
    except (KeyError, TypeError, ValueError):
        refuse("database secret does not have the expected fields")
    if host != expected_host:
        refuse("database secret host differs from the configured database host")
    if not user or not password or any(c in URL_UNSAFE for c in user + password + name):
        refuse("database secret contains characters the poller cannot parse")
    return "postgresql://%s:%s@%s:%d/%s" % (user, password, host, port, name)


def main():
    check_environment(os.environ)
    import boto3  # imported after the checks so a refusal needs no AWS access

    client = boto3.client("secretsmanager", region_name=os.environ["AWS_REGION"])
    try:
        raw = client.get_secret_value(SecretId=os.environ["DB_SECRET_ARN"])["SecretString"]
        secret = json.loads(raw)
    except Exception:  # noqa: BLE001 - never echo the response
        refuse("could not read the database secret")
    os.environ["DATABASE_URL"] = database_url(secret, os.environ["DB_EXPECTED_HOST"])
    del raw, secret

    # BLAS provenance for the evidence trail (4d.0: bytes can depend on platform).
    try:
        import numpy

        numpy.show_config()
    except Exception:  # noqa: BLE001
        sys.stderr.write("light-shadow launcher: numpy.show_config unavailable\n")
    sys.stdout.flush()
    os.execv(sys.executable, [sys.executable, POLLER])


if __name__ == "__main__":
    main()
