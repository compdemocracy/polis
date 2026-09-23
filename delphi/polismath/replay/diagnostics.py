"""Closed comparison context, independent of private diagnostic paths."""

FAMILIES = ("projection", "clusters", "repness", "moderation", "meta")
KINDS = ("numeric-tolerance", "strict-tolerance", "exact-value", "shape", "nonfinite")
MAGNITUDES = ("over1-to2", "over2-to10", "over10", "not-applicable")
TOP_FAMILIES = {
    **dict.fromkeys(("pca",), "projection"),
    **dict.fromkeys(("base-clusters", "group-clusters", "group-votes", "votes-base"), "clusters"),
    **dict.fromkeys(("comment-priorities", "consensus", "group-aware-consensus", "repness"), "repness"),
    **dict.fromkeys(("meta-tids", "mod-in", "mod-out"), "moderation"),
    **dict.fromkeys(("in-conv", "lastModTimestamp", "lastVoteTimestamp", "n", "n-cmts",
                     "tids", "user-vote-counts", "zid"), "meta"),
}
# Child fields with a different family from their container. Dynamic member
# keys inherit their already admitted container's context and never get parsed.
CHILD_FAMILIES = {
    **dict.fromkeys(("pca", "comps", "comment-projection", "proj", "projections",
                     "base-clusters-proj", "center", "comment-extremity", "x", "y"), "projection"),
    **dict.fromkeys(("last-k", "last-k-count", "smoothed-k", "base-clusters-weights",
                     "bucket-dists", "bid-to-pid"), "clusters"),
    **dict.fromkeys(("mod-in", "mod-out", "meta-tids", "is-meta"), "moderation"),
}


class DiagnosticContextError(ValueError):
    pass


def child_family(parent, key):
    if parent is None:
        # An added acceptance key must remain comparable before its reporting
        # family is named. Never export that key or change its comparison rule.
        return TOP_FAMILIES.get(key, "meta")
    if parent not in FAMILIES:
        return "meta"
    return CHILD_FAMILIES.get(key, parent)


def ordered(rows):
    """Deduplicate in the published enum order; accept only closed tuples."""
    result = set()
    for row in rows:
        if type(row) is not dict or set(row) != {"checkpoint", "family", "kind", "magnitude"}:
            raise ValueError("DIAGNOSTIC_SCHEMA")
        c, f, k, m = (row[x] for x in ("checkpoint", "family", "kind", "magnitude"))
        if (type(c) is not int or c < 0 or f not in FAMILIES or k not in KINDS
                or m not in MAGNITUDES or ((k == "numeric-tolerance") != (m != "not-applicable"))):
            raise ValueError("DIAGNOSTIC_SCHEMA")
        result.add((c, f, k, m))
    return [dict(zip(("checkpoint", "family", "kind", "magnitude"), row)) for row in
            sorted(result, key=lambda r: (r[0], FAMILIES.index(r[1]), KINDS.index(r[2]), MAGNITUDES.index(r[3])))]
