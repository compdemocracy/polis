"""The embedding model carried in the image: the lock, the check and the switch.

What this pins:
  * the repository's lock names one revision of
    granite-embedding-311m-multilingual-r2 and the exact files the model is
    loaded from, weights included, and the module's default model and pinned
    revision are the lock's;
  * a directory is accepted only when it holds exactly the lock's files, each
    with the lock's SHA-256 (a missing, extra or altered file refuses);
  * DELPHI_EMBED_MODEL_PATH unset: the default model is fetched by name once,
    at the shipped lock's revision, and every load checks those files against
    the lock before a model is built (a changed byte or another revision's
    files refuse); any other name is loaded as given, unchecked; set, it names
    the directory, checked first when DELPHI_EMBED_MODEL_LOCK is set;
  * the shipped lock is found in a checkout and where the image installs it;
  * a run's model is named repo@revision:384 from the lock, or from the pinned
    default; a directory without its lock, or a SENTENCE_TRANSFORMER_MODEL that
    names another model than the directory's, refuses;
  * the Dockerfile fetches by the lock and copies the result into the final
    stage, and puts no switch into the image's environment;
  * inside an image built from this checkout (the directory exists), the
    carried files are the lock's, the model encodes 384-wide unit vectors with
    the network forbidden, and those equal the full 768-wide output sliced to
    384 and renormalized.
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
IMAGE_DIR = Path("/opt/polis/embedding/granite-embedding-311m-multilingual-r2")
IMAGE_LOCK = Path("/opt/polis/embedding/granite-embedding-311m-multilingual-r2.lock.json")
GRANITE = ("ibm-granite/granite-embedding-311m-multilingual-r2"
           "@44399559930365213510b1ee2eb15ded83374f0e:384")


@requires_checkout
def test_the_repository_lock_pins_one_revision_and_the_loading_files():
    lock = em.read_lock(LOCK)
    assert lock["repo"] == "ibm-granite/granite-embedding-311m-multilingual-r2"
    assert lock["name"] == "granite-embedding-311m-multilingual-r2"
    assert re.fullmatch(r"[0-9a-f]{40}", lock["revision"])
    names = set(lock["files"])
    # What SentenceTransformer reads for this model, and nothing it does not.
    assert {"modules.json", "config.json", "config_sentence_transformers.json", "model.safetensors",
            "1_Pooling/config.json", "tokenizer.json", "tokenizer_config.json"} <= names
    assert not any(n.endswith((".onnx", ".bin", ".h5", ".ot", ".xml")) for n in names)
    assert all(re.fullmatch(r"[0-9a-f]{64}", d) for d in lock["files"].values())


def _migrations_dir():
    """server/postgres/migrations: POLIS_MIGRATIONS_DIR when set, else the
    checkout this file sits in; None when neither exists (an image's /app)."""
    override = os.environ.get("POLIS_MIGRATIONS_DIR")
    if override:
        return Path(override)
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "server" / "postgres" / "migrations"
        if candidate.is_dir():
            return candidate
    return None


def test_every_store_names_granite_as_the_migration_inserts_it():
    from polismath.delphi_storage import production_import as imp
    from umap_narrative.polismath_commentgraph.utils.storage import DynamoDBStorage

    assert em.model_name(em.DEFAULT_MODEL, em.DEFAULT_REVISION) == GRANITE
    assert imp.EMBEDDING_MODEL_ALIASES[GRANITE] == GRANITE == imp.GRANITE_EMBEDDING_MODEL
    assert DynamoDBStorage._EMBEDDING_MODEL_ALIASES[GRANITE] == GRANITE
    # The bare repository name names no revision or width, so it has no row.
    assert em.DEFAULT_MODEL not in imp.EMBEDDING_MODEL_ALIASES
    assert em.DEFAULT_MODEL not in DynamoDBStorage._EMBEDDING_MODEL_ALIASES
    migrations = _migrations_dir()
    if migrations is None:
        pytest.skip("needs server/postgres/migrations (a checkout or POLIS_MIGRATIONS_DIR)")
    sql = (migrations / "000046_add_granite_embedding_model.sql").read_text()
    assert f"INSERT INTO public.delphi_embedding_models VALUES(2,'{GRANITE}',{em.DIMS});" in sql


@requires_checkout
def test_the_default_model_and_its_pinned_revision_are_the_locks():
    lock = em.read_lock(LOCK)
    assert (em.DEFAULT_MODEL, em.DEFAULT_REVISION) == (lock["repo"], lock["revision"])
    assert em.model_name(lock["repo"], lock["revision"]) == GRANITE
    # The Dockerfile's directory is named after the lock.
    assert IMAGE_DIR.name == lock["name"]


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


def test_the_switch_unset_loads_by_name(monkeypatch):
    monkeypatch.delenv("DELPHI_EMBED_MODEL_PATH", raising=False)
    monkeypatch.delenv("SENTENCE_TRANSFORMER_MODEL", raising=False)
    assert em.load_check() == em.DEFAULT_MODEL
    monkeypatch.setenv("DELPHI_EMBED_MODEL_PATH", "  ")
    assert em.load_check() == em.DEFAULT_MODEL


def test_by_name_the_default_is_pinned_and_named_with_its_revision(monkeypatch):
    monkeypatch.delenv("DELPHI_EMBED_MODEL_PATH", raising=False)
    monkeypatch.delenv("DELPHI_EMBED_MODEL_LOCK", raising=False)
    for configured in (None, "", em.DEFAULT_MODEL):
        if configured is None:
            monkeypatch.delenv("SENTENCE_TRANSFORMER_MODEL", raising=False)
        else:
            monkeypatch.setenv("SENTENCE_TRANSFORMER_MODEL", configured)
        r = em.resolve()
        assert (r.arg, r.local, r.revision, r.lock, r.model) == (
            em.DEFAULT_MODEL, False, em.DEFAULT_REVISION, str(em.DEFAULT_LOCK), GRANITE)
    # Any other name is loaded as given, unpinned, and recorded as given.
    monkeypatch.setenv("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
    r = em.resolve()
    assert (r.arg, r.local, r.revision, r.model) == ("all-MiniLM-L6-v2", False, None, "all-MiniLM-L6-v2")


def test_a_directory_is_named_from_its_lock_and_never_under_another_name(tmp_path, monkeypatch):
    root, lock_path = _fake(tmp_path)
    monkeypatch.setenv("DELPHI_EMBED_MODEL_PATH", str(root))
    monkeypatch.setenv("DELPHI_EMBED_MODEL_LOCK", str(lock_path))
    for configured in (None, "r/m", "m", "r/m@" + "0" * 40 + ":384"):
        if configured is None:
            monkeypatch.delenv("SENTENCE_TRANSFORMER_MODEL", raising=False)
        else:
            monkeypatch.setenv("SENTENCE_TRANSFORMER_MODEL", configured)
        r = em.resolve()
        assert (r.arg, r.local, r.revision, r.lock, r.model) == (
            str(root), True, None, str(lock_path), "r/m@" + "0" * 40 + ":384")
    # A name for another model than the directory holds refuses: its vectors
    # would otherwise be stored under that model.
    for other in ("all-MiniLM-L6-v2", em.DEFAULT_MODEL, GRANITE):
        monkeypatch.setenv("SENTENCE_TRANSFORMER_MODEL", other)
        with pytest.raises(em.ModelMismatch):
            em.resolve()
    # A directory without its lock cannot be named.
    monkeypatch.delenv("DELPHI_EMBED_MODEL_LOCK")
    monkeypatch.delenv("SENTENCE_TRANSFORMER_MODEL")
    with pytest.raises(em.ModelMismatch):
        em.resolve()


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


# --- the default model by name, with no directory set (a worker box, a developer
# outside the image): the files are fetched at the lock's revision, checked
# against the lock, and loaded from that checked directory; anything else is
# refused before a model is built. Only the hub download and the
# SentenceTransformer constructor are replaced.

_LOCKED = {"model.safetensors": b"locked weights", "config.json": b'{"hidden_size": 768}',
           "1_Pooling/config.json": b'{"pooling_mode_cls_token": true}'}


@pytest.fixture
def by_name(tmp_path, monkeypatch):
    import sys
    import types

    lock = {"schema": em.LOCK_SCHEMA, "name": "granite-embedding-311m-multilingual-r2",
            "repo": em.DEFAULT_MODEL, "revision": em.DEFAULT_REVISION,
            "files": {n: hashlib.sha256(d).hexdigest() for n, d in _LOCKED.items()}}
    lock_path = tmp_path / "shipped.lock.json"
    lock_path.write_text(json.dumps(lock))
    for key in ("DELPHI_EMBED_MODEL_PATH", "DELPHI_EMBED_MODEL_LOCK", "SENTENCE_TRANSFORMER_MODEL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf"))
    monkeypatch.setattr(em, "DEFAULT_LOCK", lock_path)
    hub = types.SimpleNamespace(served=dict(_LOCKED), requests=[], built=[])

    def snapshot_download(repo, revision=None, allow_patterns=None, local_dir=None, **kwargs):
        hub.requests.append((repo, revision, local_dir is not None))
        for name, data in hub.served.items():
            path = Path(local_dir) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return local_dir

    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(snapshot_download=snapshot_download))
    monkeypatch.setitem(sys.modules, "sentence_transformers", types.SimpleNamespace(
        SentenceTransformer=lambda arg, **kwargs: hub.built.append((arg, kwargs)) or object()))
    return hub


def test_by_name_the_default_is_fetched_at_the_lock_revision_checked_and_loaded_from_that_directory(by_name):
    _, resolved = em.load()
    assert by_name.requests == [(em.DEFAULT_MODEL, em.DEFAULT_REVISION, True)]
    ((arg, kwargs),) = by_name.built
    # Built from the checked local directory, never from the hub name.
    assert arg != em.DEFAULT_MODEL and Path(arg).is_dir()
    assert kwargs["local_files_only"] is True and kwargs["truncate_dim"] == 384 and "revision" not in kwargs
    em.verify(arg, em.read_lock(em.DEFAULT_LOCK))
    assert resolved.model == GRANITE and resolved.lock == str(em.DEFAULT_LOCK)
    # A later load reads the same checked directory again, with no download.
    em.load()
    assert len(by_name.requests) == 1 and by_name.built[1][0] == arg


def test_by_name_a_one_byte_change_is_refused_before_any_model_is_built(by_name):
    # As served: a parseable config one byte off the lock.
    by_name.served["config.json"] = b'{"hidden_size": 769}'
    with pytest.raises(em.ModelMismatch):
        em.load()
    assert by_name.built == []


def _seed_stored_copy():
    """The locked files where a by-name fetch keeps them, written directly (not by
    the code under test): <HF_HOME>/polis-embedding/<lock name>@<revision>."""
    stored = (Path(os.environ["HF_HOME"]) / "polis-embedding"
              / f"granite-embedding-311m-multilingual-r2@{em.DEFAULT_REVISION}")
    for name, data in _LOCKED.items():
        (stored / name).parent.mkdir(parents=True, exist_ok=True)
        (stored / name).write_bytes(data)
    return stored


def test_by_name_a_stored_copy_changed_by_one_byte_is_refused_before_any_model_is_built(by_name):
    stored = _seed_stored_copy()
    (stored / "config.json").write_bytes(b'{"hidden_size": 769}')
    with pytest.raises(em.ModelMismatch):
        em.load()
    # Refused from the stored copy itself: nothing fetched, no model built.
    assert by_name.built == [] and by_name.requests == []


def test_by_name_files_of_another_revision_are_refused(by_name):
    # The hub hands back another revision's files: other weights, a module the
    # lock does not name, and one it does missing.
    by_name.served = {"model.safetensors": b"other revision weights", "config.json": _LOCKED["config.json"],
                      "2_Normalize/config.json": b"{}"}
    with pytest.raises(em.ModelMismatch):
        em.load()
    assert by_name.built == []


def test_by_name_another_model_is_loaded_as_given_and_not_checked(by_name, monkeypatch):
    # An explicitly chosen model other than the default has no lock here: it is
    # loaded by name from the hub at whatever revision the hub serves, and is
    # recorded under the name as given.
    monkeypatch.setenv("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
    _, resolved = em.load()
    assert by_name.requests == []
    assert by_name.built == [("all-MiniLM-L6-v2", {"truncate_dim": 384, "local_files_only": False})]
    assert (resolved.model, resolved.lock) == ("all-MiniLM-L6-v2", None)


def test_the_shipped_lock_is_found_in_a_checkout_and_where_the_image_installs_it():
    # The checkout's lock beside this package, then the image's installed copy
    # (delphi/Dockerfile, the embedding-model stage); the module may be imported
    # from /app or from site-packages, so neither alone is enough.
    assert em.IMAGE_LOCK == IMAGE_LOCK
    assert em.DEFAULT_LOCK.is_file()
    assert em.DEFAULT_LOCK in (Path(em.__file__).resolve().parents[1] / "embedding-model.lock.json", IMAGE_LOCK)
    if LOCK.is_file():
        assert em.DEFAULT_LOCK.read_bytes() == LOCK.read_bytes()


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
    # Today's runs are unchanged: no ENV instruction of the final stage (or of
    # the test stage built on it) sets the switch for every service.
    for stage in ("final", "test"):
        assert not re.search(r"^\s*ENV\b[^\n]*DELPHI_EMBED_MODEL_(PATH|LOCK)", stages[stage], re.M), stage
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
    monkeypatch.delenv("SENTENCE_TRANSFORMER_MODEL", raising=False)
    result = em.encode_digest(em.load_check(), ["a comment about rivers", "another about trees"],
                              local_files_only=True)
    assert result["shape"] == [2, 384]
    assert result["dtype"] == "float32"
    model, resolved = em.load()
    assert resolved.model == GRANITE
    assert model.get_sentence_embedding_dimension() == 384


@carried
def test_the_carried_model_at_384_is_its_768_output_sliced_and_renormalized(monkeypatch):
    """Delphi's vectors (truncate_dim=384, normalize_embeddings=True) are the
    full output's first 384 values divided by their length: the method the
    model was measured with."""
    import numpy as np
    from sentence_transformers import SentenceTransformer

    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("DELPHI_EMBED_MODEL_PATH", str(IMAGE_DIR))
    monkeypatch.setenv("DELPHI_EMBED_MODEL_LOCK", str(IMAGE_LOCK))
    monkeypatch.delenv("SENTENCE_TRANSFORMER_MODEL", raising=False)
    texts = ["a comment about rivers", "Wir brauchen mehr Radwege in der Stadt.",
             "共享汽車應該合法化並且納稅", "電気バスなら町が静かになる"]
    model, _ = em.load()
    ours = em.encode(model, texts, show_progress_bar=False)
    full = SentenceTransformer(str(IMAGE_DIR), local_files_only=True).encode(texts, show_progress_bar=False)
    assert full.shape == (len(texts), 768)
    sliced = full[:, :384] / np.linalg.norm(full[:, :384], axis=1, keepdims=True)
    assert ours.shape == (len(texts), 384)
    np.testing.assert_allclose(np.linalg.norm(ours, axis=1), 1.0, atol=1e-6)
    np.testing.assert_allclose(ours, sliced, rtol=0, atol=1e-6)


def test_explicit_environment_default_retains_locked_by_name_load(monkeypatch):
    import json
    from polismath import embedding_model as model
    monkeypatch.delenv('DELPHI_EMBED_MODEL_PATH', raising=False)
    monkeypatch.delenv('SENTENCE_TRANSFORMER_MODEL', raising=False)
    monkeypatch.setenv('DELPHI_RESULT_ENV', 'shadow-example')
    monkeypatch.setenv('DELPHI_EMBED_MODEL_BY_ENV', json.dumps({'shadow-example': model.DEFAULT_IDENTITY}))
    resolved = model.resolve()
    assert resolved.arg == model.DEFAULT_MODEL
    assert resolved.model == model.DEFAULT_IDENTITY
    assert resolved.lock and resolved.revision == model.DEFAULT_REVISION
