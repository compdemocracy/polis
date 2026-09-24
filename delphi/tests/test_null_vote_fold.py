"""Explicit null is an update; an absent cell in a batch is not."""
import itertools
import unittest

import pandas as pd

from polismath.conversation.conversation import Conversation


def vote(value, pid=0, tid=0, created=1):
    return dict(pid=pid, tid=tid, vote=value, created=created)


def fold(conv, events):
    return conv.update_votes(dict(votes=events, lastVoteTimestamp=100), recompute=False)


class NullVoteFoldTests(unittest.TestCase):
    def test_clear_existing_cell_preserves_other_cells_and_original(self):
        old = fold(Conversation('public-fixture'), [vote(1), vote(-1, tid=1)])
        new = fold(old, [vote(None, created=2)])
        self.assertTrue(pd.isna(new.raw_rating_mat.loc[0, 0]))
        self.assertEqual(new.raw_rating_mat.loc[0, 1], -1)
        self.assertEqual(old.raw_rating_mat.loc[0, 0], 1)
        self.assertEqual(new.vote_stats['n_votes'], 1)
        self.assertEqual(new.vote_stats['n_agree'], 0)
        self.assertEqual(new.last_updated, max(old.last_updated, 100))

    def test_null_allocates_row_column_and_arrival_identity(self):
        conv = fold(Conversation('public-fixture'), [vote(None, pid=8, tid=7)])
        conv = fold(conv, [vote(None, pid=2, tid=7), vote(None, pid=8, tid=3)])
        self.assertEqual(list(conv.raw_rating_mat.index), [8, 2])
        self.assertEqual(list(conv.raw_rating_mat.columns), [7, 3])
        self.assertEqual(conv.tid_arrival_order, [7, 3])
        self.assertEqual((conv.participant_count, conv.comment_count), (2, 2))
        self.assertTrue(conv.raw_rating_mat.isna().all().all())
        self.assertEqual(conv.vote_stats['n_votes'], 0)
        self.assertEqual(conv.to_dict()['tids'], [7, 3])

    def test_all_nullable_sequences_within_and_across_batches(self):
        # Includes null -> value, value -> null, repeated null, and pass (zero).
        for values in itertools.product([None, -1, 0, 1], repeat=3):
            for split in [False, True]:
                with self.subTest(values=values, split=split):
                    conv = Conversation('public-fixture')
                    events = [vote(v, created=i) for i, v in enumerate(values)]
                    for batch in ([[e] for e in events] if split else [events]):
                        conv = fold(conv, batch)
                    actual = conv.raw_rating_mat.loc[0, 0]
                    if values[-1] is None:
                        self.assertTrue(pd.isna(actual))
                    else:
                        self.assertEqual(actual, values[-1])
                    self.assertEqual(conv.vote_stats['n_votes'], int(values[-1] is not None))

    def test_equal_timestamp_uses_last_encounter(self):
        for values in [(1, None), (None, -1), (0, None), (None, 0)]:
            with self.subTest(values=values):
                conv = fold(Conversation('public-fixture'), [vote(v) for v in values])
                actual = conv.raw_rating_mat.loc[0, 0]
                self.assertTrue(pd.isna(actual) if values[-1] is None else actual == values[-1])

    def test_timestamp_order_precedes_payload_order(self):
        conv = fold(Conversation('public-fixture'), [vote(None, created=3), vote(1, created=2)])
        self.assertTrue(pd.isna(conv.raw_rating_mat.loc[0, 0]))
        conv = fold(conv, [vote(-1, created=5), vote(None, created=4)])
        self.assertEqual(conv.raw_rating_mat.loc[0, 0], -1)

    def test_missing_or_invalid_vote_does_not_clear_or_allocate(self):
        conv = fold(Conversation('public-fixture'), [vote(1)])
        for event in [dict(pid=0, tid=0), vote('unknown'), vote([]), vote(None, pid=None)]:
            conv = fold(conv, [event])
        self.assertEqual(conv.raw_rating_mat.loc[0, 0], 1)
        self.assertEqual(conv.raw_rating_mat.shape, (1, 1))
        empty = fold(Conversation('public-fixture'), [dict(pid=9, tid=9)])
        self.assertEqual(empty.raw_rating_mat.shape, (0, 0))

    def test_moderated_null_update_survives_unmoderation(self):
        conv = fold(Conversation('public-fixture'), [vote(1), vote(-1, pid=1)])
        conv = conv.update_moderation(dict(mod_out_tids=[0]), recompute=False)
        conv = fold(conv, [vote(None, created=2)])
        self.assertTrue(pd.isna(conv.raw_rating_mat.loc[0, 0]))
        self.assertTrue((conv.rating_mat[0] == 0).all())
        conv = conv.mod_update([dict(tid=0, mod=0, is_meta=False, modified=3)])
        conv = fold(conv, [vote(-1, pid=1, created=3)])
        self.assertTrue(pd.isna(conv.rating_mat.loc[0, 0]))
        self.assertEqual(conv.rating_mat.loc[1, 0], -1)


if __name__ == '__main__':
    unittest.main()
