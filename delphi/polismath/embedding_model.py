"""The embedding model (granite-embedding-311m-multilingual-r2) carried in the Delphi image.

The image's build fetches the model's files once, at the revision named in
``embedding-model.lock.json`` (beside this package's directory), and checks
every file's SHA-256 against the lock (``fetch``). At run time the UMAP stage
reads that directory when ``DELPHI_EMBED_MODEL_PATH`` names it (the Delphi
services in docker-compose.yml do), and checks it against
``DELPHI_EMBED_MODEL_LOCK`` before the model is loaded; a directory that
differs refuses the run. Unset, the default model is fetched by name once, at
the shipped lock's revision, into a directory under the Hugging Face cache, and
that directory is checked against the lock before every load the same way. Any
other model name is loaded from the hub as given, unchecked.

Every load keeps the first 384 dimensions (``truncate_dim``) and encode defaults to
unit vectors (``normalize_embeddings``): granite is 768 wide and
Matryoshka-trained, and 384 is the width Delphi has always stored. A run's
model is named once (``resolve``), as ``repo@revision:384`` when the revision
is known, and that name goes to the run record, the DynamoDB rows and the
per-row embeddings table alike.

``compare`` is the byte-for-byte check between the two: it encodes the same
texts with the model loaded by name and loaded from the directory, and
reports both digests; they must be equal.

Nothing in this module talks to the network except ``fetch``, a by-name
``load`` (the default model's first, or a model other than the default) and the
by-name half of ``compare``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional

LOCK_SCHEMA = "delphi-embedding-model/1"
# The default model and the revision a by-name load is pinned to. The lock
# names the same repository and revision (tests/test_embedding_model.py).
_CATALOG = json.loads(Path(__file__).with_name("job-models.json").read_text())
DEFAULT_IDENTITY = next(row["model"] for row in _CATALOG if row["id"] == "Granite")
DEFAULT_MODEL, _REVISION_WIDTH = DEFAULT_IDENTITY.split("@", 1)
DEFAULT_REVISION, _WIDTH = _REVISION_WIDTH.rsplit(":", 1)
DIMS = int(_WIDTH)
# The shipped lock: beside this package in a source checkout, and where the
# image installs it (delphi/Dockerfile, the embedding-model stage). In the image
# this module may be imported from /app or from site-packages, so the copy next
# to the package is not always there.
IMAGE_LOCK = Path("/opt/polis/embedding") / f"{DEFAULT_MODEL.rsplit('/', 1)[-1]}.lock.json"
_CHECKOUT_LOCK = Path(__file__).resolve().parents[1] / "embedding-model.lock.json"
DEFAULT_LOCK = next((p for p in (_CHECKOUT_LOCK, IMAGE_LOCK) if p.is_file()), _CHECKOUT_LOCK)


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
    DELPHI_EMBED_MODEL_LOCK when that is set). Unset: the model name.
    """
    path = os.environ.get("DELPHI_EMBED_MODEL_PATH", "").strip()
    if not path:
        return os.environ.get("SENTENCE_TRANSFORMER_MODEL", "").strip() or DEFAULT_MODEL
    lock_path = os.environ.get("DELPHI_EMBED_MODEL_LOCK", "").strip()
    if lock_path:
        verify(path, read_lock(lock_path))
    return path


def model_name(repo: str, revision: str, dims: int = DIMS) -> str:
    """A model's name as Delphi records it: ``repo@revision:dims``."""
    return f"{repo}@{revision}:{dims}"


def _revision_for(model: str) -> Optional[str]:
    return DEFAULT_REVISION if model == DEFAULT_MODEL else None


class Resolved(NamedTuple):
    arg: str                 # a directory, or the hub name SentenceTransformer is given
    local: bool              # a directory named by DELPHI_EMBED_MODEL_PATH
    revision: Optional[str]  # the revision the default model is fetched at by name
    lock: Optional[str]      # the lock the loaded files are checked against
    model: str               # the run's model, as the run record and the stores name it


def resolve() -> Resolved:
    """Which model this run embeds with, and its name. Reads the environment and
    the lock's JSON only (no hashing, no download, no model load), so the run
    record can name the model the pipeline loads.

    DELPHI_EMBED_MODEL_PATH set: the directory, which must have its lock
    (DELPHI_EMBED_MODEL_LOCK); the name is ``repo@revision:384`` from the lock,
    and a SENTENCE_TRANSFORMER_MODEL that names another model refuses, so a
    directory's vectors are never stored under another model's name. Unset, and
    SENTENCE_TRANSFORMER_MODEL unset or the default: the default model under the
    shipped lock (DEFAULT_LOCK), named ``repo@revision:384`` from it. Any other
    name: that model by name, unchecked, recorded as given.
    """
    path = os.environ.get("DELPHI_EMBED_MODEL_PATH", "").strip()
    configured = os.environ.get("SENTENCE_TRANSFORMER_MODEL", "").strip()
    selection = os.environ.get("DELPHI_EMBED_MODEL_BY_ENV", "")
    if selection:
        mapping = json.loads(selection)
        if not isinstance(mapping, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in mapping.items()):
            raise ModelMismatch("invalid per-environment embedding model setting")
        environment = os.environ.get("DELPHI_RESULT_ENV", os.environ.get("QUEUE_ENV", ""))
        chosen = mapping.get(environment)
        if chosen is not None:
            if not any(row["step"] == "embeddings" and row["model"] == chosen for row in _CATALOG):
                raise ModelMismatch("unknown embedding model for environment")
            configured = chosen

    if path:
        lock_path = os.environ.get("DELPHI_EMBED_MODEL_LOCK", "").strip()
        if not lock_path:
            raise ModelMismatch(
                f"DELPHI_EMBED_MODEL_PATH={path} has no DELPHI_EMBED_MODEL_LOCK: "
                "the directory's model cannot be named")
        lock = read_lock(lock_path)
        model = model_name(lock["repo"], lock["revision"])
        if configured and configured not in {lock["repo"], lock.get("name"), model}:
            raise ModelMismatch(
                f"SENTENCE_TRANSFORMER_MODEL={configured} but {path} holds {model}")
        return Resolved(path, True, None, lock_path, model)
    configured = configured or DEFAULT_MODEL
    if configured == DEFAULT_IDENTITY:
        configured = DEFAULT_MODEL
    if configured != DEFAULT_MODEL:
        return Resolved(configured, False, None, None, configured)
    lock_path = Path(DEFAULT_LOCK)
    if not lock_path.is_file():
        raise ModelMismatch(f"no shipped lock for {DEFAULT_MODEL} (looked for {_CHECKOUT_LOCK} and {IMAGE_LOCK})")
    lock = read_lock(lock_path)
    if (lock["repo"], lock["revision"]) != (DEFAULT_MODEL, DEFAULT_REVISION):
        raise ModelMismatch(
            f"{lock_path} pins {lock['repo']}@{lock['revision']}, not {DEFAULT_MODEL}@{DEFAULT_REVISION}")
    return Resolved(configured, False, lock["revision"], str(lock_path),
                    model_name(lock["repo"], lock["revision"]))


def hub_directory(lock) -> Path:
    """Where the default model's files are kept once fetched by name: one
    directory per locked revision under the Hugging Face cache (HF_HOME, else
    XDG_CACHE_HOME/huggingface, else ~/.cache/huggingface)."""
    base = os.environ.get("HF_HOME", "").strip()
    if not base:
        xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
        base = str(Path(xdg) / "huggingface") if xdg else str(Path.home() / ".cache" / "huggingface")
    return Path(base) / "polis-embedding" / f"{lock['name']}@{lock['revision']}"


def _fetched(lock_path, lock) -> Path:
    """The default model's files, fetched by name once at the lock's revision.
    A first fetch goes to a private directory and takes the shared name only
    after it verifies, so an interrupted or mismatched download never stands in
    for the model; ``load`` checks the shared directory again before every load."""
    dest = hub_directory(lock)
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.parent / f".{dest.name}.{os.getpid()}.partial"
        shutil.rmtree(partial, ignore_errors=True)
        try:
            fetch(lock_path, partial)
            try:
                os.replace(partial, dest)
            except OSError:
                if not dest.exists():  # not a concurrent fetch that won the name
                    raise
        finally:
            shutil.rmtree(partial, ignore_errors=True)
    return dest


def load(device: Optional[str] = None, *, resolved: Optional[Resolved] = None):
    """(SentenceTransformer truncated to DIMS, Resolved). Files under a lock are
    checked against it before any model is built, and read with no network: the
    directory DELPHI_EMBED_MODEL_PATH names, or the default model's files fetched
    by name (``_fetched``). A file that differs refuses the run. Another model
    name is loaded from the hub as given, unchecked."""
    from sentence_transformers import SentenceTransformer

    resolved = resolved or resolve()
    arg, local = resolved.arg, resolved.local
    if resolved.lock:
        lock = read_lock(resolved.lock)
        if not resolved.local:
            arg = str(_fetched(resolved.lock, lock))
        verify(arg, lock)
        local = True
    kwargs = {"truncate_dim": DIMS, "local_files_only": local}
    if device:
        kwargs["device"] = device
    return SentenceTransformer(arg, **kwargs), resolved


def encode(model, texts: List[str], *, normalize_embeddings: bool = True, **kwargs):
    """Unit vectors by default; truncation happens before normalization.

    The legacy MiniLM graph explicitly disables normalization to preserve its
    existing stored bytes. Granite callers keep the default.
    """
    return model.encode(texts, normalize_embeddings=normalize_embeddings, **kwargs)


def encode_digest(model_arg: str, texts: List[str], local_files_only: bool,
                  revision: Optional[str] = None) -> Dict:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    kwargs = {"local_files_only": local_files_only, "truncate_dim": DIMS}
    if revision:
        kwargs["revision"] = revision
    model = SentenceTransformer(model_arg, **kwargs)
    vectors = encode(model, texts, show_progress_bar=False)
    vectors = np.ascontiguousarray(vectors)
    return {
        "shape": list(vectors.shape),
        "dtype": str(vectors.dtype),
        "sha256": hashlib.sha256(vectors.tobytes()).hexdigest(),
        "vectors": vectors,
    }


def compare(name: str, directory: str, texts: List[str]) -> Dict:
    by_name = encode_digest(name, texts, local_files_only=False, revision=_revision_for(name))
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
    c.add_argument("--name", default=DEFAULT_MODEL)
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
