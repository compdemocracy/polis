"""Output-profile / provenance marker for a PROJECTED engine view.

P-023 rev3 ("Sign transformations are explicit and distinct", and R3-1 in the
round-3 disposition):

    Do not feed this projected/N-translated view to ``from_dict``, save it as a
    raw snapshot, or run C9 on it. […] Enforce misuse rejection with an
    explicit output-profile/provenance marker at the restore boundary:
    raw-schema validation alone accepts a projected kebab-only view and can
    silently restore an empty underscore group list.

The reason a marker is REQUIRED, and a stronger raw schema is not enough: a
projected ``PREP_MAIN_KEYS`` view is a *legal* kebab-only blob. It carries no
snake/kebab alias pair, so the declared-alias check never fires and C9 never
runs; every remaining field is well typed and finite. It passes the raw
checkpoint gate — and then ``Conversation.from_dict``'s
``data.get('group_clusters', [])`` quietly restores a conversation with NO
groups and no error anywhere. The control that "attempts the projected-to-
restore misuse" passes vacuously unless the view SAYS what it is.

So every projected view carries :data:`OUTPUT_PROFILE_KEY`, and every restore
boundary refuses a blob that carries it. The marker also states the view's
**vote-axis convention independently of the input storage sign** (rev3: "Every
descriptor must identify that output convention independently from the input
storage sign. Unknown convention fails admission"), which is what lets a
harness tell "this side needed N to reach the common profile" from "this side
was already in it" without inferring anything from ``storage_agree_value``.

The marker is deliberately NOT a kebab/snake alias of anything and never
collides with a prep-main key, so stamping it cannot shadow engine output.

This module imports nothing from ``polismath``: both the engine
(``conversation.py``, at the restore boundary) and the harness
(``replay/polarity.py``, which stamps) depend on it, and neither may depend on
the other.
"""

from __future__ import annotations

from typing import Any

#: The one marker key. Double-underscored so it can never be mistaken for an
#: engine field, and outside ``PREP_MAIN_KEYS`` so the projection would drop it
#: rather than carry it into a raw comparison by accident.
OUTPUT_PROFILE_KEY = "__output_profile__"

#: The projected comparison view: ``project_prep_main`` (+ the acceptance
#: exclusions) applied to a validated raw blob. NOT a serialization.
PROJECTED_PROFILE = "polis-prep-main-projected/1"

#: Vote-axis convention of a view. ``as-emitted`` is the producer's own axis;
#: ``negated`` is that axis after the declared involution N. These name the
#: OUTPUT convention; they say nothing about the input storage sign.
VOTE_AXIS_AS_EMITTED = "as-emitted"
VOTE_AXIS_NEGATED = "negated"

#: Closed enums. A marker is a DECLARATION inside a gate, so every value is
#: checked against the set of reviewed tokens; an unknown profile, axis or
#: transform name is a malformed marker, not a new feature.
PROFILES: frozenset[str] = frozenset({PROJECTED_PROFILE})
VOTE_AXES: frozenset[str] = frozenset({VOTE_AXIS_AS_EMITTED, VOTE_AXIS_NEGATED})
TRANSFORMS: frozenset[str] = frozenset({"project_prep_main", "N"})

#: Closed key set of the marker value itself.
MARKER_KEYS: frozenset[str] = frozenset(
    {"profile", "restorable", "vote_axis", "transforms"})


class OutputProfileError(ValueError):
    """A marked (projected/N-translated) view reached a boundary that requires
    a complete raw engine serialization."""


def marker(
    *, profile: str = PROJECTED_PROFILE, vote_axis: str = VOTE_AXIS_AS_EMITTED,
    transforms: tuple[str, ...] = ("project_prep_main",),
) -> dict[str, Any]:
    """The marker value: what this view IS, how it got here, and the one fact
    every boundary reads — ``restorable: False``."""
    return {
        "profile": profile,
        "restorable": False,
        "vote_axis": vote_axis,
        "transforms": list(transforms),
    }


def stamp(view: dict[str, Any], marker_value: dict[str, Any]) -> dict[str, Any]:
    """Return ``view`` with the marker attached (mutates and returns, so a
    caller cannot accidentally publish the unmarked copy it just built)."""
    view[OUTPUT_PROFILE_KEY] = marker_value
    return view


def has_marker(blob: Any) -> bool:
    """True iff the reserved key is PRESENT, whatever its value.

    The distinction matters at a gate (review #2730 F2): a guard that
    only reacts to a well-formed dict treats ``{"__output_profile__": null}``,
    ``false``, a string or an array as unmarked raw data — so replacing a valid
    marker with any garbage walked a projected view straight through both
    restore boundaries. Malformed provenance is not the absence of provenance.
    """
    return isinstance(blob, dict) and OUTPUT_PROFILE_KEY in blob


def marker_problems(value: Any) -> list[str]:
    """Everything wrong with a marker VALUE, or an empty list. Closed schema:
    a dict with exactly :data:`MARKER_KEYS`, a reviewed profile token, a
    reviewed vote axis, ``restorable`` the literal boolean ``False``, and a
    list of reviewed transform names."""
    if not isinstance(value, dict):
        return [f"marker must be a JSON object, got {type(value).__name__}"]
    problems: list[str] = []
    for missing in sorted(MARKER_KEYS - set(value)):
        problems.append(f"marker is missing {missing!r}")
    for unknown in sorted(set(value) - MARKER_KEYS):
        problems.append(f"marker carries unknown field {unknown!r}")
    # TYPE before membership at every lookup (review #2730 R2-F2): an
    # unhashable value (`profile: []`, `vote_axis: {}`) raised a raw
    # `TypeError: unhashable type` out of the set test, escaping every gate
    # that promised a named, graded failure. A container is simply not a token.
    profile = value.get("profile")
    if not isinstance(profile, str) or profile not in PROFILES:
        problems.append(
            f"marker profile {profile!r} ({type(profile).__name__}) is not one "
            f"of {sorted(PROFILES)}")
    vote_axis = value.get("vote_axis")
    if not isinstance(vote_axis, str) or vote_axis not in VOTE_AXES:
        problems.append(
            f"marker vote_axis {vote_axis!r} ({type(vote_axis).__name__}) is "
            f"not one of {sorted(VOTE_AXES)}")
    restorable = value.get("restorable")
    if type(restorable) is not bool or restorable is not False:
        problems.append(
            f"marker restorable must be the boolean False, got "
            f"{type(restorable).__name__} {restorable!r}")
    transforms = value.get("transforms")
    if not isinstance(transforms, list) or not transforms:
        problems.append(
            f"marker transforms must be a non-empty array, got "
            f"{type(transforms).__name__}")
    else:
        for i, name in enumerate(transforms):
            if not isinstance(name, str) or name not in TRANSFORMS:
                problems.append(
                    f"marker transforms[{i}] is {name!r} "
                    f"({type(name).__name__}), not one of {sorted(TRANSFORMS)}")
    return problems


def profile_of(blob: Any) -> dict[str, Any] | None:
    """The VALID marker on ``blob``, or ``None``.

    ``None`` here means "no well-formed marker" and covers both an unmarked raw
    blob and a corrupted one, so it is never the right thing for a gate to key
    on by itself — use :func:`has_marker` for presence and
    :func:`marker_problems` for validity.
    """
    if not has_marker(blob):
        return None
    found = blob[OUTPUT_PROFILE_KEY]
    return found if not marker_problems(found) else None


def is_projected_view(blob: Any) -> bool:
    """True iff ``blob`` carries a WELL-FORMED projected-view marker."""
    return profile_of(blob) is not None


def assert_valid_marker(blob: Any, *, label: str = "comparison view") -> dict[str, Any]:
    """The COMPARISON-boundary check: the view must carry a marker and that
    marker must satisfy the closed schema. Returns it."""
    if not has_marker(blob):
        raise OutputProfileError(
            f"{label}: no {OUTPUT_PROFILE_KEY!r} marker; a projected view must "
            f"declare its output profile and vote axis")
    problems = marker_problems(blob[OUTPUT_PROFILE_KEY])
    if problems:
        raise OutputProfileError(
            f"{label}: malformed {OUTPUT_PROFILE_KEY!r} marker — "
            + "; ".join(problems))
    return blob[OUTPUT_PROFILE_KEY]


def payload(view: dict[str, Any]) -> dict[str, Any]:
    """The view WITHOUT its marker — what an equality comparison runs on. The
    marker is provenance about the view, not a computed engine value, so it is
    compared separately (both sides must declare the same vote axis) rather
    than folded into the payload hash."""
    return {k: v for k, v in view.items() if k != OUTPUT_PROFILE_KEY}


def assert_restorable(blob: Any, *, label: str = "restore") -> None:
    """The RESTORE-BOUNDARY guard (P-023 rev3 R3-1). Raises
    :class:`OutputProfileError` when a projected/N-translated view is handed to
    a path that must consume the original complete, validated raw engine
    serialization.

    Fails closed on PRESENCE, not on validity: a malformed marker value is a
    corrupted or hand-edited projected view, which is exactly the thing that
    must not be restored (review #2730 F2). An unmarked raw blob — every
    blob any producer actually emits — passes without inspection.
    """
    if not has_marker(blob):
        return
    found = blob[OUTPUT_PROFILE_KEY]
    problems = marker_problems(found)
    if problems:
        raise OutputProfileError(
            f"{label}: this blob carries a MALFORMED output-profile marker "
            f"{OUTPUT_PROFILE_KEY!r} ({'; '.join(problems)}). The reserved key "
            f"is rejected whenever it is present: malformed provenance is not "
            f"the absence of provenance, and restore consumes only an original "
            f"complete raw engine serialization.")
    raise OutputProfileError(
        f"{label}: this blob carries the output-profile marker "
        f"{OUTPUT_PROFILE_KEY!r} ({found.get('profile')!r}, vote_axis "
        f"{found.get('vote_axis')!r}, transforms {found.get('transforms')!r}): "
        f"it is a PROJECTED comparison view, not a restorable engine "
        f"serialization. Restore consumes the original complete raw blob plus "
        f"its declared input convention/epoch; a projected view has already "
        f"lost the raw extensions (group_clusters, proj) that restore reads, "
        f"and would silently rebuild an empty group list.")
