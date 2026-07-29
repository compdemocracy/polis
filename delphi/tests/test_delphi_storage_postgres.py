"""Unit tests for the Postgres backend that need no live database.

``sqlalchemy.create_engine`` resolves the dialect eagerly (it does NOT open a
connection), so these exercise URL handling without a running Postgres.
"""

import pytest

sqlalchemy = pytest.importorskip("sqlalchemy")

from delphi_storage.backends.postgres import PostgresDelphiStore


class TestPgUrlSchemeNormalization:
    """SQLAlchemy 2.0 dropped the legacy ``postgres://`` alias and raises
    ``NoSuchModuleError`` on it, but ``postgres://`` is still what many
    platforms (Heroku et al.) put in ``DATABASE_URL``. The backend must
    normalize it to ``postgresql://`` so a production ``DATABASE_URL`` doesn't
    crash engine creation.
    """

    def test_legacy_postgres_scheme_is_normalized(self):
        store = PostgresDelphiStore(url="postgres://u:p@localhost:5432/db")
        assert store._engine.url.drivername == "postgresql"

    def test_postgresql_scheme_is_untouched(self):
        store = PostgresDelphiStore(url="postgresql://u:p@localhost:5432/db")
        assert store._engine.url.drivername == "postgresql"

    def test_explicit_driver_suffix_is_preserved(self):
        # A caller who pins the DBAPI driver must keep it — only the bare
        # postgres:// alias is rewritten, never postgres+<driver> or an
        # already-correct postgresql+<driver>.
        store = PostgresDelphiStore(url="postgresql+psycopg2://u:p@localhost:5432/db")
        assert store._engine.url.drivername == "postgresql+psycopg2"
