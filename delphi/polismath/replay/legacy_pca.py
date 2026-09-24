"""Acceptance boundary for the observed, nonreproducible legacy PCA restart.

Only the verifier supplies the onset, from admitted private attribution rows.
Raw/schema admission must precede this comparison-only reconciliation. Neither
recordings nor engine state are modified. See images/LEGACY_PCA_POLICY.md.
"""
from copy import deepcopy

NAME = "legacy-defect-pca-random-restart"
STARTS = frozenset({"zero-fallback", "missing-fallback"})
PCA_KEYS = frozenset({"comps", "comment-projection", "comment-extremity"})
DOWNSTREAM_KEYS = frozenset({
    "base-clusters", "group-clusters", "votes-base", "group-votes",
    "repness", "group-aware-consensus", "comment-priorities",
})
PATHS = sorted(DOWNSTREAM_KEYS | {"pca." + key for key in PCA_KEYS})


def restart_checkpoint(rows):
    """Use the complete verifier observations, before receipt truncation."""
    return next((row["checkpoint"] for row in rows
                 if any(kind in STARTS for kind in row["legacy_starts"])), None)


def active(checkpoint, onset):
    return type(onset) is int and 0 <= onset <= checkpoint


def _numeric_shape(value):
    # Preserve geometry dimensions and reject nonnumeric leaves. Finiteness
    # and the full typed contract are checked on the original blobs upstream.
    if type(value) in (int, float):
        return ('number',)
    if type(value) is list:
        children = [_numeric_shape(v) for v in value]
        if all(c is not None for c in children):
            return ('list', tuple(children))
    return None


def reconcile(left, right):
    """Compare the reproducible complement; preserve field inventories.

    Copy only shared fields. Missing keys, unrelated PCA fields (in particular
    the center), and geometry dimension/type differences remain comparable.
    Downstream cluster cardinalities/identities may legitimately differ.
    """
    result = deepcopy(right)
    for key in DOWNSTREAM_KEYS & left.keys() & right.keys():
        result[key] = deepcopy(left[key])
    a, b = left.get("pca"), right.get("pca")
    if type(a) is dict and type(b) is dict:
        for key in PCA_KEYS & a.keys() & b.keys():
            shape = _numeric_shape(a[key])
            if shape is not None and shape == _numeric_shape(b[key]):
                result["pca"][key] = deepcopy(a[key])
    return left, result
