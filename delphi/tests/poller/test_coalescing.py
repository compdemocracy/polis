"""Per-zid batch coalescing.

Mirrors Clojure conv_man.clj:
  - take-all! (:227-234) drains every queued batch,
  - split-batches (:247-257) groups by :message-type and flattens each group,
  - go-act! (:368-370) then processes types in the fixed order [:votes :moderation].
"""

from polismath.poller.worker_pool import coalesce_messages, CoalescedBatch


class TestCoalesceMessages:
    def test_single_vote_batch(self):
        c = coalesce_messages([("votes", [{"pid": "1", "tid": "1", "vote": 1}])])
        assert c.votes == [{"pid": "1", "tid": "1", "vote": 1}]
        assert c.moderation == []

    def test_multiple_vote_batches_merge_in_arrival_order(self):
        # Clojure split-batches flattens all :votes batches into one sequence.
        c = coalesce_messages(
            [
                ("votes", [{"pid": "1"}, {"pid": "2"}]),
                ("votes", [{"pid": "3"}]),
            ]
        )
        assert c.votes == [{"pid": "1"}, {"pid": "2"}, {"pid": "3"}]
        assert c.moderation == []

    def test_moderation_batches_merge(self):
        c = coalesce_messages(
            [
                ("moderation", [{"tid": "1", "mod": -1}]),
                ("moderation", [{"tid": "2", "mod": 1}]),
            ]
        )
        assert c.moderation == [{"tid": "1", "mod": -1}, {"tid": "2", "mod": 1}]
        assert c.votes == []

    def test_interleaved_batches_separate_by_type_preserving_vote_order(self):
        # Interleaved arrival [votes, moderation, votes] -> votes merged across,
        # moderation kept separate. Votes are still in first-appearance order.
        c = coalesce_messages(
            [
                ("votes", [{"pid": "1"}]),
                ("moderation", [{"tid": "9"}]),
                ("votes", [{"pid": "2"}]),
            ]
        )
        assert c.votes == [{"pid": "1"}, {"pid": "2"}]
        assert c.moderation == [{"tid": "9"}]

    def test_empty_message_list(self):
        c = coalesce_messages([])
        assert c == CoalescedBatch(votes=[], moderation=[])

    def test_has_work_true_when_any_batch(self):
        assert coalesce_messages([("votes", [{"pid": "1"}])]).has_work() is True
        assert coalesce_messages([("moderation", [{"tid": "1"}])]).has_work() is True
        assert coalesce_messages([]).has_work() is False
