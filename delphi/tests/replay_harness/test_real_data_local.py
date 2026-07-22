"""dataset_dir resolves private datasets under real_data/.local/.

The five private datasets live in ``real_data/.local/*-<slug>`` (gitignored);
the public ones at ``real_data/*-<slug>``. The battery needs both
(GOAL_R1_PARITY.md: "All real_data datasets"). Slug-only lookups keep
report-id directory names out of code (real_data.py module doc).
"""

from __future__ import annotations

import pytest

from polismath.replay import real_data as rd


@pytest.fixture()
def fake_root(tmp_path, monkeypatch):
    (tmp_path / "rPUBLIC-pub").mkdir()
    (tmp_path / ".local" / "rPRIVATE-priv").mkdir(parents=True)
    (tmp_path / ".local" / "rSHADOW-pub").mkdir()  # slug collision with public
    monkeypatch.setattr(rd, "REAL_DATA_ROOT", tmp_path)
    return tmp_path


def test_public_dataset_resolves(fake_root):
    assert rd.dataset_dir("pub") == fake_root / "rPUBLIC-pub"


def test_local_dataset_resolves(fake_root):
    assert rd.dataset_dir("priv") == fake_root / ".local" / "rPRIVATE-priv"


def test_public_wins_slug_collision(fake_root):
    # Top-level (public) match takes priority over a .local shadow.
    assert rd.dataset_dir("pub") == fake_root / "rPUBLIC-pub"


def test_unknown_slug_returns_none(fake_root):
    assert rd.dataset_dir("nope") is None
