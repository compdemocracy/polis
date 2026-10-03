"""OFFLINE reaches the services that act on it, and the Delphi image can carry
its embedding model.

The server reads OFFLINE (1 or true) to skip the hosted services it would
otherwise call (see server/src/utils/offline.ts). Compose forwards it by name,
empty by default, so an unset flag changes nothing.
"""

import re
import subprocess
from pathlib import Path

import pytest
import yaml

from polismath.utils.offline_env import HF_OFFLINE_FLAGS, apply_offline_env, is_offline
from tests.test_compose_math_env import (
    CHECKOUT,
    DOCKERFILE,
    _environment,
    _interpolate,
    requires_checkout,
    requires_dockerfile,
)


@requires_checkout
def test_server_forwards_offline_empty_by_default():
    assert _environment("docker-compose.yml", "server")["OFFLINE"] == ""


@requires_checkout
def test_server_forwards_offline_when_set():
    assert _environment("docker-compose.yml", "server", {"OFFLINE": "1"})["OFFLINE"] == "1"


# --- Delphi: the embedding model on a box with no network --------------------
# BAKE_EMBEDDING_MODEL=true (build arg, default false) downloads the
# sentence-transformer model into the image; OFFLINE=1 (or true) at runtime
# sets HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE so no first run reaches the hub.


DEFAULT_MODEL = "all-MiniLM-L6-v2"


@requires_checkout
def test_delphi_forwards_offline():
    assert _environment("docker-compose.yml", "delphi")["OFFLINE"] == ""
    assert _environment("docker-compose.yml", "delphi", {"OFFLINE": "1"})["OFFLINE"] == "1"


@requires_checkout
def test_delphi_forwards_the_model_name_with_the_image_default():
    assert _environment("docker-compose.yml", "delphi")["SENTENCE_TRANSFORMER_MODEL"] == DEFAULT_MODEL
    chosen = {"SENTENCE_TRANSFORMER_MODEL": "paraphrase-multilingual-MiniLM-L12-v2"}
    assert _environment("docker-compose.yml", "delphi", chosen)["SENTENCE_TRANSFORMER_MODEL"] == chosen[
        "SENTENCE_TRANSFORMER_MODEL"
    ]


def _build_args(service: str, env: dict | None = None) -> dict:
    document = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())
    args = document["services"][service]["build"].get("args") or {}
    return {key: _interpolate(str(value), env or {}) for key, value in args.items()}


@requires_checkout
@pytest.mark.parametrize("service", ["delphi", "math-python"])
def test_bake_is_off_by_default_and_forwarded(service):
    assert _build_args(service) == {"BAKE_EMBEDDING_MODEL": "false", "SENTENCE_TRANSFORMER_MODEL": DEFAULT_MODEL}
    on = _build_args(service, {"BAKE_EMBEDDING_MODEL": "true"})
    assert on["BAKE_EMBEDDING_MODEL"] == "true"


@requires_checkout
def test_services_sharing_the_image_tag_build_it_the_same_way():
    services = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())["services"]
    assert services["delphi"]["image"] == services["math-python"]["image"]
    assert services["delphi"]["build"]["args"] == services["math-python"]["build"]["args"]


def _stage(name: str) -> str:
    """The text of one Dockerfile stage, from its FROM line to the next FROM."""
    text = DOCKERFILE.read_text()
    match = re.search(rf"^[ \t]*FROM \S+ AS {re.escape(name)}$", text, re.M)
    following = re.search(r"^[ \t]*FROM ", text[match.end():], re.M)
    return text[match.start():match.end() + following.start()] if following else text[match.start():]


@requires_dockerfile
def test_model_stage_builds_on_dependencies_only():
    # A source change must not re-download the model: the bake stage starts
    # from the dependency stage, which copies no project source.
    model = _stage("embedding-model")
    assert model.lstrip().startswith("FROM builder-deps AS embedding-model")
    assert "COPY" not in _stage("builder-deps").split("requirements.lock ./", 1)[1]
    assert "COPY polismath/" in _stage("builder")


@requires_dockerfile
def test_final_stage_copies_the_model_cache_into_root_before_the_packages():
    final = _stage("final")
    copy = "COPY --from=embedding-model /models/ /root/"
    assert copy in final
    assert final.index(copy) < final.index("COPY --from=builder")


@requires_dockerfile
def test_dockerfile_bake_defaults_match_compose():
    stage = _stage("embedding-model")
    assert re.search(r"^ARG BAKE_EMBEDDING_MODEL=false$", stage, re.M)
    assert re.search(rf"^ARG SENTENCE_TRANSFORMER_MODEL={re.escape(DEFAULT_MODEL)}$", stage, re.M)


def _bake_run() -> str:
    """The shell of the model stage's bake RUN, continuations joined."""
    stage = _stage("embedding-model")
    start = stage.index('RUN if [ "$BAKE_EMBEDDING_MODEL"')
    end = stage.index("fi\n", start) + len("fi")
    return stage[start + len("RUN "):end].replace("\\\n", "")


@requires_dockerfile
@pytest.mark.parametrize(
    "bake,model,expected",
    [
        ("false", DEFAULT_MODEL, []),
        ("", DEFAULT_MODEL, []),
        ("1", DEFAULT_MODEL, []),
        ("true", DEFAULT_MODEL, [f"/models {DEFAULT_MODEL}"]),
        ("true", "paraphrase-multilingual-MiniLM-L12-v2", ["/models paraphrase-multilingual-MiniLM-L12-v2"]),
    ],
)
def test_bake_step_downloads_only_when_true(tmp_path, bake, model, expected):
    log = tmp_path / "calls"
    log.touch()
    (tmp_path / "python").write_text(f'#!/bin/sh\nfor a; do last="$a"; done\necho "$HOME $last" >> "{log}"\n')
    (tmp_path / "python").chmod(0o755)
    env = {"PATH": f"{tmp_path}:/usr/bin:/bin", "BAKE_EMBEDDING_MODEL": bake, "SENTENCE_TRANSFORMER_MODEL": model}
    subprocess.run(["sh", "-c", _bake_run()], env=env, check=True, capture_output=True, timeout=30)
    assert log.read_text().splitlines() == expected


@requires_dockerfile
def test_a_failed_download_fails_the_build(tmp_path):
    (tmp_path / "python").write_text("#!/bin/sh\nexit 1\n")
    (tmp_path / "python").chmod(0o755)
    env = {"PATH": f"{tmp_path}:/usr/bin:/bin", "BAKE_EMBEDDING_MODEL": "true", "SENTENCE_TRANSFORMER_MODEL": DEFAULT_MODEL}
    assert subprocess.run(["sh", "-c", _bake_run()], env=env, capture_output=True, timeout=30).returncode != 0


@pytest.mark.parametrize(
    "value,offline",
    [(None, False), ("", False), ("0", False), ("false", False), ("yes", False),
     ("1", True), ("true", True), ("TRUE", True), (" 1 ", True)],
)
def test_offline_values(value, offline):
    env = {} if value is None else {"OFFLINE": value}
    assert is_offline(env) is offline
    applied = apply_offline_env(env)
    assert applied is offline
    for key, flag in HF_OFFLINE_FLAGS.items():
        assert (env.get(key) == flag) is offline


def test_unset_offline_leaves_existing_hf_settings_alone():
    env = {"HF_HUB_OFFLINE": "0"}
    apply_offline_env(env)
    assert env == {"HF_HUB_OFFLINE": "0"}


def test_flag_names_are_the_ones_the_hf_libraries_read():
    assert HF_OFFLINE_FLAGS == {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}


@pytest.mark.parametrize(
    "path,needle",
    [
        ("scripts/job_poller.py", "apply_offline_env()"),
        ("run_delphi.py", "apply_offline_env()"),
    ],
)
def test_job_spawners_apply_the_flags_before_spawning(path, needle):
    # The pipeline children read the flags at import; the spawners set them
    # on their own environment, which every child inherits.
    source = (Path(__file__).resolve().parent.parent / path).read_text()
    main = source[source.index("def main("):]
    assert needle in main
    assert main.index(needle) < main.index("subprocess" if "run_delphi" in path else "JobProcessor(")


@pytest.mark.parametrize("cache_dir", [None, "cache"])
@pytest.mark.parametrize("value,local_only", [(None, False), ("1", True), ("true", True), ("0", False)])
def test_embedding_engine_loads_local_files_only_when_offline(monkeypatch, tmp_path, cache_dir, value, local_only):
    from umap_narrative.polismath_commentgraph.core import embedding

    seen = {}

    class Model:
        def get_sentence_embedding_dimension(self):
            return 384

    def fake(name, **kwargs):
        seen.update(kwargs, name=name)
        return Model()

    monkeypatch.setattr(embedding, "SentenceTransformer", fake)
    if value is None:
        monkeypatch.delenv("OFFLINE", raising=False)
    else:
        monkeypatch.setenv("OFFLINE", value)
    engine = embedding.EmbeddingEngine(
        model_name=DEFAULT_MODEL, cache_dir=str(tmp_path / cache_dir) if cache_dir else None, device="cpu"
    )
    engine.model
    assert seen["name"] == DEFAULT_MODEL
    assert seen["local_files_only"] is local_only
