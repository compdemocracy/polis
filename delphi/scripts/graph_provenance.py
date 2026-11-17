#!/usr/bin/env python3
"""Local-file provenance for the shadow's sealed graph; no network or model load."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
# Avoid importing the numerical package to inspect local files.
_spec = importlib.util.spec_from_file_location("shadow_embedding_model", ROOT / "polismath/embedding_model.py")
embedding_model = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(embedding_model)
from delphi_graph_stages import code_digest


def verified_digest(directory, lock):
    """One streaming read per file verifies the lock and builds the node digest."""
    directory = Path(directory)
    names = embedding_model.directory_files(directory)
    if names != sorted(lock["files"]):
        raise ValueError("model file set differs from lock")
    combined = hashlib.sha256()
    for name in names:
        combined.update(name.encode() + b"\0")
        digest = hashlib.sha256()
        with (directory / name).open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                combined.update(chunk)
        if digest.hexdigest() != lock["files"][name]:
            raise ValueError("model file differs from lock")
    return combined.hexdigest()


if __name__ == "__main__":
    resolved = embedding_model.resolve()
    if not resolved.local:
        raise ValueError("graph admission requires the offline image model")
    model_sha = verified_digest(resolved.arg, embedding_model.read_lock(resolved.lock))
    print(json.dumps(dict(model=resolved.model, runtime="python-" + sys.version.split()[0],
        code=hashlib.sha256(Path(__file__).with_name("job_graph_stage.py").read_bytes()).hexdigest(),
        adapter_sha256=code_digest(), model_sha256=model_sha)))
