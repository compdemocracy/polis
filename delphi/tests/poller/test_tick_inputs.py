"""``TickInputs``: the one record of what the engine consumed for a tick
(PROPENSITY-LOGGING-DESIGN.md §9).

Pinned here: the dataclass's column fields (its fields minus the in-memory
moderation sets, plus the moderation delta columns) and the
``math_recompute_log`` DDL in migration 000044 name exactly the same columns
(a new input without a column, or a column without a field, fails);
``to_row``/``from_row`` round-trip every field, the moderation as deltas
against the chain's previous read; the constructors record the delivered
votes in delivery order, the moderation as read in canonical (sorted) order
or not read, and the rebuild descriptor, NULL ``created`` included; and
``engine_version`` follows its documented precedence.
"""

import dataclasses
import hashlib
import importlib.metadata
import os
import re
from typing import Any

import pytest

from polismath.poller.tick_inputs import (
    COLD,
    COLUMNS,
    EMPTY_MOD_SETS,
    IN_MEMORY_FIELDS,
    INCREMENTAL,
    MOD_DELTA_COLUMNS,
    WARM_RESTORE,
    TickInputs,
    engine_version,
    rebuild_digest,
)

_METADATA_COLUMNS = {"zid", "math_env", "math_tick", "created"}
_MIGRATION = ("server", "postgres", "migrations", "000044_routing_propensities.sql")


def _migration_path():
    path = os.path.abspath(os.path.dirname(__file__))
    while True:
        candidate = os.path.join(path, *_MIGRATION)
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(path)
        if parent == path:
            pytest.skip("no polis checkout above the tests: migration 000044 is not "
                        "packaged with delphi/tests (run from a checkout)")
        path = parent


def _ddl_columns(sql: str) -> set:
    block = re.search(r"CREATE TABLE math_recompute_log \((.*?)\n\);", sql, re.DOTALL)
    assert block, "no CREATE TABLE math_recompute_log block in migration 000044"
    columns = set()
    for line in block.group(1).splitlines():
        line = line.split("--", 1)[0].strip()
        if not line:
            continue
        first = line.split()[0]
        if first.upper() in {"PRIMARY", "CHECK", "CONSTRAINT", "UNIQUE", "FOREIGN"}:
            continue
        columns.add(first)
    return columns


def test_tick_inputs_matches_migration():
    with open(_migration_path()) as fh:
        columns = _ddl_columns(fh.read())
    fields = {f.name for f in dataclasses.fields(TickInputs)}
    assert set(COLUMNS) == (fields - set(IN_MEMORY_FIELDS)) | set(MOD_DELTA_COLUMNS)
    assert columns == set(COLUMNS) | _METADATA_COLUMNS, (
        f"columns without a TickInputs column: "
        f"{sorted(columns - set(COLUMNS) - _METADATA_COLUMNS)}; "
        f"TickInputs columns without a DDL column: {sorted(set(COLUMNS) - columns)}")


VOTES = [
    {"zid": 7, "pid": 3, "tid": 1, "vote": 1, "created": 1005},
    {"zid": 7, "pid": 1, "tid": 0, "vote": -1, "created": 1001},
    {"zid": 7, "pid": 3, "tid": 1, "vote": 0, "created": 1009},
]
MODS = {"mod_out_tids": [4, 2], "mod_in_tids": [5], "meta_tids": [], "mod_out_ptpts": [9]}


def test_incremental_records_the_delivered_votes_in_delivery_order():
    t = TickInputs.incremental(prev_math_tick=11, votes=VOTES, moderation=None,
                               version="v1")
    assert t.start_mode == INCREMENTAL and t.prev_math_tick == 11
    assert t.n_votes == 3
    assert t.vote_pids == (3, 1, 3)
    assert t.vote_tids == (1, 0, 1)
    assert t.vote_values == (1, -1, 0)
    assert t.vote_created == (1005, 1001, 1009)
    assert t.votes() == [{"pid": 3, "tid": 1, "vote": 1, "created": 1005},
                         {"pid": 1, "tid": 0, "vote": -1, "created": 1001},
                         {"pid": 3, "tid": 1, "vote": 0, "created": 1009}]
    assert t.mod_read is False and t.moderation() is None
    assert (t.mod_out_tids, t.mod_in_tids, t.meta_tids, t.mod_out_pids) == (None,) * 4
    assert t.rebuild_digest is None and t.rebuild_n_votes is None
    assert t.engine_version == "v1"


def test_a_moderation_only_tick_delivers_no_votes_and_reads_moderation():
    t = TickInputs.incremental(prev_math_tick=2, votes=[], moderation=MODS, version=None)
    assert t.n_votes == 0 and t.vote_pids == () and t.votes() == []
    assert t.mod_read is True
    # Canonical (sorted) order: replay rebuilds these lists from deltas, and
    # the engine's set iteration order (the blob's mod-out list) follows them.
    assert t.moderation() == {"mod_out_tids": [2, 4], "mod_in_tids": [5], "meta_tids": [],
                              "mod_out_ptpts": [9]}


def test_rebuild_records_the_descriptor_not_the_votes():
    ordered = sorted(VOTES, key=lambda v: (v["tid"], v["pid"], v["created"]))
    t = TickInputs.rebuild(WARM_RESTORE, prev_math_tick=4, votes=ordered,
                           moderation=MODS, version=None)
    assert t.n_votes is None and t.vote_pids is None and t.vote_created is None
    assert t.rebuild_n_votes == 3 and t.rebuild_through_created == 1009
    assert t.rebuild_digest == rebuild_digest(ordered)
    assert t.mod_read is True and t.mod_out_pids == (9,)
    cold = TickInputs.rebuild(COLD, prev_math_tick=None, votes=[], moderation=MODS,
                              version=None)
    assert cold.rebuild_through_created is None and cold.rebuild_n_votes == 0
    assert cold.rebuild_digest == hashlib.sha256(b"").hexdigest()


def test_the_digest_is_over_tid_pid_created_vote_in_read_order():
    a = rebuild_digest(VOTES)
    assert a == hashlib.sha256(b"1,3,1005,1\n0,1,1001,-1\n1,3,1009,0\n").hexdigest()
    assert rebuild_digest(list(reversed(VOTES))) != a
    assert rebuild_digest([dict(VOTES[0], vote=-1)] + VOTES[1:]) != a


BASE = ((2, 7), (5,), (), (9, 11))  # the chain's previous read


def test_to_row_from_row_round_trip_every_field():
    for t, base in (
        (TickInputs.incremental(prev_math_tick=11, votes=VOTES, moderation=MODS,
                                version="x", mod_base=BASE), BASE),
        (TickInputs.incremental(prev_math_tick=11, votes=VOTES, moderation=None,
                                version=None, mod_base=BASE), BASE),
        (TickInputs.rebuild(COLD, prev_math_tick=None, votes=VOTES, moderation=MODS,
                            version="y"), None),
    ):
        t = dataclasses.replace(t, last_vote_timestamp=1009, n_comments=4)
        row = t.to_row()
        assert set(row) == set(COLUMNS)
        # A database row carries the metadata columns too, and lists for arrays.
        db_row = {**{k: list(v) if isinstance(v, tuple) else v for k, v in row.items()},
                  "zid": 7, "math_env": "e", "math_tick": 12, "created": 1}
        assert TickInputs.from_row(db_row, base) == t


def test_moderation_is_stored_as_deltas_against_the_previous_read():
    t = TickInputs.incremental(prev_math_tick=11, votes=[], moderation=MODS, version=None,
                               mod_base=BASE)
    row = t.to_row()
    assert (row["mod_out_tids_added"], row["mod_out_tids_removed"]) == ([4], [7])
    assert (row["mod_in_tids_added"], row["mod_in_tids_removed"]) == ([], [])
    assert (row["meta_tids_added"], row["meta_tids_removed"]) == ([], [])
    assert (row["mod_out_pids_added"], row["mod_out_pids_removed"]) == ([], [11])
    # A rebuild's deltas are against the empty sets.
    rebuild = TickInputs.rebuild(COLD, prev_math_tick=None, votes=[], moderation=MODS,
                                 version=None).to_row()
    assert rebuild["mod_out_tids_added"] == [2, 4] and rebuild["mod_out_tids_removed"] == []
    # Not read: all eight NULL.
    unread = TickInputs.incremental(prev_math_tick=11, votes=[], moderation=None,
                                    version=None, mod_base=BASE).to_row()
    assert all(unread[c] is None for c in MOD_DELTA_COLUMNS)
    assert EMPTY_MOD_SETS == ((), (), (), ())


def test_folding_a_delta_that_does_not_fit_the_base_is_refused():
    row = TickInputs.incremental(prev_math_tick=11, votes=[], moderation=MODS,
                                 version=None, mod_base=BASE).to_row()
    with pytest.raises(ValueError, match="mod_out_tids"):
        TickInputs.from_row(dict(row, math_tick=12), EMPTY_MOD_SETS)  # 7 was never there


def test_a_null_created_vote_is_kept_in_the_rebuild_descriptor():
    """votes.created is nullable: the rebuild read keeps such a row (it sorts
    last), the descriptor takes the max over the stamped ones, and the digest
    line spells it as None, exactly as replay's filter will."""
    ordered: list[dict[str, Any]] = sorted(
        VOTES, key=lambda v: (v["tid"], v["pid"], v["created"]))
    ordered.append({"zid": 7, "pid": 4, "tid": 1, "vote": 1, "created": None})
    t = TickInputs.rebuild(COLD, prev_math_tick=None, votes=ordered, moderation=MODS,
                           version=None)
    assert t.rebuild_through_created == 1009 and t.rebuild_n_votes == 4
    assert t.rebuild_digest == rebuild_digest(ordered)
    only_null = TickInputs.rebuild(COLD, prev_math_tick=None, votes=ordered[-1:],
                                   moderation=MODS, version=None)
    assert only_null.rebuild_through_created is None and only_null.rebuild_n_votes == 1


def test_inconsistent_inputs_are_refused():
    with pytest.raises(ValueError, match="start_mode"):
        TickInputs.rebuild("restart", prev_math_tick=None, votes=[], moderation=MODS,
                           version=None)
    t = TickInputs.incremental(prev_math_tick=1, votes=VOTES, moderation=None, version=None)
    with pytest.raises(ValueError, match="mod_read"):
        dataclasses.replace(t, mod_out_tids=(1,))
    with pytest.raises(ValueError, match="vote arrays"):
        dataclasses.replace(t, vote_tids=(1,))


# --------------------------------------------------------------------------- #
# engine_version: POLIS_GIT_HASH (with POLIS_BUILD_TAG) > package metadata > None
# --------------------------------------------------------------------------- #
@pytest.fixture
def no_build_env(monkeypatch):
    for name in ("POLIS_GIT_HASH", "POLIS_BUILD_TAG"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_engine_version_is_the_image_git_hash(no_build_env):
    no_build_env.setenv("POLIS_GIT_HASH", "4f50b6f28")
    assert engine_version() == "4f50b6f28"


def test_engine_version_prefixes_the_build_tag(no_build_env):
    no_build_env.setenv("POLIS_GIT_HASH", "4f50b6f28")
    no_build_env.setenv("POLIS_BUILD_TAG", "v2.3.0")
    assert engine_version() == "v2.3.0+4f50b6f28"


def test_engine_version_ignores_the_dockerfile_placeholder(no_build_env):
    no_build_env.setenv("POLIS_GIT_HASH", "unknown")
    no_build_env.setenv("POLIS_BUILD_TAG", "")
    no_build_env.setattr(importlib.metadata, "version", lambda name: "9.9.9")
    assert engine_version() == "polismath==9.9.9"


def test_engine_version_falls_back_to_the_installed_distribution(no_build_env):
    def version(name):
        if name == "polismath":
            raise importlib.metadata.PackageNotFoundError(name)
        assert name == "delphi-polis"
        return "0.1.0"

    no_build_env.setattr(importlib.metadata, "version", version)
    no_build_env.setattr(importlib.metadata, "packages_distributions",
                         lambda: {"polismath": ["delphi-polis"]})
    assert engine_version() == "delphi-polis==0.1.0"


def test_engine_version_is_none_when_nothing_is_known(no_build_env):
    def missing(name):
        raise importlib.metadata.PackageNotFoundError(name)

    no_build_env.setattr(importlib.metadata, "version", missing)
    no_build_env.setattr(importlib.metadata, "packages_distributions", dict)
    assert engine_version() is None


def test_the_dockerfile_bakes_the_git_hash_into_the_final_image():
    dockerfile = os.path.join(os.path.dirname(__file__), "..", "..", "Dockerfile")
    if not os.path.isfile(dockerfile):
        pytest.skip("delphi/Dockerfile is not packaged with the tests")
    with open(dockerfile) as fh:
        text = fh.read()
    final = text.split("AS final", 1)[1].split("AS test", 1)[0]
    assert re.search(r"^ARG GIT_HASH=unknown$", final, re.MULTILINE)
    assert re.search(r"^ENV POLIS_GIT_HASH=\$GIT_HASH$", final, re.MULTILINE)
    assert re.search(r"^ARG POLIS_BUILD_TAG=$", final, re.MULTILINE)
    assert re.search(r"^ENV POLIS_BUILD_TAG=\$POLIS_BUILD_TAG$", final, re.MULTILINE)
