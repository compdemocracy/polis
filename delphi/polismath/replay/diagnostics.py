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


# One fixed detail field: root plus typed representative site where applicable.
DETAILS = ("other", "representatives", "representatives-member-set",
           "representatives-record-keys", "representatives-list-shape",
           "representatives-direction", "representatives-counts", "representatives-scores",
           "consensus", "group-consensus", "priorities", "components", "centering",
           "comment-coordinates", "participant-coordinates", "group-centers", "extremities")
DETAIL_FAMILIES = {**dict.fromkeys(DETAILS[1:11], "repness"),
                   **dict.fromkeys(DETAILS[11:], "projection")}
ROW_KEYS = ("checkpoint", "family", "detail", "kind", "magnitude")


def child_context(parent, key):
    """Advance a schema node, never a private path or dynamic member label."""
    if parent is None:
        return {"pca": "pca", "repness": "repness", "group-clusters": "groups",
                "base-clusters": "bases", "consensus": "consensus",
                "group-aware-consensus": "group-consensus",
                "comment-priorities": "priorities"}.get(key, "other")
    if parent == "repness":
        return "rep-list"  # key is a dynamic group label, never inspect it
    if parent == "rep-record":
        return {"tid": "representatives-member-set", "repful-for": "representatives-direction",
                "best-agree": "representatives-direction",
                **dict.fromkeys(("n-success", "n-trials", "n-agree"), "representatives-counts"),
                **dict.fromkeys(("p-success", "p-test", "repness", "repness-test"),
                                "representatives-scores")}.get(key, "representatives")
    if parent == "pca":
        return {"comps": "components", "center": "centering",
                "comment-projection": "comment-coordinates", "comment-extremity": "extremities",
                **dict.fromkeys(("proj", "projections", "base-clusters-proj"),
                                "participant-coordinates")}.get(key, "other")
    if parent in ("group-record", "bases"):
        return {"center": "group-centers" if parent == "group-record" else "participant-coordinates",
                "x": "participant-coordinates", "y": "participant-coordinates"}.get(key, "other")
    return parent if parent in DETAILS else "other"


def item_context(parent):
    return {"rep-list": "rep-record", "groups": "group-record",
            "bases": "bases"}.get(parent, parent)


def context_detail(context, site="value"):
    if context == "repness":
        return "representatives-member-set" if site == "keys" else "representatives"
    if context == "rep-list":
        return "representatives-member-set" if site == "inventory" else "representatives-list-shape"
    if context == "rep-record":
        return "representatives-record-keys" if site == "keys" else "representatives"
    return context if context in DETAILS else "other"


def context_family(context, fallback, site="value"):
    return DETAIL_FAMILIES.get(context_detail(context, site), fallback or "meta")


def ordered(rows):
    """Deduplicate in the published enum order; accept only closed tuples."""
    result = set()
    for row in rows:
        if type(row) is not dict or set(row) != set(ROW_KEYS):
            raise ValueError("DIAGNOSTIC_SCHEMA")
        c, f, d, k, m = (row[x] for x in ROW_KEYS)
        if (type(c) is not int or c < 0 or f not in FAMILIES or k not in KINDS
                or type(d) is not str or d not in DETAILS
                or (d != "other" and DETAIL_FAMILIES[d] != f)
                or m not in MAGNITUDES or ((k == "numeric-tolerance") != (m != "not-applicable"))):
            raise ValueError("DIAGNOSTIC_SCHEMA")
        result.add((c, f, d, k, m))
    return [dict(zip(ROW_KEYS, row)) for row in sorted(result, key=lambda r:
        (r[0], FAMILIES.index(r[1]), DETAILS.index(r[2]), KINDS.index(r[3]), MAGNITUDES.index(r[4])))]
