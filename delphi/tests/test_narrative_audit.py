"""Independent proof auditor catches group-ID confusion and factual drift."""
import importlib.util
from pathlib import Path
from polismath.utils.vote_convention import SEMANTIC_AGREE, SEMANTIC_DISAGREE

import pytest

spec = importlib.util.spec_from_file_location("audit_narrative", Path(__file__).parent / "dynamo_removal/audit_narrative.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def fixture():
    math = {"base-clusters": {"id": [500, 600], "members": [[0], [77]]},
            "group-clusters": [{"id": 5, "members": [500]}, {"id": 9, "members": [600]}],
            "group_clusters": [{"id": 5, "members": [0]}, {"id": 9, "members": [77]}]}
    context = dict(group_mapping="base-clusters-unfold/1", source_convention="semantic:+1=agree",
                   group_assignments_sha256=audit.digest({"0": 5, "77": 9}, sort_keys=True, separators=(",", ":")),
                   math_sha256=audit.digest(math, sort_keys=True, separators=(",", ":"), allow_nan=False),
                   comments=[{"comment_id": 0, "comment-id": 0, "num_groups": 2,
                              "votes": 2, "agrees": 1, "disagrees": 1, "passes": 0,
                              "total-votes": 2, "total-agrees": 1, "total-disagrees": 1, "total-passes": 0,
                              "group-5-votes": 1, "group-5-agrees": 1,
                              "group-9-votes": 1, "group-9-disagrees": 1}])
    votes = [dict(tid=0, pid=0, vote=SEMANTIC_AGREE), dict(tid=0, pid=77, vote=SEMANTIC_DISAGREE)]
    return context, math, votes


def test_canonical_membership_uses_ids_not_array_positions():
    context, math, votes = fixture()
    result = audit.audit_context(context, math, votes, [0])
    assert result["group_sizes"] == {"5": 1, "9": 1}
    assert result["scoped_counts"] == 3


def test_recount_rejects_reversed_group_direction():
    context, math, votes = fixture()
    context["comments"][0]["group-5-agrees"] = 0
    with pytest.raises(AssertionError):
        audit.audit_context(context, math, votes, [0])


def test_recount_rejects_different_unfolded_alias():
    context, math, votes = fixture()
    math["group_clusters"][0]["members"] = [77]
    with pytest.raises(AssertionError):
        audit.audit_context(context, math, votes, [0])
