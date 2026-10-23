"""Exact replay of published math generations from ``math_recompute_log``.

PROPENSITY-LOGGING-DESIGN.md §9. Every tick the poller publishes logs the
inputs ``compute_tick`` consumed (:class:`~polismath.poller.tick_inputs.TickInputs`).
Replay folds those rows back through the same ``compute_tick``, which takes no
database handle, and reproduces the published ``math_main`` blob
(``comment-priorities`` included) bit for bit, except the wall-clock
``math_tick`` field inside the blob. It must run inside the image (engine
version) that computed the ticks: a row whose ``engine_version`` differs from
the running one, or is unknown, is refused unless explicitly allowed.

How a tick T is rebuilt (cost: every tick since its chain's last rebuild, and
for a warm restore the predecessor chain too; there are no checkpoints):

* ``incremental``: the state of its ``prev_math_tick``, plus its delivered
  votes and (when ``mod_read``) its moderation, folded from the deltas
  against the chain's previous read. The predecessor is replayed first, back
  to the chain's start.
* ``cold``: the full vote history its descriptor names: the ``votes`` rows
  with ``created <= rebuild_through_created`` (and those with a NULL
  ``created``) in canonical order (the caller's ``votes_source``, e.g.
  ``PostgresClient.poll_votes(zid, None)``), checked against
  ``rebuild_n_votes`` and ``rebuild_digest``. When the digest differs, the
  votes delivered by later incremental ticks descending from it (its chain,
  and chains restored from it) are removed (a vote stamped below the read but
  committed after it, which the poll window then delivered) and the digest
  checked again.
* ``warm_restore``: the blob of ``prev_math_tick`` (replayed), round-tripped
  through JSON exactly as the live poller read it back from ``math_main``
  (:func:`jsonb_roundtrip`), restored with that tick's
  ``last_vote_timestamp``, then the full history as for ``cold``.

Refusals (:class:`ReplayRefused`) say why a tick cannot be reproduced: a tick
missing from the log; an incremental tick with no recorded predecessor (for
instance a promoted generation, whose predecessor lives under another label);
a rebuild row without a descriptor (published before this log, or by a direct
writer call); a predecessor whose row was written after its successor's (the
tick sequence was reset: ``math_ticks`` removed, and a later generation now
holds that tick number); another engine version; a malformed row or a failed
restore; or a digest mismatch that the chain's own deliveries do not explain:
the ``votes`` table no longer holds the rows the rebuild read (a vote
committed late with an older ``created`` and never delivered, or a vote
deleted). The tick is then not reproducible from the database as it stands,
and replay says so rather than returning a different generation.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from decimal import Decimal
from typing import Any

from polismath.database.postgres import encode_math_blob
from polismath.poller.compute_tick import RestoreFailed, RestoreSource, compute_tick
from polismath.poller.tick_inputs import (
    INCREMENTAL,
    WARM_RESTORE,
    ModSets,
    TickInputs,
    engine_version,
    rebuild_digest,
)

VotesSource = Sequence[Mapping[str, Any]] | Callable[[], Sequence[Mapping[str, Any]]]

_RUNNING = object()  # the default expected version: this process's engine_version()


class ReplayRefused(RuntimeError):
    """The tick cannot be reproduced exactly; the message says why."""


# --------------------------------------------------------------------------- #
# The math_main read-back, emulated
# --------------------------------------------------------------------------- #
def _jsonb_key(key: str) -> tuple[int, bytes]:
    raw = key.encode("utf-8")
    return (len(raw), raw)


def _jsonb_normalise(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _jsonb_normalise(value[k]) for k in sorted(value, key=_jsonb_key)}
    if isinstance(value, list):
        return [_jsonb_normalise(v) for v in value]
    if isinstance(value, float):
        if value == 0.0:
            return 0.0  # numeric has no negative zero
        text = repr(value)
        if "e+" in text:
            # numeric keeps the decimal text and prints it in full: 1e+23 is
            # 10**23, not int(1e23) (99999999999999991611392).
            return int(Decimal(text))
    return value


def jsonb_roundtrip(blob: Mapping[Any, Any]) -> dict[str, Any]:
    """``blob`` as the poller reads it back from ``math_main.data``.

    The writer encodes with :func:`~polismath.database.postgres.encode_math_blob`
    and casts to ``jsonb`` (also for a ``json`` column), which orders object
    keys by byte length then bytes, keeps the last of duplicate keys, and
    stores numbers as ``numeric``: an exponent-form float (``1e+16``) comes
    back as an integer and ``-0.0`` as ``0.0``. psycopg2 decodes with
    ``json.loads``. The round-trip test compares this with a real read-back.
    """
    return _jsonb_normalise(json.loads(encode_math_blob(dict(blob))))


def _vote_key(v: Mapping[str, Any]) -> tuple[Any, Any, Any, Any]:
    return (v["pid"], v["tid"], v["vote"], v["created"])


# --------------------------------------------------------------------------- #
# The fold
# --------------------------------------------------------------------------- #
class TickReplayer:
    """Replays ticks of one ``(zid, math_env)`` from its log rows.

    ``votes_source`` is the conversation's full vote history in canonical
    order (``ORDER BY zid, tid, pid, created``, semantic sign), or a
    zero-argument callable returning it (read once, on the first rebuild).
    ``expected_version`` is the engine version every folded row must carry
    (default: this process's ``engine_version()``); ``allow_engine_mismatch``
    replays anyway.
    """

    def __init__(self, log_rows: Sequence[Mapping[str, Any]], votes_source: VotesSource,
                 *, zid: int | None = None, expected_version: Any = _RUNNING,
                 allow_engine_mismatch: bool = False) -> None:
        self._rows: dict[int, Mapping[str, Any]] = {}
        for row in log_rows:
            self._rows[int(row["math_tick"])] = row
            if zid is None:
                zid = row.get("zid")
        if zid is None:
            raise ReplayRefused("no math_recompute_log rows, and no zid given")
        self.zid = int(zid)
        self._expected = engine_version() if expected_version is _RUNNING else expected_version
        self._allow_mismatch = allow_engine_mismatch
        self._votes_source = votes_source
        self._history: list[Mapping[str, Any]] | None = None
        # The most recent replayed tick: (tick, state, blob, moderation read).
        self._last: tuple[int, Any, dict[str, Any], ModSets | None] | None = None

    # -- rows ---------------------------------------------------------------- #
    def _row(self, tick: int) -> Mapping[str, Any]:
        if tick not in self._rows:
            raise ReplayRefused(f"no math_recompute_log row for tick {tick} of zid "
                                f"{self.zid}")
        return self._rows[tick]

    def _inputs(self, tick: int, base: ModSets | None) -> TickInputs:
        try:
            return TickInputs.from_row(self._row(tick), base)
        except (ValueError, TypeError, KeyError) as exc:
            raise ReplayRefused(f"tick {tick}: malformed math_recompute_log row "
                                f"({exc.__class__.__name__}: {exc})") from exc

    def _check_version(self, tick: int) -> None:
        version = self._row(tick).get("engine_version")
        if self._allow_mismatch or (version is not None and version == self._expected):
            return
        raise ReplayRefused(
            f"tick {tick} was computed by engine_version {version!r} and this replay "
            f"runs {self._expected!r}: replay inside the image that computed the ticks "
            "(an engine change can change the generation), or pass "
            "--allow-engine-mismatch (allow_engine_mismatch=True) to replay anyway")

    def _check_link(self, tick: int, prev: int) -> None:
        """``prev`` must be the generation ``tick`` was computed from: its row
        written earlier (an overwrite re-stamps ``created``)."""
        if prev not in self._rows:
            raise ReplayRefused(f"tick {tick} continues tick {prev}, which has no "
                                "math_recompute_log row")
        before, after = self._rows[prev].get("created"), self._rows[tick].get("created")
        if before is None or after is None or before >= after:
            raise ReplayRefused(
                f"tick {tick} continues tick {prev} but tick {prev}'s log row was written "
                f"at or after it (created {before} >= {after}): the tick sequence was "
                "reset (math_ticks removed) and that tick number now holds a later "
                "generation, so the predecessor is lost")

    # -- planning -------------------------------------------------------------- #
    def _plan(self, tick: int) -> list[list[int]]:
        """Segments to fold, oldest first. Each starts with a rebuild row (or
        the cached last tick) and continues with incremental ticks; a
        ``warm_restore`` segment restores from the end of the one before it.
        Iterative, so a long history of restarts cannot exhaust the stack."""
        segments: list[list[int]] = []
        visited: set[int] = set()
        current = tick
        while True:
            chain = [current]
            while True:
                if current in visited:
                    raise ReplayRefused(f"tick {tick}: the predecessor chain loops at "
                                        f"tick {current}")
                visited.add(current)
                row = self._row(current)
                if self._last is not None and self._last[0] == current and len(chain) > 1:
                    break
                self._check_version(current)
                if row["start_mode"] != INCREMENTAL:
                    break
                prev = row["prev_math_tick"]
                if prev is None:
                    raise ReplayRefused(
                        f"tick {current} is incremental but has no recorded predecessor "
                        "(prev_math_tick is NULL: a promoted generation, or a state the "
                        "poller cached without knowing its tick); replay it under the "
                        "label that computed it")
                self._check_link(current, prev)
                chain.append(prev)
                current = prev
            chain.reverse()
            segments.append(chain)
            first = chain[0]
            if self._last is not None and self._last[0] == first and len(chain) > 1:
                break
            if self._last is not None and self._last[0] == first == tick:
                break
            row = self._row(first)
            if row["start_mode"] != WARM_RESTORE or row.get("rebuild_digest") is None:
                break  # cold, or a refusal _start reports
            prev = row["prev_math_tick"]
            if prev is None:
                raise ReplayRefused(f"tick {first} is a warm restore from an unknown tick")
            self._check_link(first, prev)
            current = prev
        segments.reverse()
        return segments

    # -- votes ------------------------------------------------------------------ #
    def _history_votes(self) -> list[Mapping[str, Any]]:
        if self._history is None:
            source = self._votes_source
            self._history = list(source() if callable(source) else source)
        return self._history

    def _delivered_later(self, start: int, through: int) -> Counter:
        """Votes stamped at or below ``through`` that later incremental ticks
        descending from ``start`` (through incremental links, or a later
        restart's warm restore from one of them) delivered. Removing them can
        only make the digest match when the result is exactly what the
        rebuild read, so the candidate set may be generous."""
        chain = {start}
        delivered: Counter = Counter()
        for tick in sorted(self._rows, key=lambda t: self._rows[t].get("created") or 0):
            row = self._rows[tick]
            prev = row.get("prev_math_tick")
            if tick in chain or prev not in chain:
                continue
            before, after = self._rows[prev].get("created"), row.get("created")
            if before is None or after is None or before >= after:
                continue
            chain.add(tick)
            if row["start_mode"] != INCREMENTAL:
                continue
            for pid, tid, vote, created in zip(row["vote_pids"] or [], row["vote_tids"] or [],
                                               row["vote_values"] or [],
                                               row["vote_created"] or []):
                if created is not None and created <= through:
                    delivered[(pid, tid, vote, created)] += 1
        return delivered

    def _rebuild_votes(self, tick: int, inputs: TickInputs) -> list[Mapping[str, Any]]:
        through = inputs.rebuild_through_created
        votes = [v for v in self._history_votes()
                 if v["created"] is None or (through is not None and v["created"] <= through)]
        digest = rebuild_digest(votes)
        if len(votes) == inputs.rebuild_n_votes and digest == inputs.rebuild_digest:
            return votes
        if through is not None:
            delivered = self._delivered_later(tick, through)
            if delivered:
                kept = []
                for v in votes:
                    key = _vote_key(v)
                    if delivered[key] > 0:
                        delivered[key] -= 1
                    else:
                        kept.append(v)
                if (len(kept) == inputs.rebuild_n_votes
                        and rebuild_digest(kept) == inputs.rebuild_digest):
                    return kept
        raise ReplayRefused(
            f"tick {tick} ({inputs.start_mode}) rebuilt from {inputs.rebuild_n_votes} "
            f"votes with created <= {through}, digest {inputs.rebuild_digest}; the "
            f"votes table now holds {len(votes)} such votes, digest {digest}. A vote "
            "was committed late (with an older created, and no later tick of the chain "
            "delivered it) or deleted since the tick was computed, so it cannot be "
            "reproduced from the database as it stands")

    # -- folding ---------------------------------------------------------------- #
    def _start(self, tick: int, restored: dict[str, Any] | None):
        inputs = self._inputs(tick, None)
        if not inputs.replayable:
            raise ReplayRefused(
                f"tick {tick} ({inputs.start_mode}) is not replayable: it has no rebuild "
                "descriptor (published before math_recompute_log recorded inputs, by a "
                "direct writer call, or synthesised for a promotion)")
        votes = self._rebuild_votes(tick, inputs)
        source = None
        if inputs.start_mode == WARM_RESTORE:
            prev = inputs.prev_math_tick
            assert prev is not None and restored is not None
            source = RestoreSource(jsonb_roundtrip(restored),
                                   self._rows[prev].get("last_vote_timestamp"))
        try:
            state, blob = compute_tick(source, inputs, zid=self.zid, rebuild_votes=votes)
        except RestoreFailed as exc:
            raise ReplayRefused(f"tick {tick}: the restore of tick {inputs.prev_math_tick}'s "
                                f"replayed blob failed ({exc.__cause__!r})") from exc
        return state, blob, inputs.mod_sets()

    def _state(self, tick: int) -> tuple[Any, dict[str, Any]]:
        if self._last is not None and self._last[0] == tick:
            return self._last[1], self._last[2]
        blob: dict[str, Any] | None = None
        for segment in self._plan(tick):
            first = segment[0]
            if self._last is not None and self._last[0] == first:
                _, state, blob, read = self._last
            else:
                state, blob, read = self._start(first, blob)
            for t in segment[1:]:
                inputs = self._inputs(t, read)
                state, blob = compute_tick(state, inputs, zid=self.zid)
                if inputs.mod_read:
                    read = inputs.mod_sets()
            self._last = (segment[-1], state, blob, read)
        assert self._last is not None and self._last[0] == tick
        return self._last[1], self._last[2]

    # -- public ------------------------------------------------------------ #
    def blob(self, tick: int) -> dict[str, Any]:
        """The ``math_main`` data of ``tick`` as the server read it."""
        return jsonb_roundtrip(self._state(tick)[1])

    def ticks(self, first: int, last: int) -> Iterator[tuple[int, dict[str, Any]]]:
        """``(tick, blob)`` for every logged tick in ``[first, last]``."""
        for tick in sorted(t for t in self._rows if first <= t <= last):
            yield tick, self.blob(tick)


def replay_to_tick(log_rows: Sequence[Mapping[str, Any]], votes_source: VotesSource,
                   target_tick: int, **options: Any) -> dict[str, Any]:
    """The ``math_main`` blob of ``target_tick``, replayed from the log rows
    (see the module docstring); raises :class:`ReplayRefused`. ``options``
    are :class:`TickReplayer`'s keyword arguments."""
    return TickReplayer(log_rows, votes_source, **options).blob(target_tick)
