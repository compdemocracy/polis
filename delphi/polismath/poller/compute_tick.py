"""``compute_tick``: one math generation from its recorded inputs.

PROPENSITY-LOGGING-DESIGN.md §9. The live poller
(``MathPollerService._compute_and_publish`` / ``_load_or_init``) reads the
database, records what it read in a :class:`~polismath.poller.tick_inputs.TickInputs`,
and calls :func:`compute_tick`; replay (:mod:`polismath.replay.tick_replay`)
calls the same function on the inputs read back from ``math_recompute_log``.
It takes no database handle at all: every input it consumes is in
``TickInputs`` (and, for a rebuild, the full-history votes the caller read and
the inputs' digest describes), so replay runs it with no database access and an
input that bypassed ``TickInputs`` would have no way in.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import (
    Any,
    cast,
)

from polismath.conversation.conversation import Conversation
from polismath.poller.math_writer import render_main_blob
from polismath.poller.tick_inputs import COLD, INCREMENTAL, WARM_RESTORE, TickInputs

#: The moderation sets a coordinator rebuild clears before applying the read
#: (snapshot replacement must carry un-moderation across a restore).
_MOD_SETS = ("mod_out_tids", "mod_in_tids", "meta_tids", "mod_out_ptpts")


class RestoreFailed(RuntimeError):
    """``Conversation.from_dict`` could not restore the persisted blob. The
    live path then rebuilds cold (and records the tick as ``cold``)."""


@dataclass(frozen=True)
class RestoreSource:
    """The persisted generation a ``warm_restore`` tick restores from: the
    ``math_main`` blob as read back from the database, and its
    ``last_vote_timestamp`` column."""

    blob: Mapping[str, Any]
    last_vote_timestamp: int | None


def _apply_votes(conv: Conversation, votes: Sequence[Mapping[str, Any]]) -> Conversation:
    if not votes:
        return conv
    # Imported here: service imports this module.
    from polismath.poller.service import advance_watermark

    created = cast(Iterable[int], (v.get("created") for v in votes))
    last_ts = advance_watermark(conv.last_updated, created)
    return conv.update_votes({"votes": list(votes), "lastVoteTimestamp": last_ts},
                             recompute=False)


def compute_tick(
    prev_state: Any,
    inputs: TickInputs,
    *,
    zid: int,
    rebuild_votes: Sequence[Mapping[str, Any]] | None = None,
    reset_moderation: bool = False,
    after_moderation: Callable[[], None] | None = None,
) -> tuple[Conversation, dict[str, Any]]:
    """Compute one generation; returns ``(state, blob)``, the blob being the
    ``math_main`` data exactly as the writer publishes it
    (:func:`~polismath.poller.math_writer.render_main_blob`).

    * ``incremental``: ``prev_state`` is the previous tick's Conversation;
      the delivered votes (``inputs.votes()``, delivery order), then the
      moderation as read when ``inputs.mod_read`` (``update_moderation``,
      sticky sets included), then ``recompute``.
    * ``warm_restore``: ``prev_state`` is a :class:`RestoreSource`; restore it
      (raises :class:`RestoreFailed`), then the full history.
    * ``cold``: ``prev_state`` is ignored; a fresh Conversation for ``zid``,
      then the full history.

    A rebuild's votes are ``rebuild_votes``, the full-history read in
    canonical order; their count must equal ``inputs.rebuild_n_votes`` (the
    caller verifies the digest: the live path computed it from this very list,
    replay checks it against the ``votes`` table). ``reset_moderation`` and
    ``after_moderation`` exist for the coordinator bridge (live only; its
    ticks write no log row).

    It takes no database handle: every input is in ``inputs`` and
    ``rebuild_votes``.
    """
    if inputs.start_mode == INCREMENTAL:
        conv = _apply_votes(prev_state, inputs.votes())
        moderation = inputs.moderation()
        if moderation is not None:
            conv = conv.update_moderation(moderation, recompute=False)
        conv = conv.recompute()
        return conv, render_main_blob(conv, zid)

    votes = list(rebuild_votes or [])
    if len(votes) != inputs.rebuild_n_votes:
        raise ValueError(f"rebuild_n_votes is {inputs.rebuild_n_votes} but "
                         f"{len(votes)} rebuild votes were supplied")
    if inputs.start_mode == WARM_RESTORE:
        if not isinstance(prev_state, RestoreSource):
            raise TypeError("a warm_restore tick restores from a RestoreSource")
        try:
            conv = Conversation.from_dict(dict(prev_state.blob))
            # The persisted column, not the blob's last_updated (a prior
            # wall-clock write may have poisoned it). A persisted 0 is
            # legitimate (Clojure's floor); only NULL falls back to 0.
            persisted = prev_state.last_vote_timestamp
            conv.last_updated = persisted if persisted is not None else 0
        except Exception as exc:
            raise RestoreFailed(f"from_dict restore failed for zid={zid}") from exc
    else:
        assert inputs.start_mode == COLD
        # The nonzero seed dodges Conversation's `last_updated or now`
        # wall-clock fallback; floored to 0 at once (Clojure's floor) so a
        # zero-vote conversation emits lastVoteTimestamp=0. zid passes as is
        # (int), not str(zid).
        conv = Conversation(zid, last_updated=1)
        conv.last_updated = 0

    conv = _apply_votes(conv, votes)
    moderation = inputs.moderation()
    assert moderation is not None  # a rebuild always reads moderation
    if reset_moderation:
        for key in _MOD_SETS:
            setattr(conv, key, set())
    conv = conv.update_moderation(moderation, recompute=False)
    if after_moderation is not None:
        after_moderation()
    conv = conv.recompute()
    return conv, render_main_blob(conv, zid)
