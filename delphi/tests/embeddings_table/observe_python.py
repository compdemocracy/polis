#!/usr/local/bin/python
"""Test-only interpreter wrapper for the embeddings-table proof.

The daemon removes an attempt's work directory once the attempt finishes, so the
spool the child wrote (the comments it actually embedded) would be gone before the
proof could read it. This wrapper runs the real stage unchanged, then, for an
embed stage, copies that spool and the hydrated frame to a durable sibling of the
work directory. It changes nothing the stage computes or stores.
"""
import os
import runpy
import shutil
import sys
from pathlib import Path

frame_path = Path(os.environ["DELPHI_FRAME"])
stage = os.environ.get("DELPHI_STAGE", "")
attempt = os.environ.get("DELPHI_ATTEMPT_ID", "unknown")
sys.argv = sys.argv[1:]
try:
    runpy.run_path(sys.argv[0], run_name="__main__")
finally:
    if stage == "graph_embed":
        # frame is <work_dir>/<attempt>/frame.json; capture to <work_dir>/../captured
        # (a sibling of the jobs dir, so the daemon's attempt-dir cleanup never
        # touches it).
        captured = frame_path.parents[2] / "captured"
        captured.mkdir(parents=True, exist_ok=True)
        for name, dest in (("embeddings.spool", f"{attempt}.embeddings.spool"),
                           (frame_path.name, f"{attempt}.frame.json")):
            src = frame_path.parent / name
            if src.exists():
                shutil.copyfile(src, captured / dest)
