"""The embedding model carried in the image: the lock, the check and the switch.

What this pins:
  * the repository's lock names one revision of all-MiniLM-L6-v2 and the
    exact files the model is loaded from, weights included;
  * a directory is accepted only when it holds exactly the lock's files, each
    with the lock's SHA-256 (a missing, extra or altered file refuses);
  * DELPHI_EMBED_MODEL_PATH unset keeps today's behaviour: the stage loads the
    model by name; set, it names the directory, checked first when
    DELPHI_EMBED_MODEL_LOCK is set;
  * the Dockerfile fetches by the lock and copies the result into the final
    stage, and puts no switch into the image's environment;
  * inside an image built from this checkout (the directory exists), the
    carried files are the lock's and the model encodes with the network
    forbidden.
"""

import hashlib
import json
import os
import re
from pathlib import Path

import pytest

from polismath import embedding_model as em



def _checkout_delphi():
    """The checkout's delphi/ directory: under $POLIS_CHECKOUT_DIR when set (the
    test container, where scripts/test-deploy-hooks.sh copies the Dockerfile,
    the .dockerignore and the lock), else this file's parent's parent."""
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    if override and (Path(override) / "delphi" / "Dockerfile").is_file():
        return Path(override) / "delphi"
    return Path(__file__).resolve().parents[1]


DELPHI_ROOT = _checkout_delphi()
LOCK = DELPHI_ROOT / "embedding-model.lock.json"
requires_checkout = pytest.mark.skipif(
    not (DELPHI_ROOT / "Dockerfile").is_file() or not LOCK.is_file(),
    reason="needs the checkout's delphi/Dockerfile and lock (POLIS_CHECKOUT_DIR)")
IMAGE_DIR = Path("/opt/polis/embedding/all-MiniLM-L6-v2")
IMAGE_LOCK = Path("/opt/polis/embedding/all-MiniLM-L6-v2.lock.json")


@requires_checkout
def test_the_repository_lock_pins_one_revision_and_the_loading_files():
    lock = em.read_lock(LOCK)
    assert lock["repo"] == "sentence-transformers/all-MiniLM-L6-v2"
    assert lock["name"] == "all-MiniLM-L6-v2"
    assert re.fullmatch(r"[0-9a-f]{40}", lock["revision"])
    names = set(lock["files"])
    # What SentenceTransformer reads for this model, and nothing it does not.
    assert {"modules.json", "config.json", "model.safetensors", "1_Pooling/config.json",
            "tokenizer.json", "vocab.txt"} <= names
    assert not any(n.endswith((".onnx", ".bin", ".h5", ".ot")) for n in names)
    assert all(re.fullmatch(r"[0-9a-f]{64}", d) for d in lock["files"].values())


def _fake(tmp_path):
    root = tmp_path / "model"
    files = {"model.safetensors": b"weights", "config.json": b"{}", "1_Pooling/config.json": b"{}"}
    for name, data in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)
    lock = {"schema": em.LOCK_SCHEMA, "name": "m", "repo": "r/m", "revision": "0" * 40,
            "files": {n: hashlib.sha256(d).hexdigest() for n, d in files.items()}}
    lock_path = tmp_path / "lock.json"
    lock_path.write_text(json.dumps(lock))
    return root, lock_path


def test_verify_accepts_exactly_the_lock(tmp_path):
    root, lock_path = _fake(tmp_path)
    em.verify(root, em.read_lock(lock_path))


@pytest.mark.parametrize("change", ["extra", "missing", "altered"])
def test_verify_refuses_any_difference(tmp_path, change):
    root, lock_path = _fake(tmp_path)
    if change == "extra":
        (root / "pytorch_model.bin").write_bytes(b"other")
    elif change == "missing":
        (root / "config.json").unlink()
    else:
        (root / "model.safetensors").write_bytes(b"weightz")
    with pytest.raises(em.ModelMismatch):
        em.verify(root, em.read_lock(lock_path))


def test_the_switch_unset_loads_by_name_as_before(monkeypatch):
    monkeypatch.delenv("DELPHI_EMBED_MODEL_PATH", raising=False)
    monkeypatch.delenv("SENTENCE_TRANSFORMER_MODEL", raising=False)
    assert em.load_check() == "all-MiniLM-L6-v2"
    monkeypatch.setenv("DELPHI_EMBED_MODEL_PATH", "  ")
    assert em.load_check() == "all-MiniLM-L6-v2"


def test_the_switch_set_names_the_directory_and_checks_it(tmp_path, monkeypatch):
    root, lock_path = _fake(tmp_path)
    monkeypatch.setenv("DELPHI_EMBED_MODEL_PATH", str(root))
    monkeypatch.delenv("DELPHI_EMBED_MODEL_LOCK", raising=False)
    assert em.load_check() == str(root)
    monkeypatch.setenv("DELPHI_EMBED_MODEL_LOCK", str(lock_path))
    assert em.load_check() == str(root)
    (root / "model.safetensors").write_bytes(b"tampered")
    with pytest.raises(em.ModelMismatch):
        em.load_check()


def _stages(text):
    stages, name = {}, None
    for line in text.splitlines():
        m = re.match(r"\s*FROM\s+\S+\s+AS\s+(\S+)", line)
        if m:
            name = m.group(1)
            stages[name] = []
        elif name:
            stages[name].append(line)
    return {k: "\n".join(v) for k, v in stages.items()}


@requires_checkout
def test_the_dockerfile_fetches_by_the_lock_and_sets_no_switch():
    text = (DELPHI_ROOT / "Dockerfile").read_text()
    stages = _stages(text)
    fetch = stages["embedding-model"]
    assert "embedding-model.lock.json" in fetch and "embedding_model.py fetch" in fetch
    final = stages["final"]
    assert "COPY --from=embedding-model /opt/polis/embedding /opt/polis/embedding" in final
    # Today's runs are unchanged: no image sets the switch for every service.
    assert "DELPHI_EMBED_MODEL_PATH" not in final
    ignore = (DELPHI_ROOT / ".dockerignore").read_text().splitlines()
    assert "!embedding-model.lock.json" in ignore
    assert ignore.index("!embedding-model.lock.json") > ignore.index("*.json")


carried = pytest.mark.skipif(not IMAGE_DIR.is_dir(), reason="runs inside an image built from delphi/Dockerfile")


@carried
def test_the_image_carries_the_lock_and_its_files():
    if LOCK.is_file():
        assert IMAGE_LOCK.read_bytes() == LOCK.read_bytes()
    em.verify(IMAGE_DIR, em.read_lock(IMAGE_LOCK))


@carried
def test_the_carried_model_encodes_with_the_network_forbidden(monkeypatch, tmp_path):
    import socket

    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")
    monkeypatch.setenv("HF_HOME", str(tmp_path / "empty-cache"))

    def refuse(*args, **kwargs):
        raise AssertionError("the network was used")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setenv("DELPHI_EMBED_MODEL_PATH", str(IMAGE_DIR))
    monkeypatch.setenv("DELPHI_EMBED_MODEL_LOCK", str(IMAGE_LOCK))
    result = em.encode_digest(em.load_check(), ["a comment about rivers", "another about trees"],
                              local_files_only=True)
    assert result["shape"] == [2, 384]
    assert result["dtype"] == "float32"
