#!/usr/bin/env python3
"""Local-file provenance for the shadow's sealed graph; never opens a connection."""
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from polismath import embedding_model
from delphi_graph_stages import code_digest, model_digest

if __name__ == '__main__':
    resolved = embedding_model.resolve()
    if not resolved.local:
        raise ValueError('graph admission requires the offline image model')
    embedding_model.verify(resolved.arg, embedding_model.read_lock(resolved.lock))
    print(json.dumps(dict(model=resolved.model, runtime='python-' + sys.version.split()[0],
        code=hashlib.sha256(Path(__file__).with_name('job_graph_stage.py').read_bytes()).hexdigest(),
        adapter_sha256=code_digest(), model_sha256=model_digest(resolved.arg))))
