"""The embedding model (all-MiniLM-L6-v2) carried in the Delphi image.

The image's build fetches the model's files once, at the revision named in
``embedding-model.lock.json`` (beside this package's directory), and checks
every file's SHA-256 against the lock (``fetch``). At run time the UMAP stage
reads that directory instead of the Hugging Face hub when
``DELPHI_EMBED_MODEL_PATH`` names it; with ``DELPHI_EMBED_MODEL_LOCK`` also
set, the directory is checked against the lock before the model is loaded, and
a directory that differs refuses the run (``load_check``). Unset, the stage
loads the model by name from the hub, as it always has.

``compare`` is the byte-for-byte check between the two: it encodes the same
texts with the model loaded by name (today's run) and loaded from the
directory, and reports both digests; they must be equal.

Nothing in this module talks to the network except ``fetch`` and the by-name
half of ``compare``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Dict, List

LOCK_SCHEMA = "delphi-embedding-model/1"
DEFAULT_LOCK = Path(__file__).resolve().parents[1] / "embedding-model.lock.json"


class ModelMismatch(Exception):
    pass


def read_lock(path) -> Dict:
    lock = json.loads(Path(path).read_text())
    if lock.get("schema") != LOCK_SCHEMA:
        raise ModelMismatch(f"{path}: not a {LOCK_SCHEMA} lock")
    files = lock.get("files")
    if not isinstance(files, dict) or not files or not lock.get("repo") or not lock.get("revision"):
        raise ModelMismatch(f"{path}: the lock names no repository, revision or files")
    if not any(name.endswith(".safetensors") for name in files):
        raise ModelMismatch(f"{path}: the lock names no weights")
    for name, digest in files.items():
        if name.startswith("/") or ".." in Path(name).parts or len(digest) != 64:
            raise ModelMismatch(f"{path}: bad entry {name!r}")
    return lock


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def directory_files(directory: Path) -> List[str]:
    """Every regular file below the directory, as posix paths relative to it."""
    return sorted(
        p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()
    )


def verify(directory, lock) -> None:
    """The directory holds exactly the lock's files, each with the lock's SHA-256."""
    directory = Path(directory)
    expected = lock["files"]
    present = directory_files(directory)
    if present != sorted(expected):
        missing = sorted(set(expected) - set(present))
        extra = sorted(set(present) - set(expected))
        raise ModelMismatch(f"{directory}: files differ from the lock (missing {missing}, extra {extra})")
    for name in present:
        actual = sha256_file(directory / name)
        if actual != expected[name]:
            raise ModelMismatch(f"{directory}/{name}: sha256 {actual}, the lock says {expected[name]}")


def fetch(lock_path, dest) -> None:
    """Download the lock's files at its revision into ``dest`` and verify them."""
    from huggingface_hub import snapshot_download

    lock = read_lock(lock_path)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        lock["repo"], revision=lock["revision"], allow_patterns=sorted(lock["files"]),
        local_dir=str(dest),
    )
    # The hub client's own bookkeeping, not part of the model.
    shutil.rmtree(dest / ".cache", ignore_errors=True)
    verify(dest, lock)


def load_check() -> str:
    """The model argument the UMAP stage passes to SentenceTransformer, and the check.

    With DELPHI_EMBED_MODEL_PATH set: that directory (checked against
    DELPHI_EMBED_MODEL_LOCK when that is set). Unset: the model name, as before.
    """
    path = os.environ.get("DELPHI_EMBED_MODEL_PATH", "").strip()
    if not path:
        return os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
    lock_path = os.environ.get("DELPHI_EMBED_MODEL_LOCK", "").strip()
    if lock_path:
        verify(path, read_lock(lock_path))
    return path


def encode_digest(model_arg: str, texts: List[str], local_files_only: bool) -> Dict:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(model_arg, local_files_only=local_files_only)
    vectors = model.encode(texts, show_progress_bar=False)
    vectors = np.ascontiguousarray(vectors)
    return {
        "shape": list(vectors.shape),
        "dtype": str(vectors.dtype),
        "sha256": hashlib.sha256(vectors.tobytes()).hexdigest(),
        "vectors": vectors,
    }


def compare(name: str, directory: str, texts: List[str]) -> Dict:
    by_name = encode_digest(name, texts, local_files_only=False)
    from_dir = encode_digest(directory, texts, local_files_only=True)
    import numpy as np

    return {
        "texts": len(texts),
        "by_name": {k: v for k, v in by_name.items() if k != "vectors"},
        "from_image": {k: v for k, v in from_dir.items() if k != "vectors"},
        "identical": bool(np.array_equal(by_name["vectors"], from_dir["vectors"]))
        and by_name["sha256"] == from_dir["sha256"],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch", help="download the lock's files and verify them")
    f.add_argument("--lock", default=str(DEFAULT_LOCK))
    f.add_argument("--dest", required=True)
    v = sub.add_parser("verify", help="check a directory against the lock")
    v.add_argument("--lock", default=str(DEFAULT_LOCK))
    v.add_argument("--dir", required=True)
    c = sub.add_parser("compare", help="encode texts by name and from a directory; print both digests")
    c.add_argument("--name", default="all-MiniLM-L6-v2")
    c.add_argument("--dir", required=True)
    c.add_argument("--texts", required=True, help="a JSON list of strings")
    args = parser.parse_args(argv)
    try:
        if args.command == "fetch":
            fetch(args.lock, args.dest)
            print(json.dumps({"fetched": args.dest, "revision": read_lock(args.lock)["revision"]}))
        elif args.command == "verify":
            verify(args.dir, read_lock(args.lock))
            print(json.dumps({"verified": args.dir}))
        else:
            texts = json.loads(Path(args.texts).read_text())
            result = compare(args.name, args.dir, texts)
            print(json.dumps(result, sort_keys=True))
            return 0 if result["identical"] else 1
    except ModelMismatch as e:
        print(f"embedding model: {e}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
