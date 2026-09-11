"""The standing POLARITY property: ``E(V, s) == E(-V, -s)`` through real ingress.

P-023 (rev3, ACCEPTED) states the gate this module implements. Let an admitted
vote stream ``V`` carry raw votes in ``{-1, 0, +1, NULL}`` with a declared
storage convention ``s`` (exactly the integer -1 or +1; semantic vote is
``v x s``). Define ``T(V, s) = (-V, -s)``, changing ONLY the non-null raw vote
leaves and the convention declaration — every identity, ordinal, tie position,
timestamp, weight and moderation event stays fixed. ``T`` is its own inverse
and ``semantic(T(V, s)) == semantic(V, s)``. The property is then

    canonical(E(V, s), output_profile) == canonical(E(-V, -s), output_profile)

executed from FRESH STATE through the engine's actual ingress on both sides —
never by transforming one already-computed output into the other, which would
only prove the transformer.

Three things this module keeps rigorously apart, because confusing them is how
a wrong mean passes:

1. **The storage convention `s`** — an input declaration
   (``polismath.utils.vote_convention``). Changing it alone must change the
   result; changing it together with the votes must not.
2. **The vote-axis involution `N`** — an OUTPUT transform, defined strictly on
   the *projected* ``PREP_MAIN_KEYS`` comparison view, applied only to
   translate an explicitly different output convention into the common profile.
   Rev3 is emphatic that N is NOT applied merely because ``s`` changed: this
   engine ingests semantically and returns the same output profile on both
   sides, so a compensated pair needs no N at all, and adding one would be the
   double-negation gate the design forbids.
3. **PCA eigenvector orientation** — a canonicalization step that flips a
   component and its coupled projections, and NEVER touches ``pca.center``. N
   leaves ``comps`` alone and moves the mean. They are different operations on
   overlapping fields.

What is deliberately NOT here: any raw-blob N, any extension of N to the
``group_clusters`` twin or to ``proj``, and any change to C9's producer sign
relation. Rev3 chose the post-projection definition of N precisely so that the
raw blob is untouched — ``project_prep_main`` drops the snake twin (exact kebab
wins) and drops ``proj`` (outside the whitelist) BEFORE N runs, so C9 is
evaluated on untouched raw bytes and ``Conversation.from_dict`` never sees an
N-translated blob. :func:`vote_axis_involution` enforces that by refusing to
run on anything that still carries those raw extensions.
"""

from __future__ import annotations

import copy
import csv
import hashlib
import json
import math
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from polismath.replay import driver as drv
from polismath.replay import prodclone as pc
from polismath.replay import real_data as rd
from polismath.replay import schedule as sched
from polismath.replay.crosslang import canonicalize_blob, project_prep_main
from polismath.replay.types import ModEvent, ReplayDataset
from polismath.utils.general import postgres_vote_to_delphi
from polismath.utils.output_profile import (
    OUTPUT_PROFILE_KEY,
    PROJECTED_PROFILE,
    VOTE_AXIS_AS_EMITTED,
    VOTE_AXIS_NEGATED,
    OutputProfileError,
    assert_valid_marker,
    has_marker,
    marker,
    payload,
    stamp,
)
from polismath.utils.vote_convention import (
    STORAGE_AGREE_VALUE,
    flipped,
    semantic_vote,
    validate_storage_agree_value,
)


class PolarityError(RuntimeError):
    """The polarity property, or one of its transforms, was misused."""


# ---------------------------------------------------------------------------
# N — the vote-axis convention involution, on the PROJECTED view only.
# ---------------------------------------------------------------------------

#: Exactly the fields N negates (P-023 rev3, "Sign transformations" table).
#: Anything not named here is invariant — N is not permission to negate
#: arbitrary numeric fields.
N_NEGATED_FIELDS: tuple[str, ...] = (
    "pca.center",
    "pca.comment-projection",
    "base-clusters.x",
    "base-clusters.y",
    "group-clusters[].center",
)

#: Named INVARIANTS, checked by :func:`assert_n_invariants`. ``comps`` is
#: covariance-derived and ``comment-extremity`` is a norm, so neither moves;
#: ptptstats is invariant for the non-obvious reason recorded in the contract
#: (extremeness is a dot product of ``(position - center)`` with the direction
#: ``(center - global_center)/norm``, and BOTH vectors co-negate — a claim that
#: would break if that direction were ever re-derived from ``comps``).
N_INVARIANT_FIELDS: tuple[str, ...] = (
    "pca.comps",
    "pca.comment-extremity",
    "n",
    "n-cmts",
    "tids",
    "in-conv",
    "repness",
    "consensus",
    "group-votes",
    "votes-base",
    "user-vote-counts",
    "comment-priorities",
    "group-aware-consensus",
    "group-clusters[].id",
    "group-clusters[].members",
    "base-clusters.id",
    "base-clusters.members",
    "base-clusters.count",
)

#: Raw extensions that MUST already be gone when N runs. Their presence means
#: the caller is holding a raw blob, not a projected comparison view — the
#: exact mistake that would break C9's sign relation (the twin) or leave an
#: internally inconsistent geometry (``proj`` un-negated beside a flipped PCA).
N_FORBIDDEN_RAW_KEYS: tuple[str, ...] = ("group_clusters", "proj")


def _negate_numbers(value: Any, where: str) -> Any:
    """Negate every number under ``value``, preserving structure. Non-finite
    and non-numeric leaves are a failure, not something to skip: N is defined
    on finite coordinates only."""
    if isinstance(value, bool):
        raise PolarityError(f"N: {where} is a bool, not a coordinate")
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise PolarityError(f"N: {where} is non-finite ({value!r})")
        return -value
    if isinstance(value, list):
        return [_negate_numbers(v, f"{where}[{i}]") for i, v in enumerate(value)]
    raise PolarityError(
        f"N: {where} must be a number or a nested list of numbers, got "
        f"{type(value).__name__}")


def comparison_view(
    blob: dict[str, Any], *,
    project: Callable[[dict[str, Any]], dict[str, Any]] = project_prep_main,
    canonicalize: Callable[[dict[str, Any]], dict[str, Any]] | None = canonicalize_blob,
    vote_axis: str = VOTE_AXIS_AS_EMITTED,
) -> dict[str, Any]:
    """Project a RAW validated blob onto the comparison view and MARK it.

    The ordering rev3 fixes is: raw validation (including C9 and the raw
    extensions) -> project ``PREP_MAIN_KEYS`` -> optional declared N ->
    independent PCA orientation/alignment -> compare. This is step two, and the
    marker it stamps is what makes step three's misuse control non-vacuous: the
    projected view is a *legal* kebab-only blob that the raw schema gate would
    happily accept and ``from_dict`` would silently restore with no groups.

    ``project`` is injectable so the certification battery can pass its own
    acceptance projection (prep-main minus the dead subgroup-* trio) without
    this module importing the battery.
    """
    view = project(blob)
    if canonicalize is not None:
        view = canonicalize(view)
    return stamp(view, marker(profile=PROJECTED_PROFILE, vote_axis=vote_axis))


def vote_axis_involution(view: dict[str, Any]) -> dict[str, Any]:
    """N. Returns a NEW view with exactly :data:`N_NEGATED_FIELDS` negated.

    Refuses anything but a marked projected view — N "is never a raw serializer
    or restore transform" — and refuses a view that still carries a raw
    extension from :data:`N_FORBIDDEN_RAW_KEYS`. Absent fields are skipped (an
    empty checkpoint has no ``pca``), present-but-malformed fields fail.

    The marker's ``vote_axis`` toggles, so ``N(N(view)) == view`` EXACTLY,
    marker included: N is its own inverse, and the view always says which axis
    it is currently on, independently of the input storage sign.
    """
    # The COMPARISON boundary validates the marker's own values, not merely its
    # presence (review #2730 F2): an unknown profile or axis is a
    # corrupted view, and N must not translate one.
    if not has_marker(view):
        raise PolarityError(
            "N is defined strictly on the validated, PROJECTED PREP_MAIN_KEYS "
            "comparison view (P-023 rev3). This blob carries no output-profile "
            f"marker ({OUTPUT_PROFILE_KEY!r}); build it with comparison_view() "
            "first. Applying N to a raw blob would break C9's producer sign "
            "relation on the group_clusters twin and corrupt the restore path.")
    try:
        assert_valid_marker(view, label="N")
    except OutputProfileError as exc:
        raise PolarityError(str(exc)) from exc
    present = [k for k in N_FORBIDDEN_RAW_KEYS if k in view]
    if present:
        raise PolarityError(
            f"N refuses a view still carrying the raw extension(s) {present}: "
            "the projection must drop the group_clusters twin and proj BEFORE "
            "N runs, which is exactly what keeps C9 and from_dict safe")

    out = copy.deepcopy(view)

    pca = out.get("pca")
    if isinstance(pca, dict):
        for key in ("center", "comment-projection"):
            if key in pca:
                pca[key] = _negate_numbers(pca[key], f"pca.{key}")
    elif pca is not None:
        raise PolarityError(f"N: 'pca' must be an object, got {type(pca).__name__}")

    bc = out.get("base-clusters")
    if isinstance(bc, dict):
        for key in ("x", "y"):
            if key in bc:
                bc[key] = _negate_numbers(bc[key], f"base-clusters.{key}")
    elif bc is not None:
        raise PolarityError(
            f"N: 'base-clusters' must be an object, got {type(bc).__name__}")

    gc = out.get("group-clusters")
    if isinstance(gc, list):
        for i, group in enumerate(gc):
            if not isinstance(group, dict):
                raise PolarityError(
                    f"N: group-clusters[{i}] must be an object, got "
                    f"{type(group).__name__}")
            if "center" in group:
                group["center"] = _negate_numbers(
                    group["center"], f"group-clusters[{i}].center")
    elif gc is not None:
        raise PolarityError(
            f"N: 'group-clusters' must be an array, got {type(gc).__name__}")

    old = out[OUTPUT_PROFILE_KEY]
    transforms = list(old.get("transforms", []))
    if transforms and transforms[-1] == "N":
        transforms.pop()
    else:
        transforms.append("N")
    out[OUTPUT_PROFILE_KEY] = marker(
        profile=old.get("profile", PROJECTED_PROFILE),
        vote_axis=(VOTE_AXIS_NEGATED if old.get("vote_axis") == VOTE_AXIS_AS_EMITTED
                   else VOTE_AXIS_AS_EMITTED),
        transforms=tuple(transforms),
    )
    return out


def _dig(view: dict[str, Any], path: str) -> Any:
    """Read one :data:`N_INVARIANT_FIELDS`-style path out of a view. ``[]``
    marks a per-element read: ``group-clusters[].id`` -> the list of ids."""
    if "[]" in path:
        head, _, tail = path.partition("[].")
        seq = view.get(head)
        if not isinstance(seq, list):
            return None
        return [g.get(tail) if isinstance(g, dict) else None for g in seq]
    node: Any = view
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def assert_n_invariants(view: dict[str, Any], n_view: dict[str, Any]) -> None:
    """Every field N must NOT move is byte-equal across the pair. The
    complementary direction (the negated set actually moved) is deliberately
    NOT asserted here: an all-zero or empty geometry is a legitimate degenerate
    checkpoint that no sign change can move, and ``-0.0 == 0.0``."""
    for path in N_INVARIANT_FIELDS:
        before, after = _dig(view, path), _dig(n_view, path)
        if before != after:
            raise PolarityError(
                f"N changed the invariant field {path!r}: {before!r} -> {after!r}")


# ---------------------------------------------------------------------------
# Convention descriptors — what a run/cache entry declares about polarity.
# ---------------------------------------------------------------------------

#: What an export/replay votes CSV carries: SEMANTIC votes (agree = +1). It is
#: a tagged format whose convention does not move with storage.
INPUT_CONVENTION_EXPORT_SEMANTIC = "export-semantic/1"
#: What a raw DB row carries: the declared storage sign.
INPUT_CONVENTION_RAW_STORAGE = "raw-storage/1"
#: The engine's own output vote axis, declared independently of the input sign.
OUTPUT_CONVENTION_AS_EMITTED = "engine-as-emitted/1"

PAIR_SIDE_ORIGINAL = "original"
PAIR_SIDE_FLIPPED = "flipped"

#: Closed enums. "Unknown convention fails admission" (P-023 rev3) is a
#: predicate, not a sentiment: a truthiness check accepted `unknown-input/99`
#: (review #2730 F2).
INPUT_CONVENTIONS: frozenset[str] = frozenset(
    {INPUT_CONVENTION_EXPORT_SEMANTIC, INPUT_CONVENTION_RAW_STORAGE})
OUTPUT_CONVENTIONS: frozenset[str] = frozenset({OUTPUT_CONVENTION_AS_EMITTED})
PAIR_SIDES: frozenset[str] = frozenset({PAIR_SIDE_ORIGINAL, PAIR_SIDE_FLIPPED})


@dataclass(frozen=True)
class ConventionDescriptor:
    """The polarity identity of one execution. Every field belongs in the
    recording-cache predicate: P-023's mandatory "change s without votes"
    control is a CACHE HIT unless the declared convention is part of the key,
    and a documentation-only key change is explicitly insufficient."""

    storage_agree_value: int = STORAGE_AGREE_VALUE
    input_convention: str = INPUT_CONVENTION_EXPORT_SEMANTIC
    output_convention: str = OUTPUT_CONVENTION_AS_EMITTED
    pair_side: str = PAIR_SIDE_ORIGINAL

    def __post_init__(self) -> None:
        validate_storage_agree_value(self.storage_agree_value)
        # TYPE before membership (review #2730 R2-F2): a container-valued
        # convention or side raised a raw `TypeError: unhashable type` out of
        # the set test instead of the named PolarityError this contract
        # promises. A container is not a convention token.
        for field, value, allowed in (
            ("pair side", self.pair_side, PAIR_SIDES),
            ("input convention", self.input_convention, INPUT_CONVENTIONS),
            ("output convention", self.output_convention, OUTPUT_CONVENTIONS),
        ):
            if not isinstance(value, str) or value not in allowed:
                raise PolarityError(
                    f"{field} {value!r} ({type(value).__name__}) is not one of "
                    f"{sorted(allowed)}: an unknown convention fails admission")

    def cache_fields(self) -> dict[str, Any]:
        return {
            "storage_agree_value": self.storage_agree_value,
            "input_convention": self.input_convention,
            "output_convention": self.output_convention,
            "pair_side": self.pair_side,
        }

    def flip(self) -> "ConventionDescriptor":
        return ConventionDescriptor(
            storage_agree_value=flipped(self.storage_agree_value),
            input_convention=self.input_convention,
            output_convention=self.output_convention,
            pair_side=(PAIR_SIDE_FLIPPED if self.pair_side == PAIR_SIDE_ORIGINAL
                       else PAIR_SIDE_ORIGINAL),
        )


DEFAULT_CONVENTIONS = ConventionDescriptor()


# ---------------------------------------------------------------------------
# T — the input transform, and the two real ingress paths.
# ---------------------------------------------------------------------------

#: A raw vote row, as extracted: everything but ``vote`` is identity/order.
RAW_ROW_KEYS = ("tid", "pid", "vote", "created")

INGRESS_EXPORT_CSV = "export-csv"
INGRESS_DB_ROWS = "db-rows"
INGRESS_PATHS = (INGRESS_EXPORT_CSV, INGRESS_DB_ROWS)


def flip_raw_votes(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """``V -> -V``: negate every NON-NULL raw vote leaf and change nothing
    else. NULL stays NULL (it is a distinct storage state, not a pass), ``0``
    stays the literal ``0``, and identities, ordinals, timestamps and row order
    are untouched — re-sorting by raw sign would change the winner at equal
    timestamps, which is a negative control, not a transform."""
    out = []
    for row in rows:
        new = dict(row)
        if row.get("vote") is not None:
            new["vote"] = -row["vote"]
        out.append(new)
    return out


def _export_csv_ingress(
    rows: Sequence[dict[str, Any]], s: int, *, workdir: Path,
    mod_events: Sequence[ModEvent] = (), double_convert: bool = False,
) -> tuple[ReplayDataset, str]:
    """The REAL export-CSV ingress: raw rows -> ``prodclone.format_votes_rows``
    (the one boundary that reads the declared ``s``) -> a votes CSV on disk ->
    ``real_data.load_votes_csv``. Returns ``(dataset, csv_sha256)``.

    ``double_convert=True`` is the "double-negate ingress" negative control: it
    runs the storage->semantic conversion twice, exactly as a migration that
    converted at two boundaries would.

    NULL votes are dropped and COUNTED before formatting — the declared
    ``drop-counted`` compatibility policy (``fixture_extract``), never a
    coercion to pass — and the count is bound into the returned digest so a
    NULL that silently became a row cannot hash equal to one that did not.
    """
    staged = [r for r in rows if r.get("vote") is not None]
    null_dropped = len(rows) - len(staged)
    if double_convert:
        staged = [
            {**r, "vote": (None if r.get("vote") is None
                           else semantic_vote(r["vote"], s))}
            for r in staged
        ]
    export_rows = pc.format_votes_rows(staged, storage_agree_value=s)
    path = workdir / "votes.csv"
    pc.write_votes_csv(path, export_rows)
    dataset = rd.load_votes_csv(path, mod_events=list(mod_events))
    digest = hashlib.sha256(
        path.read_bytes() + f"\nnull_votes_dropped={null_dropped}".encode()
    ).hexdigest()
    return dataset, digest


def _db_rows_ingress(
    rows: Sequence[dict[str, Any]], s: int, *, workdir: Path,
    mod_events: Sequence[ModEvent] = (), double_convert: bool = False,
) -> tuple[ReplayDataset, str]:
    """The REAL poller ingress: raw rows -> ``postgres_vote_to_delphi`` (the
    converter ``database/postgres.py`` calls per row) -> the dataset the driver
    folds. Deliberately a SECOND ingress path: a bug fixed at the CSV boundary
    but not at the DB boundary must still fail the property."""
    raw: list[tuple[int, int, int, int]] = []
    for r in rows:
        if r.get("vote") is None:
            # G's v1 computing profile: reject NULL with INVALID_INPUT BEFORE
            # any mutation. A paired rejection is an invalid-input control, not
            # a successful math checkpoint.
            raise PolarityError(
                f"INVALID_INPUT: NULL vote at (pid={r.get('pid')}, "
                f"tid={r.get('tid')}, created={r.get('created')}); the computing "
                f"ingress rejects NULL before mutation and never reads it as pass")
        vote = postgres_vote_to_delphi(int(r["vote"]), s)
        if double_convert:
            vote = postgres_vote_to_delphi(int(vote), s)
        raw.append((int(r["created"]), int(r["pid"]), int(r["tid"]), int(vote)))
    dataset = ReplayDataset.build(raw, mod_events=list(mod_events))
    digest = hashlib.sha256(
        json.dumps(raw, separators=(",", ":")).encode()).hexdigest()
    return dataset, digest


_INGRESS = {
    INGRESS_EXPORT_CSV: _export_csv_ingress,
    INGRESS_DB_ROWS: _db_rows_ingress,
}


# ---------------------------------------------------------------------------
# The negative controls. Each one must reach the property's gate and FAIL for
# its named reason — never fail setup and never collect zero comparisons.
# ---------------------------------------------------------------------------

CONTROL_NONE = "none"
CONTROL_VOTES_ONLY = "negate-votes-without-s"
CONTROL_CONVENTION_ONLY = "change-s-without-votes"
CONTROL_DOUBLE_NEGATION = "double-negate-ingress"
CONTROL_ONE_VOTE_UNCHANGED = "leave-one-vote-unchanged"
CONTROL_NULL_TO_PASS = "null-becomes-pass"
CONTROL_RESORT_BY_SIGN = "resort-equal-time-by-sign"

CONTROLS: tuple[str, ...] = (
    CONTROL_NONE, CONTROL_VOTES_ONLY, CONTROL_CONVENTION_ONLY,
    CONTROL_DOUBLE_NEGATION, CONTROL_ONE_VOTE_UNCHANGED, CONTROL_NULL_TO_PASS,
    CONTROL_RESORT_BY_SIGN,
)

#: Controls that MUST fail. ``CONTROL_NONE`` is the property itself.
FAILING_CONTROLS: tuple[str, ...] = tuple(c for c in CONTROLS if c != CONTROL_NONE)


def _apply_control(
    rows: Sequence[dict[str, Any]], s: int, control: str,
) -> tuple[list[dict[str, Any]], int, str | None]:
    """Build the FLIPPED side under ``control``. Returns
    ``(rows_b, s_b, double_convert_side)`` where the third element names the
    side whose ingress converts twice (``None`` for every other control).

    Which side ``double-negate-ingress`` must break depends on the DECLARED
    convention, and getting it wrong makes the control vacuous (review
    #2730 F4). A double conversion is arithmetically the identity
    (``s**2 == 1``), so a doubly-converted side emits raw ``V`` while the
    correct side emits ``V x s``: the two differ only when ``s == -1``.
    Breaking the side that declares ``-1`` is therefore the non-degenerate
    choice under BOTH declarations — the original side at ``s == -1``, the
    flipped side at ``s == +1`` — and it is the same fault either way: one
    ingress converted twice.
    """
    if control == CONTROL_NONE:
        return flip_raw_votes(rows), flipped(s), None
    if control == CONTROL_VOTES_ONLY:
        # Votes negated, convention NOT re-declared: the semantic meaning of
        # every nonzero vote inverts.
        return flip_raw_votes(rows), s, None
    if control == CONTROL_CONVENTION_ONLY:
        # The convention alone changes. Same votes file — which is precisely
        # why the recording cache must key on the declared convention, or this
        # control silently reads a stale recording instead of executing.
        return list(rows), flipped(s), None
    if control == CONTROL_DOUBLE_NEGATION:
        # Break whichever side declares -1.
        side = PAIR_SIDE_ORIGINAL if s == -1 else PAIR_SIDE_FLIPPED
        return flip_raw_votes(rows), flipped(s), side
    if control == CONTROL_ONE_VOTE_UNCHANGED:
        out = flip_raw_votes(rows)
        for i, row in enumerate(rows):
            if row.get("vote"):
                out[i] = dict(row)
                break
        else:
            raise PolarityError(
                f"control {control!r} needs at least one nonzero vote in the "
                "fixture; it must reach the gate, not fail setup")
        return out, flipped(s), None
    if control == CONTROL_NULL_TO_PASS:
        out = flip_raw_votes(rows)
        for i, row in enumerate(rows):
            if row.get("vote") is None:
                out[i] = {**row, "vote": 0}
                break
        else:
            raise PolarityError(
                f"control {control!r} needs at least one NULL vote in the "
                "fixture; it must reach the gate, not fail setup")
        return out, flipped(s), None
    if control == CONTROL_RESORT_BY_SIGN:
        out = flip_raw_votes(rows)
        # Re-sort by (created, raw sign) — the "improvement" P-023 forbids.
        # With an equal-time opposing pair this changes the winning cell on one
        # side only, because the raw signs are opposite across the pair.
        out = sorted(out, key=lambda r: (r["created"], r["vote"] is None,
                                         r["vote"] if r["vote"] is not None else 0))
        return out, flipped(s), None
    raise PolarityError(f"unknown control {control!r}")


# ---------------------------------------------------------------------------
# The property.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PolarityCase:
    """One (fixture, schedule) the property must hold on."""

    case_id: str
    rows: tuple[dict[str, Any], ...]
    cuts: dict[str, Any]
    mod_events: tuple[ModEvent, ...] = ()
    restart_after: int | None = None
    notes: str = ""

    def spec(self) -> sched.ScheduleSpec:
        return sched.ScheduleSpec(
            dataset=self.case_id,
            schedule_id=f"{self.case_id}-polarity",
            cuts=dict(self.cuts),
            moderation=("none" if not self.mod_events else [
                {"tid": m.tid, "is_meta": m.is_meta, "mod": m.mod,
                 "t_ms": m.t_ms} for m in self.mod_events]),
            restart_after=self.restart_after,
            notes=self.notes,
        )


def _run_side(
    case: PolarityCase, rows: Sequence[dict[str, Any]], s: int, *,
    ingress: str, workdir: Path, double_convert: bool,
    project: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    """Execute ONE side from fresh state and return its recorded identity plus
    the marked comparison view of every checkpoint. Each side gets its own
    working directory and its own run id: equal semantic inputs are not
    permission to reuse the other side's artifact."""
    ingest = _INGRESS[ingress]
    dataset, input_digest = ingest(
        rows, s, workdir=workdir, mod_events=case.mod_events,
        double_convert=double_convert)
    records = drv.run_replay(dataset, case.spec())
    views = [comparison_view(r.blob, project=project) for r in records]
    return {
        "run_id": uuid.uuid4().hex,
        "storage_agree_value": s,
        "ingress": ingress,
        "input_digest_sha256": input_digest,
        "n_votes": dataset.n,
        "views": views,
        "view_digests": [
            hashlib.sha256(json.dumps(payload(v), sort_keys=True,
                                      separators=(",", ":")).encode()).hexdigest()
            for v in views
        ],
    }


def _first_difference(a: Any, b: Any, path: str = "") -> str | None:
    """Dotted path of the first structural/value difference, or None."""
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                return f"{path}.{k} (missing on the original side)"
            if k not in b:
                return f"{path}.{k} (missing on the flipped side)"
            found = _first_difference(a[k], b[k], f"{path}.{k}")
            if found is not None:
                return found
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path} (length {len(a)} vs {len(b)})"
        for i, (x, y) in enumerate(zip(a, b)):
            found = _first_difference(x, y, f"{path}[{i}]")
            if found is not None:
                return found
        return None
    if type(a) is not type(b) or a != b:
        return f"{path} ({a!r} vs {b!r})"
    return None


def check_polarity_pair(
    case: PolarityCase, *,
    storage_agree_value: int = STORAGE_AGREE_VALUE,
    ingress: str = INGRESS_EXPORT_CSV,
    control: str = CONTROL_NONE,
    project: Callable[[dict[str, Any]], dict[str, Any]] = project_prep_main,
    workdir: Path | None = None,
) -> dict[str, Any]:
    """Execute the compensated pair for ONE case and return a verdict dict.

    ``verdict`` is ``PASS`` when every checkpoint of ``E(V, s)`` equals the
    corresponding checkpoint of ``E(-V, -s)`` under the projected comparison
    profile, ``FAIL`` otherwise. A case that produced ZERO checkpoints is a
    FAIL, never an empty PASS — an inventory that certifies nothing is the
    failure mode the whole battery exists to prevent.

    No N is applied: both sides declare the same output convention, so rev3
    forbids an extra N here. ``control`` injects one of :data:`CONTROLS`; every
    control but ``none`` must come back FAIL.
    """
    s = validate_storage_agree_value(storage_agree_value)
    if ingress not in _INGRESS:
        raise PolarityError(f"unknown ingress path {ingress!r}")
    rows_b, s_b, double_side = _apply_control(case.rows, s, control)

    with tempfile.TemporaryDirectory(dir=workdir) as tmp:
        root = Path(tmp)
        (root / "a").mkdir()
        (root / "b").mkdir()
        side_a = _run_side(case, case.rows, s, ingress=ingress,
                           workdir=root / "a",
                           double_convert=double_side == PAIR_SIDE_ORIGINAL,
                           project=project)
        side_b = _run_side(case, rows_b, s_b, ingress=ingress,
                           workdir=root / "b",
                           double_convert=double_side == PAIR_SIDE_FLIPPED,
                           project=project)

    problems: list[str] = []
    if not side_a["views"]:
        problems.append("the original side produced NO checkpoint: an empty "
                        "inventory is a blocking reason, never a PASS")
    if len(side_a["views"]) != len(side_b["views"]):
        problems.append(
            f"the pair produced a different number of checkpoints "
            f"({len(side_a['views'])} vs {len(side_b['views'])})")
    if side_a["run_id"] == side_b["run_id"]:
        problems.append("both sides report the same run identity: one side's "
                        "artifact was reused instead of executed")
    for i, (va, vb) in enumerate(zip(side_a["views"], side_b["views"])):
        if va[OUTPUT_PROFILE_KEY]["vote_axis"] != vb[OUTPUT_PROFILE_KEY]["vote_axis"]:
            problems.append(
                f"step {i}: the two sides declare different output vote axes "
                f"({va[OUTPUT_PROFILE_KEY]['vote_axis']} vs "
                f"{vb[OUTPUT_PROFILE_KEY]['vote_axis']}); an unknown or "
                f"mismatched output convention fails admission")
            continue
        diff = _first_difference(payload(va), payload(vb))
        if diff is not None:
            problems.append(f"step {i}: checkpoints differ at {diff.lstrip('.')}")

    return {
        "case_id": case.case_id,
        "control": control,
        "ingress": ingress,
        "storage_agree_value": s,
        "conventions": {
            "original": ConventionDescriptor(
                storage_agree_value=s,
                input_convention=(INPUT_CONVENTION_EXPORT_SEMANTIC
                                  if ingress == INGRESS_EXPORT_CSV
                                  else INPUT_CONVENTION_RAW_STORAGE),
            ).cache_fields(),
            "flipped": ConventionDescriptor(
                storage_agree_value=s_b,
                input_convention=(INPUT_CONVENTION_EXPORT_SEMANTIC
                                  if ingress == INGRESS_EXPORT_CSV
                                  else INPUT_CONVENTION_RAW_STORAGE),
                pair_side=PAIR_SIDE_FLIPPED,
            ).cache_fields(),
        },
        "checkpoints": len(side_a["views"]),
        "run_ids": [side_a["run_id"], side_b["run_id"]],
        "input_digests": [side_a["input_digest_sha256"],
                          side_b["input_digest_sha256"]],
        "view_digests": [side_a["view_digests"], side_b["view_digests"]],
        "verdict": "PASS" if not problems else "FAIL",
        "problems": problems,
    }


# ---------------------------------------------------------------------------
# The standing case set. Small, public-fixture, deterministic and cheap enough to
# run on every certify invocation — the real-dataset pair lives in the test
# suite, and a large fixture gets the same property, not an exemption.
# ---------------------------------------------------------------------------


def _row(created: int, pid: int, tid: int, vote: int | None) -> dict[str, Any]:
    return {"created": created, "pid": pid, "tid": tid, "vote": vote}


def _grid_rows(
    n_ptpt: int = 8, n_cmt: int = 6, t0: int = 1_600_000_000_000
) -> list[dict[str, Any]]:
    """A dense, deterministic agree/disagree/pass grid with revotes."""
    rows = []
    t = t0
    for pid in range(n_ptpt):
        for tid in range(n_cmt):
            vote = (-1, 1, 0)[(pid + tid) % 3]
            rows.append(_row(t, pid, tid, vote))
            t += 1000
    # revotes: the last three participants change their mind on comment 0
    for pid in range(n_ptpt - 3, n_ptpt):
        rows.append(_row(t, pid, 0, 1))
        t += 1000
    return rows


def default_cases() -> list[PolarityCase]:
    """The mandatory shapes: normal incremental ticks, all-pass, an equal-time
    opposing pair, duplicates/revotes, and a real restart seam. Empty and
    NULL-bearing streams are exercised by the controls and the harness suite,
    where their declared rejection is the expected outcome."""
    grid = _grid_rows()
    all_pass = [_row(1_600_000_000_000 + i * 1000, i % 5, i % 4, 0)
                for i in range(24)]
    tied = []
    t = 1_600_000_000_000
    for pid in range(6):
        for tid in range(4):
            tied.append(_row(t + pid * 1000, pid, tid, (-1, 1)[(pid + tid) % 2]))
    # the equal-time opposing pair: same cell, same millisecond, opposite signs
    tied.append(_row(t + 6000, 0, 0, -1))
    tied.append(_row(t + 6000, 0, 0, 1))
    return [
        PolarityCase("polarity-grid", tuple(grid),
                     {"mode": "vote-count", "at": [12, 30, "end"]},
                     notes="normal incremental ticks over a dense grid with revotes"),
        PolarityCase("polarity-all-pass", tuple(all_pass),
                     {"mode": "vote-count", "at": [12, "end"]},
                     notes="every vote is a literal pass: invariant under T"),
        PolarityCase("polarity-equal-time", tuple(tied),
                     {"mode": "vote-count", "at": ["end"]},
                     notes="opposite votes at an equal timestamp; the frozen "
                           "order must be identical on both sides"),
        PolarityCase("polarity-restart", tuple(grid),
                     {"mode": "vote-count", "at": [12, 30, "end"]},
                     restart_after=0,
                     notes="real serialize -> from_dict -> continue seam"),
    ]


def run_standing_property(
    *, storage_agree_value: int = STORAGE_AGREE_VALUE,
    project: Callable[[dict[str, Any]], dict[str, Any]] = project_prep_main,
    cases: Sequence[PolarityCase] | None = None,
    ingress_paths: Sequence[str] = INGRESS_PATHS,
    with_controls: bool = True,
) -> dict[str, Any]:
    """Run the standing polarity property: every case, on every ingress path,
    plus every mandatory negative control on the first case of each path.

    Returns a report dict with a terminal ``verdict``. FAIL if any pair
    diverges, if any negative control PASSES (a control that does not reach its
    gate is exactly as bad as a broken engine), or if no comparison ran at all.
    """
    s = validate_storage_agree_value(storage_agree_value)
    cases = list(cases if cases is not None else default_cases())
    results: list[dict[str, Any]] = []
    control_results: list[dict[str, Any]] = []

    for ingress in ingress_paths:
        for case in cases:
            results.append(check_polarity_pair(
                case, storage_agree_value=s, ingress=ingress, project=project))
        if with_controls:
            for control in FAILING_CONTROLS:
                case = control_case(control, cases)
                if case is None:
                    continue
                if control == CONTROL_NULL_TO_PASS and ingress == INGRESS_DB_ROWS:
                    # The computing ingress rejects NULL with INVALID_INPUT
                    # before any mutation (G v1), so on this path the paired
                    # rejection is an invalid-input control rather than a math
                    # checkpoint. It is asserted as a rejection in the harness
                    # suite instead of being run as a pair here.
                    continue
                control_results.append(check_polarity_pair(
                    case, storage_agree_value=s, ingress=ingress,
                    control=control, project=project))

    problems = [
        f"{r['ingress']}/{r['case_id']}: {'; '.join(r['problems'])}"
        for r in results if r["verdict"] != "PASS"
    ]
    problems += [
        f"{r['ingress']}/{r['case_id']}: negative control {r['control']!r} "
        f"PASSED — it never reached its gate"
        for r in control_results if r["verdict"] != "FAIL"
    ]
    if not results:
        problems.append("no polarity pair executed: an empty inventory is a "
                        "blocking reason, never a PASS")

    return {
        "property": "P-023 compensated polarity pair",
        "storage_agree_value": s,
        "pairs": results,
        "controls": control_results,
        "verdict": "PASS" if not problems else "FAIL",
        "problems": problems,
    }


def control_case(
    control: str, cases: Sequence[PolarityCase] | None = None,
) -> PolarityCase | None:
    """The fixture a given negative control needs in order to REACH its gate.

    P-023: "Each control must reach the intended gate and fail for the named
    reason, not fail setup or collect zero tests." Two controls need a specific
    shape: ``null-becomes-pass`` needs a NULL vote leaf to convert, and
    ``resort-equal-time-by-sign`` needs an opposing pair at an equal timestamp
    (without one, re-sorting by sign is a no-op and the control would PASS
    while proving nothing).
    """
    cases = list(cases if cases is not None else default_cases())
    by_id = {c.case_id: c for c in cases}
    base = by_id.get("polarity-grid", cases[0])
    if control == CONTROL_NULL_TO_PASS:
        rows = list(base.rows)
        rows.append(_row(rows[-1]["created"] + 1000, 0, 0, None))
        return PolarityCase(
            f"{base.case_id}-null", tuple(rows), dict(base.cuts),
            notes="control fixture: carries a NULL vote leaf, dropped-counted "
                  "at the compatibility CSV and INVALID_INPUT at the computing "
                  "ingress")
    if control == CONTROL_RESORT_BY_SIGN:
        return by_id.get("polarity-equal-time")
    return base
