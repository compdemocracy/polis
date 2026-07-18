"""Importable Delphi pipeline stages.

Each module in this package holds the logic that used to live directly in a
numbered ``NNN_*.py`` script (e.g. ``501_calculate_comment_extremity.py``).
The numbered scripts are retained as thin shims so every stage stays
independently runnable from the command line, while the orchestrator
(``run_delphi.py``) imports these modules and calls their ``main(argv)`` entry
points in-process. See ``stages/runner.py`` for the dispatch abstraction.

These modules are imported as top-level packages (``stages.*``,
``polismath_commentgraph.*``) with ``umap_narrative/`` on ``sys.path`` -- the
same convention the numbered scripts already rely on.
"""
