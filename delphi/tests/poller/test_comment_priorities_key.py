"""The math_main blob carries comment priorities under the key the server reads.

The server's next-statement draw (server/src/nextComment.ts) weights each
unvoted statement by ``data["comment-priorities"][tid]`` from the latest math
generation, and gives a statement it finds no number for a weight of 1. The
legacy engine wrote that key. A blob that spells it any other way leaves the
server with no priorities, and every draw is uniform.

These tests run the real engine and the real writer (``MathWriter``) and read
what the writer hands to ``write_math_main``. The fixture below is that output
for a small conversation in which one statement's priority dominates. The
server's integration test (server/__tests__/integration/
next-comment-priorities.test.ts) inserts it unchanged into math_main and checks
that the draw follows it, so a change of the key on either side fails a test.

To regenerate the fixture after an intended change to the engine or the writer:
    UPDATE_PRIORITIES_FIXTURE=1 pytest tests/poller/test_comment_priorities_key.py
"""

import json
import math
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

from polismath.conversation.conversation import Conversation
from polismath.poller.math_writer import MathWriter
from tests.vote_fixtures import AGREE, DISAGREE

FIXTURE = Path(__file__).parent / "fixtures" / "math-main-priorities.json"
SERVED_KEY = "comment-priorities"
ZID = 7
CLOCK_MS = 1700000000000
PARTICIPANTS = 16
STATEMENTS = 4
#: Every participant agrees with the other statements; this one splits them
#: evenly, so it alone carries the PCA's extremity and the largest priority.
DIVIDING_TID = 2


def _conversation():
    """One generation of a conversation in which every participant votes on
    every statement. The engine's wall clock is pinned so the blob is stable."""
    votes = []
    for pid in range(PARTICIPANTS):
        for tid in range(STATEMENTS):
            vote = AGREE
            if tid == DIVIDING_TID and pid >= PARTICIPANTS // 2:
                vote = DISAGREE
            votes.append({"pid": pid, "tid": tid, "vote": vote,
                          "created": CLOCK_MS + len(votes)})
    with patch("time.time", return_value=CLOCK_MS / 1000):
        return Conversation(ZID).update_votes({"votes": votes})


def _written_main(conv):
    """The math_main data exactly as the writer passes it to Postgres."""
    client = MagicMock()
    client.increment_math_tick.return_value = 1
    with patch("time.time", return_value=CLOCK_MS / 1000):
        MathWriter(client).write_conv_updates(ZID, conv)
    zid, main_json = client.write_math_main.call_args.args[:2]
    assert zid == ZID
    return json.loads(main_json)


def _fixture(conv, main):
    priorities = {str(tid): value for tid, value in conv.comment_priorities.items()}
    return {
        "about": "The Python math writer's math_main output for one generation of a "
                 "four-statement conversation (delphi/tests/poller/"
                 "test_comment_priorities_key.py). The server's next-statement test "
                 "inserts math_main unchanged. Regenerate with "
                 "UPDATE_PRIORITIES_FIXTURE=1; never edit by hand.",
        "dominant_tid": max(priorities, key=priorities.get),
        "engine_priorities": priorities,
        "math_main": main,
    }


def _close(a, b, path="$"):
    """Equal structure and values; floats equal to 1e-9 relative (BLAS builds
    differ in the last bits). Returns the first differing path, or None."""
    if isinstance(a, bool) or isinstance(b, bool) or a is None or b is None:
        return None if a == b and type(a) is type(b) else path
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return None if math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12) else path
    if isinstance(a, dict) and isinstance(b, dict):
        if list(a) != list(b):
            return f"{path} keys {sorted(set(a) ^ set(b))}"
        for key in a:
            found = _close(a[key], b[key], f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path} length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            found = _close(x, y, f"{path}[{i}]")
            if found:
                return found
        return None
    return None if a == b else path


def test_written_blob_carries_the_key_the_server_reads():
    conv = _conversation()
    main = _written_main(conv)

    assert SERVED_KEY in main, sorted(main)
    assert "comment_priorities" not in main, (
        "the blob must carry ONE spelling of the priorities, the one the server reads")
    expected = {str(tid): value for tid, value in conv.comment_priorities.items()}
    assert main[SERVED_KEY] == expected
    # One statement dominates the draw: its weight exceeds all the others'.
    dominant = main[SERVED_KEY].pop(str(DIVIDING_TID))
    assert dominant > 2 * sum(main[SERVED_KEY].values())


def test_restart_restores_priorities_from_either_spelling():
    """A warm restart rebuilds the conversation from its last blob. Blobs
    written before the key was corrected carry the underscore spelling."""
    conv = _conversation()
    main = _written_main(conv)
    expected = main[SERVED_KEY]

    assert Conversation.from_dict(main).comment_priorities == expected

    earlier = {k: v for k, v in main.items() if k != SERVED_KEY}
    earlier["comment_priorities"] = expected
    assert Conversation.from_dict(earlier).comment_priorities == expected


def test_committed_fixture_matches_the_writer():
    conv = _conversation()
    fresh = _fixture(conv, _written_main(conv))
    if os.environ.get("UPDATE_PRIORITIES_FIXTURE") == "1":
        FIXTURE.write_text(json.dumps(fresh, indent=2) + "\n")
    committed = json.loads(FIXTURE.read_text())
    difference = _close(committed, fresh)
    assert difference is None, (
        f"the writer's math_main output changed at {difference}; regenerate with "
        "UPDATE_PRIORITIES_FIXTURE=1 and check the server's next-statement test")
