"""Filesystem anchors for the polismath package.

The package lives at ``<repo>/math/polismath`` (moved from
``delphi/polismath`` at cutover Step #4), while the test estate —
``real_data/`` datasets, golden snapshots, replay stores, ``.test_outputs``
— deliberately stayed under ``<repo>/delphi/``. Before the move, modules
derived those locations from their own ``__file__`` (``parents[2]`` was the
delphi root); after it, the same arithmetic lands on ``math/`` — silently
wrong. Every cross-tree anchor now lives here, derived once.

Modules keep their historical module-level names (``_DELPHI_ROOT``,
``REAL_DATA_ROOT``, ``_MATH_ROOT``, ...) assigned FROM these constants, so
tests that monkeypatch those attributes keep working unchanged.

ASSUMPTION: these anchors are meaningful only under an EDITABLE /
repo-checkout install (delphi/.venv via [tool.uv.sources]). In the Docker
image polismath sits in site-packages, so REPO_ROOT resolves inside the
interpreter prefix and none of the cross-tree paths exist — which is fine
today because no production module (poller/, run_math_pipeline,
conversation/, pca_kmeans_rep/, database/) imports this module; only the
replay/regression harness does, and that runs from the repo checkout.
Keep it that way: production code must not import polismath.paths.
"""

from __future__ import annotations

from pathlib import Path

# paths.py -> polismath -> math -> repo root.
REPO_ROOT = Path(__file__).resolve().parents[2]

# Home of this package (and, pre-cutover, of the Clojure engine).
MATH_ROOT = REPO_ROOT / "math"

# The polismath package directory itself (certify's engine-tree hash root).
PACKAGE_ROOT = Path(__file__).resolve().parent

# The delphi tree: umap/narrative service AND the math test estate
# (tests, real_data datasets + goldens, replay stores, certify battery).
DELPHI_ROOT = REPO_ROOT / "delphi"

# Datasets + golden snapshots (delphi/real_data; private under .local/).
REAL_DATA_ROOT = DELPHI_ROOT / "real_data"

# The Clojure reference tree — the certification oracle. Removed from the
# working tree at cutover Step #4; it exists ONLY in git history
# (`git log -- math/`, any commit before Step #4). Code that replays the
# oracle (certify's ensure_clj_recording) must check this path exists and
# skip/fail with a message pointing at the history checkout otherwise —
# the requires_math_tree test guards rely on exactly that check.
CLJ_TREE_ROOT = REPO_ROOT / "math"
