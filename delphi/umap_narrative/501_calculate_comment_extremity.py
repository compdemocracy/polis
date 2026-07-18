#!/usr/bin/env python3
"""Thin CLI shim -> stages.comment_extremity.

The stage logic now lives in ``umap_narrative/stages/comment_extremity.py`` so
the orchestrator (``run_delphi.py``) can import and call it in-process. This
numbered script is kept so the stage stays independently runnable from the
command line, exactly as before:

    python umap_narrative/501_calculate_comment_extremity.py --zid=<ID>
"""
import os
import sys

# Ensure this file's directory (umap_narrative/) is importable so that
# ``stages`` and ``polismath_commentgraph`` resolve as top-level packages.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from stages.comment_extremity import main

if __name__ == "__main__":
    sys.exit(main())
