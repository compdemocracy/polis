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


def profile_of(blob: Any) -> dict[str, Any] | None:
    """The marker on ``blob``, or ``None`` for an unmarked (raw) blob."""
    if isinstance(blob, dict):
        found = blob.get(OUTPUT_PROFILE_KEY)
        if isinstance(found, dict):
            return found
    return None


def is_projected_view(blob: Any) -> bool:
    """True iff ``blob`` declares itself a projected (non-restorable) view."""
    return profile_of(blob) is not None


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

    Cheap and total: an unmarked raw blob — every blob any producer actually
    emits — passes without inspection.
    """
    found = profile_of(blob)
    if found is None:
        return
    raise OutputProfileError(
        f"{label}: this blob carries the output-profile marker "
        f"{OUTPUT_PROFILE_KEY!r} ({found.get('profile')!r}, vote_axis "
        f"{found.get('vote_axis')!r}, transforms {found.get('transforms')!r}): "
        f"it is a PROJECTED comparison view, not a restorable engine "
        f"serialization. Restore consumes the original complete raw blob plus "
        f"its declared input convention/epoch; a projected view has already "
        f"lost the raw extensions (group_clusters, proj) that restore reads, "
        f"and would silently rebuild an empty group list.")
