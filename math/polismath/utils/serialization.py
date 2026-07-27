"""JSON serialization helpers shared across the math pipeline.

``convert_numpy_types`` is the canonical ``default=`` for ``json.dumps`` when a
blob may carry numpy scalar/array types. It lives here (rather than nested inside
``regression.utils.save_golden_snapshot``) so the Postgres math writers
(``write_math_main`` / ``write_math_bidtopid`` / ``write_participant_stats``) can
share the exact same coercion.
"""

import numpy as np


def convert_numpy_types(obj):
    """Convert numpy scalar/array types to JSON-native Python types.

    Use as the ``default=`` callback for ``json.dumps``. Without it, a blob that
    carries a numpy integer — e.g. the repness ``gid`` (repness.py:847
    ``astype(int)`` produces a numpy ``int64``) or the na/nd/ns counts
    (repness.py:672-675) — raises ``TypeError: Object of type int64 is not JSON
    serializable``. Note ``json`` already handles ``np.float64`` (a subclass of
    Python ``float``) but NOT ``np.int64``, so integral fields are the trap.
    """
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")
