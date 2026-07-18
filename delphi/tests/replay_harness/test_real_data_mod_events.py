"""``real_data.load_export_votes`` builds ``dataset.mod_events`` from the
comments CSV when it carries the moderation-history columns
(MOD_RESTART_PORT_SPEC.md "Python ports" item 3: modified->t_ms,
comment-id->tid, moderated->mod, is-meta->is_meta).

Synthetic fixtures only, written under ``tmp_path`` with ``REAL_DATA_ROOT``
monkeypatched — never touches ``real_data/.local``.
"""

from __future__ import annotations

import csv

import pytest

from polismath.replay import real_data as rd

_VOTES_HEADER = ["timestamp", "datetime", "comment-id", "voter-id", "vote"]

# New-format header: existing columns unchanged, is-meta/modified ADDITIVE
# at the end (mirrors the prodclone extractor's planned column order).
_COMMENTS_HEADER_NEW = [
    "timestamp", "datetime", "comment-id", "author-id",
    "agrees", "disagrees", "moderated", "comment-body",
    "is-meta", "modified",
]
_COMMENTS_HEADER_LEGACY = [
    "timestamp", "datetime", "comment-id", "author-id",
    "agrees", "disagrees", "moderated", "comment-body",
]


def _write_csv(path, header, rows) -> None:
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)


@pytest.fixture()
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setattr(rd, "REAL_DATA_ROOT", tmp_path)
    return tmp_path


def _seed_votes(d, slug: str) -> None:
    _write_csv(
        d / f"{slug}-votes.csv", _VOTES_HEADER,
        [
            [100, "t1", 10, 1, 1],
            [200, "t2", 11, 2, -1],
        ],
    )


def test_mod_events_built_from_new_columns(fake_root):
    slug = "modtest"
    d = fake_root / f"rFAKE-{slug}"
    d.mkdir()
    _seed_votes(d, slug)
    _write_csv(
        d / f"{slug}-comments.csv", _COMMENTS_HEADER_NEW,
        [
            [100, "t1", 10, 1, 3, 1, -1, "", "False", 150],
            [200, "t2", 11, 2, 1, 0, 1, "", "True", 250],
        ],
    )
    ds = rd.load_export_votes(slug)
    assert len(ds.mod_events) == 2
    events = sorted(ds.mod_events, key=lambda m: m.t_ms)
    assert (events[0].t_ms, events[0].tid, events[0].mod) == (150, 10, -1)
    assert events[0].is_meta is False
    assert (events[1].t_ms, events[1].tid, events[1].mod) == (250, 11, 1)
    assert events[1].is_meta is True
    assert ds.mod_events_skipped == 0


def test_rows_without_modified_are_skipped_and_counted(fake_root):
    slug = "modtest2"
    d = fake_root / f"rFAKE-{slug}"
    d.mkdir()
    _seed_votes(d, slug)
    _write_csv(
        d / f"{slug}-comments.csv", _COMMENTS_HEADER_NEW,
        [
            [100, "t1", 10, 1, 3, 1, -1, "", "False", 150],
            [200, "t2", 11, 2, 1, 0, 1, "", "False", ""],  # no modified -> skip
        ],
    )
    ds = rd.load_export_votes(slug)
    assert len(ds.mod_events) == 1
    assert ds.mod_events[0].tid == 10
    assert ds.mod_events_skipped == 1


def test_legacy_comments_csv_without_new_columns_yields_no_mod_events(fake_root):
    # Pre-existing comments CSVs (moderated but no modified/is-meta columns)
    # must not error, and must not fabricate mod events out of the existing
    # "moderated" column alone — nothing to interleave on.
    slug = "modtest3"
    d = fake_root / f"rFAKE-{slug}"
    d.mkdir()
    _seed_votes(d, slug)
    _write_csv(
        d / f"{slug}-comments.csv", _COMMENTS_HEADER_LEGACY,
        [[100, "t1", 10, 1, 3, 1, -1, ""]],
    )
    ds = rd.load_export_votes(slug)
    assert ds.mod_events == []
    assert ds.mod_events_skipped == 0


def test_no_comments_csv_yields_no_mod_events(fake_root):
    slug = "modtest4"
    d = fake_root / f"rFAKE-{slug}"
    d.mkdir()
    _seed_votes(d, slug)
    ds = rd.load_export_votes(slug)
    assert ds.mod_events == []
    assert ds.mod_events_skipped == 0


def test_mod_events_sorted_by_t_ms_regardless_of_row_order(fake_root):
    slug = "modtest5"
    d = fake_root / f"rFAKE-{slug}"
    d.mkdir()
    _seed_votes(d, slug)
    _write_csv(
        d / f"{slug}-comments.csv", _COMMENTS_HEADER_NEW,
        [
            [200, "t2", 11, 2, 1, 0, 1, "", "False", 999],
            [100, "t1", 10, 1, 3, 1, -1, "", "False", 111],
        ],
    )
    ds = rd.load_export_votes(slug)
    assert [m.t_ms for m in ds.mod_events] == [111, 999]


def test_modified_without_moderated_column_yields_no_events(fake_root):
    # #2656 review finding 3: a malformed CSV carrying "modified" but missing
    # the moderated column must take the graceful no-mod-events path the
    # docstring promises, not crash with a KeyError mid-row.
    slug = "modtest7"
    d = fake_root / f"rFAKE-{slug}"
    d.mkdir()
    _seed_votes(d, slug)
    header = ["timestamp", "datetime", "comment-id", "author-id", "comment-body", "modified"]
    _write_csv(d / f"{slug}-comments.csv", header, [[100, "t1", 10, 1, "", 150]])
    ds = rd.load_export_votes(slug)
    assert ds.mod_events == []
    assert ds.mod_events_skipped == 0


def test_modified_without_is_meta_column_yields_events_meta_false(fake_root):
    # #2656 review finding 3: clj's mod-event reader keys ONLY on "modified"
    # (is-meta optional -> false). A comments CSV carrying modified but not
    # is-meta must still yield mod events, with is_meta defaulting to False.
    slug = "modtest6"
    d = fake_root / f"rFAKE-{slug}"
    d.mkdir()
    _seed_votes(d, slug)
    _write_csv(
        d / f"{slug}-comments.csv", _COMMENTS_HEADER_LEGACY + ["modified"],
        [
            [100, "t1", 10, 1, 3, 1, -1, "", 150],
            [200, "t2", 11, 2, 1, 0, 1, "", 250],
        ],
    )
    ds = rd.load_export_votes(slug)
    assert [(m.t_ms, m.tid, m.mod) for m in ds.mod_events] == [
        (150, 10, -1), (250, 11, 1),
    ]
    assert all(m.is_meta is False for m in ds.mod_events)
    assert ds.mod_events_skipped == 0
