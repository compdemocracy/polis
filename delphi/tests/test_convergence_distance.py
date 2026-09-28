"""Convergence controls recorded from real Vector centers in Clojure.

Regenerate with fixtures/generate_convergence_controls.clj; its class assertion
prevents accidentally testing ArraySubVector's assignment arithmetic instead.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from polismath.pca_kmeans_rep.legacy_kmeans import _center_distance, same_clustering


CONTROLS = json.loads((Path(__file__).parent / "replay_harness" / "fixtures" /
                       "convergence_controls.json").read_text())


@pytest.mark.parametrize("control", CONTROLS, ids=lambda c: c["name"])
def test_real_vector_convergence(control):
    assert control["center-class"] == "mikera.vectorz.Vector"
    left = [{"center": np.asarray(control["left"], dtype=float)}]
    right = [{"center": np.asarray(control["right"], dtype=float)}]
    # Adjacent representable thresholds detect even one-bit arithmetic drift;
    # the equality threshold must remain false (Clojure uses strict less-than).
    with np.errstate(invalid="ignore", over="ignore", under="ignore"):
        expected = float.fromhex(control["distance-hex"])
        actual = _center_distance(left[0]["center"], right[0]["center"])
        if np.isnan(expected):
            assert np.isnan(actual)
        else:
            assert actual.hex() == expected.hex()
        for check in control["checks"]:
            threshold = float.fromhex(check["threshold-hex"])
            assert same_clustering(left, right, threshold) is check["same"]
            assert same_clustering(right, left, threshold) is check["same"]


def test_sorted_center_pairs_and_shorter_clustering():
    a = [{"center": [1.0e8, 1.0e8]}, {"center": [-2.0, 3.0]}]
    b = [{"center": [-2.0, 3.0]}, {"center": [100000000.02, 1.0e8]}]
    assert same_clustering(a, b) is False
    assert same_clustering(a, b[:1]) is True
    assert same_clustering([], b) is True


@pytest.mark.parametrize("right", [[1.0], [1.0, 2.0, 3.0], [[1.0, 2.0]]])
def test_center_coordinates_do_not_silently_truncate(right):
    with pytest.raises(ValueError, match="vectors of equal length"):
        _center_distance(np.array([1.0, 2.0]), np.array(right))
