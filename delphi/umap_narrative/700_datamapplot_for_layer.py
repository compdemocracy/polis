#!/usr/bin/env python3
"""Thin CLI shim -> stages.datamapplot_layer.

The stage logic now lives in ``umap_narrative/stages/datamapplot_layer.py`` so
the orchestrator (``run_delphi.py``) can import and call it in-process. This
numbered script is kept so the stage stays independently runnable from the
command line, exactly as before:

    python umap_narrative/700_datamapplot_for_layer.py --conversation_id=<ID> --layer=<N>
"""
import os
import sys

# Ensure this file's directory (umap_narrative/) is importable so that
# ``stages`` and ``polismath_commentgraph`` resolve as top-level packages.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from stages.datamapplot_layer import main

if __name__ == "__main__":
    sys.exit(main())
