"""Scratch-file failures do not turn a naming failure into a run failure."""
import pytest
from tests.test_topic_namer import HAIKU, small_hierarchy, stub, stub_argv, topic_namer


@pytest.mark.parametrize("blocked", ["work", "hierarchy.json", "names.json"])
def test_scratch_failure_keeps_keywords(stub, blocked):
    work = stub / "work"
    if blocked == "work":
        work.write_text("occupied")
    else:
        work.mkdir()
        (work / blocked).mkdir()
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(work))
    assert result["outcome"] == "namer_failed"
    assert result["names"] == {}
    assert stub_argv(stub) == []
