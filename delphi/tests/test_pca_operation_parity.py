"""Real Clojure operation controls plus order-sensitive reduction witnesses."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock
import numpy as np
from polismath.pca_kmeans_rep import pca


def _ordered_xtxr(data: np.ndarray, vector: np.ndarray) -> np.ndarray:
    """Reference oracle: legacy-order Xᵀ (X v); production uses BLAS."""
    data = np.asfortranarray(data)
    row_products = pca._ordered_row_dot(data, vector)
    return np.array([pca._ordered_dot(row_products, column) for column in data.T])


class OperationParityTests(unittest.TestCase):
    def test_clojure_operation_controls(self):
        path = Path(__file__).parent / 'replay_harness/fixtures/pca_operation_controls.json'
        for case in json.loads(path.read_text()):
            c, e = case['input'], case['expected']
            matrix, start = np.array(c['matrix']), np.array(c['start'])
            pc = pca.powerit_pca(matrix, start_vectors=[start, start[::-1]])
            values = dict(center=pca._ordered_center(matrix), dot=pca._ordered_dot(start,start),
                          xtxr=_ordered_xtxr(matrix,start),
                          normalise=start*(1/np.sqrt(pca._ordered_dot(start,start))),
                          factor=pca._factor_matrix(matrix,start),
                          projection=pca._sparse_projections(np.array(c['sparse'], dtype=float), pc['center'], pc['comps'], 2))
            for key, value in values.items():
                with self.subTest(shape=matrix.shape, operation=key):
                    actual, expected = np.asarray(value, dtype=float), np.asarray(e[key], dtype=float)
                    if key == 'projection':  # Uses BLAS-produced components.
                        self.assertTrue(np.all(np.abs(actual-expected) <=
                            1e-6 + 1e-4*np.maximum(np.abs(actual),np.abs(expected))))
                    else:
                        np.testing.assert_array_equal(actual.view(np.uint64), expected.view(np.uint64))
            actual, expected = pc['comps'], np.array(e['pca']['comps'])
            self.assertTrue(np.all(np.abs(actual-expected) <=
                1e-6 + 1e-4*np.maximum(np.abs(actual),np.abs(expected))))

    def test_reduction_keeps_column_encounter_order(self):
        row = np.array([[1e16, 1., -1e16, 1., 1., 1., 1., 1.]])
        np.testing.assert_array_equal(pca._ordered_row_dot(row, np.ones(8)), [5.])
        self.assertEqual(pca._ordered_dot(row[0], np.ones(8)), 5.)

    def test_sparse_projection_excludes_unseen_cells(self):
        matrix = np.array([[1., np.nan, 0.], [np.nan, np.nan, np.nan]])
        center = np.array([.25, .1, -.5])
        comps = np.array([[1., 2., 3.], [-1., 2., -3.]])
        expected = np.array([[2.25, -2.25], [0., 0.]]) * np.array([[np.sqrt(1.5)], [np.sqrt(3.)]])
        np.testing.assert_array_equal(pca._sparse_projections(matrix,center,comps,2), expected)

    def test_rank_capped_projection_stays_zero(self):
        np.testing.assert_array_equal(pca._sparse_projections(np.ones((3,1)),np.zeros(1),np.ones((1,1)),2), np.zeros((3,2)))

    def test_negative_zero_dot_and_projection_start_at_positive_zero(self):
        value = pca._ordered_dot(np.array([-0., -0.]), np.ones(2))
        self.assertFalse(np.signbit(value))
        value = pca._ordered_row_dot(np.array([[-0., -0.]]), np.ones(2))
        self.assertFalse(np.signbit(value[0]))

    def test_ratio_to_double_rounds_like_decimal64(self):
        # Actual Math/sqrt of Clojure integer ratios, independently recorded.
        path = Path(__file__).parent / 'replay_harness/fixtures/pca_ratio_783.json'
        expected = np.array(json.loads(path.read_text()))
        width = 783
        data = np.where(np.arange(width)[None, :] <= np.arange(width)[:, None], 0., np.nan)
        data[:, 0] = 1.  # Each row's ordered projection sum is exactly one.
        actual = pca._sparse_projections(data, np.zeros(width), np.ones((2,width)), 2)[:,0]
        np.testing.assert_array_equal(actual.view(np.uint64), expected.view(np.uint64))
        self.assertFalse(np.array_equal(expected.view(np.uint64),
                         np.sqrt(width / np.arange(1,width+1)).view(np.uint64)))

    def test_iteration_budget_and_exact_stop_are_unchanged(self):
        data = MagicMock()
        data.shape = (2, 2)
        data.__matmul__.return_value = np.ones(2)
        data.T.__matmul__.side_effect = [np.array([1., 1.]), np.array([2., 1.]), np.array([3., 1.])]
        with patch.object(pca.np, 'asfortranarray', return_value=data):
            pca._power_iteration(np.eye(2), iters=2)
            self.assertEqual(data.T.__matmul__.call_count, 3)
        data.T.__matmul__.reset_mock(side_effect=True)
        data.T.__matmul__.return_value = np.ones(2)
        with patch.object(pca.np, 'asfortranarray', return_value=data):
            pca._power_iteration(np.eye(2), iters=100)
            self.assertEqual(data.T.__matmul__.call_count, 2)

    def test_power_iteration_uses_blas_not_ordered_reference(self):
        with patch.object(pca, '_ordered_dot', side_effect=AssertionError('ordered path')), \
             patch.object(pca, '_ordered_row_dot', side_effect=AssertionError('ordered path')):
            result = pca._power_iteration(np.diag([2., 1.]), start_vector=np.ones(2))
        np.testing.assert_allclose(result, [1., 0.], atol=1e-7)



if __name__ == '__main__':
    unittest.main()
