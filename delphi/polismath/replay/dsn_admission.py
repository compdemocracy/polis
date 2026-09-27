"""Keep credentials out of command arguments and downstream child argv."""
from __future__ import annotations

from psycopg2.extensions import parse_dsn
from urllib.parse import urlsplit, parse_qsl

ERROR = 'DSN_PASSWORD_FORBIDDEN_USE_PGPASSFILE_OR_SERVICE'


def passwordless_dsn(value: str) -> str:
    """Validate with libpq's own parser; never include input in an error.

    passfile=, PGPASSFILE and service= remain libpq-owned credential paths.
    Even an empty password field is refused. Inspect nested dbname expansion,
    which libpq accepts as another connection string.
    """
    current = value
    for _ in range(8):
        try:
            if current.startswith(('postgresql://', 'postgres://')):
                url = urlsplit(current)
                if url.password is not None or any(k == 'password' for k, _ in parse_qsl(url.query, keep_blank_values=True)):
                    raise ValueError(ERROR)
            fields = parse_dsn(current)
        except ValueError as exc:
            raise ValueError(ERROR if str(exc) == ERROR else 'DSN_INVALID') from None
        except Exception:
            raise ValueError('DSN_INVALID') from None
        if 'password' in fields:
            raise ValueError(ERROR)
        nested = fields.get('dbname', '')
        if nested.startswith(('postgresql://', 'postgres://')) or '=' in nested:
            current = nested
        else:
            return value
    raise ValueError('DSN_INVALID')


def click_dsn(_context, _parameter, value):
    import click
    try:
        return passwordless_dsn(value)
    except ValueError as exc:
        raise click.BadParameter(str(exc)) from None


def argparse_dsn(value):
    import argparse
    try:
        return passwordless_dsn(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None
