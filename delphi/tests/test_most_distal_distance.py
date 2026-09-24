"""Named-row distance differs from assignment's vectorz view-row distance."""
import unittest
import numpy as np
from polismath.pca_kmeans_rep.legacy_kmeans import _NamedData, _euclidean, most_distal


class MostDistalDistanceTests(unittest.TestCase):
    def test_named_row_distance_does_not_cancel(self):
        # Real vectorz get-row: [1, 0]; rows/assignment view: [0, 0].
        data = _NamedData([0, 1], [[100000001., 100000000.], [100000000., 100000000.]])
        center = np.array([100000000., 100000000.])
        self.assertEqual(most_distal(data, [dict(id=7, center=center)]),
                         dict(id=0, clst_id=7, dist=1.))
        self.assertEqual(_euclidean(data.matrix[0], center), 0.)

    def test_group_matrix_rows_retain_cancellation(self):
        data = _NamedData([0, 1], [[100000001., 100000000.], [100000000., 100000000.]],
                          matrix_backed=True)
        self.assertEqual(most_distal(data, [dict(id=7, center=np.array([100000000., 100000000.]))]),
                         dict(id=1, clst_id=7, dist=0.))

    def test_exact_distance_ties_keep_later_row_and_cluster(self):
        data = _NamedData([0, 1], [[1., 0.], [-1., 0.]])
        centers = [dict(id=i, center=np.zeros(2)) for i in [7, 9]]
        self.assertEqual(most_distal(data, centers), dict(id=1, clst_id=9, dist=1.))

    def test_tiny_real_gap_is_not_a_tie(self):
        data = _NamedData([0, 1], [[1. + 2**-50, 1.], [1., 1.]])
        self.assertEqual(most_distal(data, [dict(id=0, center=np.ones(2))]),
                         dict(id=0, clst_id=0, dist=2**-50))


if __name__ == '__main__':
    unittest.main()
