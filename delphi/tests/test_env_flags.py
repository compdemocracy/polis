"""
Tests for polismath.utils.env_flags — the shared legacy-vs-improved
implementation-switch resolver.

The resolver started life as `pca._resolve_impl_flag` (pca.py) and was imported
from there by the (since-deleted) `utils.engine_mode`, which dragged the
whole numpy/pandas pca import chain into anything that only wanted to read an
impl flag, and
emitted resolution warnings under the pca logger. These tests pin the move to
`polismath.utils.env_flags`: identical resolution rules, warnings under the
env_flags logger, and light imports for its consumers.
"""

import logging
import subprocess
import sys

import pytest

from polismath.utils.env_flags import resolve_impl_flag


class TestResolveImplFlag:
    """Resolution rules (identical to the original pca._resolve_impl_flag)."""

    ENV = 'POLISMATH_TEST_FLAG'
    CHOICES = ('legacy', 'improved')

    def test_unset_returns_default(self, monkeypatch):
        monkeypatch.delenv(self.ENV, raising=False)
        assert resolve_impl_flag(self.ENV, 'legacy', self.CHOICES) == 'legacy'

    def test_valid_value_returned(self, monkeypatch):
        monkeypatch.setenv(self.ENV, 'improved')
        assert resolve_impl_flag(self.ENV, 'legacy', self.CHOICES) == 'improved'

    def test_value_stripped_and_lowercased(self, monkeypatch):
        monkeypatch.setenv(self.ENV, '  IMPROVED ')
        assert resolve_impl_flag(self.ENV, 'legacy', self.CHOICES) == 'improved'

    def test_invalid_value_falls_back_with_warning(self, monkeypatch, caplog):
        monkeypatch.setenv(self.ENV, 'bogus')
        with caplog.at_level(logging.WARNING, logger='polismath.utils.env_flags'):
            assert resolve_impl_flag(self.ENV, 'legacy', self.CHOICES) == 'legacy'
        records = [r for r in caplog.records
                   if r.name == 'polismath.utils.env_flags']
        assert len(records) == 1
        assert 'POLISMATH_TEST_FLAG' in records[0].getMessage()

    def test_read_at_call_time(self, monkeypatch):
        monkeypatch.setenv(self.ENV, 'improved')
        assert resolve_impl_flag(self.ENV, 'legacy', self.CHOICES) == 'improved'
        monkeypatch.setenv(self.ENV, 'legacy')
        assert resolve_impl_flag(self.ENV, 'legacy', self.CHOICES) == 'legacy'


class TestSharedResolver:
    """Both switch modules resolve through the ONE shared function."""

    def test_pca_uses_shared_resolver(self):
        from polismath.pca_kmeans_rep import pca
        from polismath.utils import env_flags
        assert pca.resolve_impl_flag is env_flags.resolve_impl_flag

    def test_env_flags_import_does_not_load_pca(self):
        # The point of the move: reading a light impl flag must not drag
        # the numpy/pandas pca import chain. Fresh interpreter so this
        # process's already-imported modules can't mask a regression.
        code = (
            "import sys; import polismath.utils.env_flags; "
            "sys.exit(1 if 'polismath.pca_kmeans_rep.pca' in sys.modules else 0)"
        )
        proc = subprocess.run([sys.executable, '-c', code],
                              capture_output=True, text=True)
        assert proc.returncode == 0, (
            "importing polismath.utils.env_flags pulled in "
            "polismath.pca_kmeans_rep.pca:\n" + proc.stderr
        )


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
