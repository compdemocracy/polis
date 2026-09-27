"""An INDEPENDENT reference fold of the raw input stream (P-022 §C).

The recovery matrix requires "a small independent fold of the input votes to
check final state (not the engine's own methods)".  Everything in this module
is therefore deliberately dumb, plain-stdlib Python:

* no ``numpy``/``pandas``,
* **nothing** imported from ``polismath`` — not even the vote-sign converter or
  the moderation reader, which are themselves under test,
* no knowledge of ``Conversation`` internals.

It folds the rows a test committed to Postgres (or read back out of it with a
plain ``SELECT``) into the state the poller must eventually publish, and exposes
that state in the two shapes ``math_main.data`` actually carries:

``user-vote-counts``
    per-pid count of cells with a latest vote (``conversation.py``'s
    ``_compute_user_vote_counts`` = non-missing cells of ``raw_rating_mat``).
``votes-base``
    per-tid A/D/S counts, per base-cluster bucket; summing the buckets for one
    tid gives that comment's agree/disagree/observed totals over the
    **clustered** participants.  The fold's per-tid totals are over ALL
    participants, so they are an upper bound that is exact whenever every voter
    is clustered — which is the case for the small generated fixtures here, and
    is asserted explicitly rather than assumed.

Vote-sign convention is spelled out locally instead of imported:
Postgres stores AGREE=-1 / DISAGREE=+1 / PASS=0; the math engine uses
AGREE=+1 / DISAGREE=-1 / PASS=0.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

# --- raw Postgres storage polarity (P-023 `storage_agree_value`) ------------ #
RAW_AGREE = -1
RAW_DISAGREE = 1
RAW_PASS = 0

# --- engine polarity -------------------------------------------------------- #
ENGINE_AGREE = 1
ENGINE_DISAGREE = -1
ENGINE_PASS = 0

Cell = Tuple[Any, Any]  # (pid, tid)


def raw_to_engine(raw_vote: int, storage_agree_value: int = RAW_AGREE) -> int:
    """Convert a stored vote to the engine convention, given the storage
    polarity.  ``storage_agree_value`` is the value the DB uses for AGREE
    (-1 today).  Written out here rather than imported from
    ``polismath.utils.general`` so the fold cannot inherit a sign bug from the
    code it is checking."""
    if raw_vote == RAW_PASS:
        return ENGINE_PASS
    return ENGINE_AGREE if raw_vote == storage_agree_value else ENGINE_DISAGREE


@dataclass
class VoteFold:
    """The authoritative latest-cell state derived from an ordered vote stream."""

    #: (pid, tid) -> engine-convention vote of the winning event
    cells: Dict[Cell, int] = field(default_factory=dict)
    #: (pid, tid) -> ``created`` of the winning event
    cell_created: Dict[Cell, int] = field(default_factory=dict)
    #: cells whose winner is ambiguous: two or more events tie on max(created)
    #: with different vote values.  The DB's ``ORDER BY zid, tid, pid, created``
    #: does not break that tie, so no test may assert a single winner there.
    ambiguous: Set[Cell] = field(default_factory=set)
    #: total number of vote EVENTS folded (not cells) — the raw event counter
    event_count: int = 0
    #: max(created) over every folded event; 0 for an empty stream (Clojure's
    #: floor, conversation.clj:161-165)
    last_vote_timestamp: int = 0

    # -- derived views ------------------------------------------------------ #
    @property
    def participants(self) -> Set[Any]:
        return {pid for pid, _ in self.cells}

    @property
    def comments(self) -> Set[Any]:
        return {tid for _, tid in self.cells}

    def user_vote_counts(self) -> Dict[Any, int]:
        """pid -> number of cells this participant has a latest vote in."""
        counts: Dict[Any, int] = {}
        for pid, _tid in self.cells:
            counts[pid] = counts.get(pid, 0) + 1
        return counts

    def per_comment_totals(self) -> Dict[Any, Dict[str, int]]:
        """tid -> {'A': agrees, 'D': disagrees, 'S': observed cells}."""
        totals: Dict[Any, Dict[str, int]] = {}
        for (_pid, tid), vote in self.cells.items():
            entry = totals.setdefault(tid, {"A": 0, "D": 0, "S": 0})
            entry["S"] += 1
            if vote == ENGINE_AGREE:
                entry["A"] += 1
            elif vote == ENGINE_DISAGREE:
                entry["D"] += 1
        return totals


def fold_votes(
    events: List[Dict[str, Any]],
    storage_agree_value: int = RAW_AGREE,
) -> VoteFold:
    """Fold raw vote rows into latest-cell state.

    ``events`` are dicts with ``pid``/``tid``/``vote`` (RAW storage sign) and
    ``created`` (epoch millis), in the order the DB returns them.  The winner of
    a cell is the event with the greatest ``created``; a tie on ``created``
    between DIFFERENT vote values is recorded in :attr:`VoteFold.ambiguous`
    rather than silently resolved, because the poller's load ordering
    (``ORDER BY zid, tid, pid, created``) does not define it either.
    """
    fold = VoteFold()
    for ev in events:
        cell: Cell = (ev["pid"], ev["tid"])
        created = int(ev["created"])
        value = raw_to_engine(int(ev["vote"]), storage_agree_value)
        fold.event_count += 1
        if created > fold.last_vote_timestamp:
            fold.last_vote_timestamp = created
        prior = fold.cell_created.get(cell)
        if prior is None or created > prior:
            fold.cells[cell] = value
            fold.cell_created[cell] = created
            fold.ambiguous.discard(cell)
        elif created == prior:
            if fold.cells[cell] != value:
                fold.ambiguous.add(cell)
            # later row of an equal-created pair wins in payload order, which is
            # what the engine's stable sort + keep='last' does — but the DB row
            # order between them is arbitrary, hence `ambiguous`.
            fold.cells[cell] = value
    return fold


@dataclass
class ModerationFold:
    mod_out_tids: Set[Any] = field(default_factory=set)
    mod_in_tids: Set[Any] = field(default_factory=set)
    meta_tids: Set[Any] = field(default_factory=set)
    mod_out_ptpts: Set[Any] = field(default_factory=set)
    last_mod_timestamp: int = 0


def fold_moderation(
    comment_rows: List[Dict[str, Any]],
    participant_rows: Optional[List[Dict[str, Any]]] = None,
) -> ModerationFold:
    """Fold current comment/participant rows into the moderation state.

    A comments snapshot is CURRENT STATE, not a history of moderation actions
    (P-022 §A) — so this folds the rows as they stand, exactly like a plain
    ``SELECT``, and never tries to reconstruct a timeline.
    """
    fold = ModerationFold()
    for row in comment_rows:
        tid = row["tid"]
        mod = row["mod"]
        if mod in (1, "1"):
            fold.mod_in_tids.add(tid)
        elif mod in (-1, "-1"):
            fold.mod_out_tids.add(tid)
        if row.get("is_meta"):
            fold.meta_tids.add(tid)
        modified = row.get("modified")
        if modified is not None and int(modified) > fold.last_mod_timestamp:
            fold.last_mod_timestamp = int(modified)
    for row in participant_rows or []:
        if row.get("mod") in (-1, "-1"):
            fold.mod_out_ptpts.add(row["pid"])
    return fold


# --------------------------------------------------------------------------- #
# Comparing the fold against a published math_main blob
# --------------------------------------------------------------------------- #
def votes_base_totals(data: Dict[str, Any]) -> Dict[int, Dict[str, int]]:
    """Sum ``math_main.data['votes-base']``'s per-base-cluster buckets into
    per-tid A/D/S totals.  ``votes-base`` is ``{tid: {'A': [...], 'D': [...],
    'S': [...]}}`` — one entry per base cluster, sorted by cluster id."""
    out: Dict[int, Dict[str, int]] = {}
    for tid, buckets in (data.get("votes-base") or {}).items():
        out[int(tid)] = {
            key: int(sum(buckets.get(key) or []))
            for key in ("A", "D", "S")
        }
    return out


def check_published_against_fold(
    data: Dict[str, Any],
    fold: VoteFold,
    *,
    require_all_clustered: bool = True,
) -> List[str]:
    """Return a list of human-readable mismatches between a published
    ``math_main.data`` blob and the independent fold.  Empty list == agreement.

    Deliberately returns problems instead of asserting, so a caller can use the
    same routine for a positive assertion and for a negative control.
    """
    problems: List[str] = []

    published_ts = data.get("lastVoteTimestamp")
    if published_ts != fold.last_vote_timestamp:
        problems.append(
            f"lastVoteTimestamp: published {published_ts!r} != "
            f"folded {fold.last_vote_timestamp!r}"
        )

    expected_counts = {int(k): v for k, v in fold.user_vote_counts().items()}
    published_counts = {
        int(k): int(v) for k, v in (data.get("user-vote-counts") or {}).items()
    }
    if published_counts != expected_counts:
        problems.append(
            f"user-vote-counts: published {published_counts!r} != "
            f"folded {expected_counts!r}"
        )

    if data.get("n") != len(fold.participants):
        problems.append(
            f"n: published {data.get('n')!r} != folded "
            f"{len(fold.participants)!r} participants"
        )

    if require_all_clustered:
        expected_totals = {
            int(t): v for t, v in fold.per_comment_totals().items()
        }
        published_totals = votes_base_totals(data)
        if published_totals != expected_totals:
            problems.append(
                f"votes-base totals: published {published_totals!r} != "
                f"folded {expected_totals!r}"
            )

    return problems
