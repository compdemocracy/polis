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
from graph_registry import implementations


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


def report(require_embedding=True):
    if not require_embedding:
        return implementations()
    from graph_registry import _test_models
    import os
    if _test_models and not os.environ.get('DELPHI_EMBED_MODEL_LOCK') and os.environ.get('DELPHI_EMBED_MODEL_PATH'):
        from delphi_graph_stages import model_digest
        model = _test_models.embedding_name()
        result = implementations(model)
        result.update(model=model, adapter_sha256=code_digest(), model_sha256=model_digest(os.environ['DELPHI_EMBED_MODEL_PATH']))
        return result
    resolved = embedding_model.resolve()
    if not resolved.local:
        raise ValueError("graph admission requires the offline image model")
    model_sha = verified_digest(resolved.arg, embedding_model.read_lock(resolved.lock))
    result = implementations(resolved.model)
    result.update(model=resolved.model, adapter_sha256=code_digest(), model_sha256=model_sha)
    return result


if __name__ == "__main__":
    print(json.dumps(report(require_embedding="--without-embedding" not in sys.argv)))
