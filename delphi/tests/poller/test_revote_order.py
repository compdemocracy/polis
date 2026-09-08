"""M2 (P-019): duplicate (pid, tid) resolution must be by `created` timestamp,
not payload order.

A retried vote batch can be re-queued at the tail AFTER a newer revote that was
queued while the older write was failing. The coalesced batch then presents the
votes in the WRONG temporal order. `Conversation.update_votes` must still keep
the vote with the greatest `created`, so it carries `created` into the dedup and
stable-sorts by it before `drop_duplicates(keep='last')`.
"""

from polismath.conversation.conversation import Conversation


def _cell(conv, pid, tid):
    return conv.raw_rating_mat.loc[pid, tid]


class TestRevoteOrder:
    def test_newer_revote_wins_despite_payload_order(self):
        """The NEWER vote (created=20) must win even when it appears BEFORE the
        older vote (created=10) in the payload — i.e. the exact tail-retry
        reordering M2 describes."""
        conv = Conversation(1, last_updated=1)
        batch = {
            "votes": [
                {"pid": 1, "tid": 1, "vote": -1, "created": 20},  # newer, first
                {"pid": 1, "tid": 1, "vote": 1, "created": 10},   # older, last
            ],
            "lastVoteTimestamp": 20,
        }
        conv = conv.update_votes(batch, recompute=False)
        assert _cell(conv, 1, 1) == -1.0, "newer revote (created=20) must win"
        assert conv.last_updated == 20

    def test_in_order_batch_keeps_last(self):
        """The ordinary in-created-order stream still keeps the last vote."""
        conv = Conversation(1, last_updated=1)
        batch = {
            "votes": [
                {"pid": 1, "tid": 1, "vote": 1, "created": 10},
                {"pid": 1, "tid": 1, "vote": -1, "created": 20},
            ],
            "lastVoteTimestamp": 20,
        }
        conv = conv.update_votes(batch, recompute=False)
        assert _cell(conv, 1, 1) == -1.0

    def test_equal_created_keeps_payload_order(self):
        """Ties on `created` fall back to payload (Clojure encounter) order via
        the STABLE sort — the last equal-timestamp vote wins."""
        conv = Conversation(1, last_updated=1)
        batch = {
            "votes": [
                {"pid": 1, "tid": 1, "vote": 1, "created": 10},
                {"pid": 1, "tid": 1, "vote": -1, "created": 10},
            ],
            "lastVoteTimestamp": 10,
        }
        conv = conv.update_votes(batch, recompute=False)
        assert _cell(conv, 1, 1) == -1.0
