"""Guard tests: the codebase must not reference Anthropic model ids that have
been retired.

A retired model id returns HTTP 404 from the Anthropic Models API, which
silently breaks every LLM code path that falls through to it as a default.
The ids below were verified retired (404) against the live Models API on
2026-07-04; their live replacements are ``claude-opus-4-8`` (Opus tier) and
``claude-sonnet-5`` (Sonnet tier).
"""

import os
import pathlib
import sys

# Mirror the existing delphi test convention for importing umap_narrative modules.
UMAP_NARRATIVE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "umap_narrative")
)
if UMAP_NARRATIVE_DIR not in sys.path:
    sys.path.insert(0, UMAP_NARRATIVE_DIR)

from llm_factory_constructor.model_provider import AnthropicProvider  # noqa: E402

# Anthropic model ids that are retired and return HTTP 404 from the Models API.
RETIRED_MODEL_IDS = frozenset(
    {
        "claude-3-5-sonnet-20241022",
        "claude-3-7-sonnet-20250219",
        "claude-opus-4-20250514",
    }
)

DELPHI_ROOT = pathlib.Path(__file__).resolve().parents[1]
_THIS_FILE = pathlib.Path(__file__).resolve()
_EXCLUDED_DIR_NAMES = {
    ".venv",
    "venv",
    "site-packages",
    "__pycache__",
    "node_modules",
    ".git",
    "scratch",
    "real_data",
    ".local",
    "build",
    "dist",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}


def _delphi_python_sources():
    # os.walk (not Path.rglob) so excluded directories are pruned in-place and
    # never descended into -- a local ``.venv`` holds tens of thousands of
    # vendored .py files, and rglob would enumerate and stat every one of them
    # on each run before filtering.
    for dirpath, dirnames, filenames in os.walk(DELPHI_ROOT):
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDED_DIR_NAMES]
        for name in filenames:
            if not name.endswith(".py"):
                continue
            path = pathlib.Path(dirpath) / name
            if path.resolve() == _THIS_FILE:
                continue  # this guard names the retired ids on purpose
            yield path


def test_anthropic_provider_advertises_no_retired_models():
    advertised = set(AnthropicProvider(api_key="test").list_available_models())
    leaked = advertised & RETIRED_MODEL_IDS
    assert not leaked, (
        "AnthropicProvider.list_available_models() advertises retired "
        f"(HTTP 404) model ids: {sorted(leaked)}"
    )


def test_delphi_source_references_no_retired_model_ids():
    offenders = []
    for path in _delphi_python_sources():
        text = path.read_text(encoding="utf-8", errors="ignore")
        for model_id in RETIRED_MODEL_IDS:
            if model_id in text:
                offenders.append(f"{path.relative_to(DELPHI_ROOT)}: {model_id}")
    assert not offenders, (
        "Retired Anthropic model ids found in delphi source:\n"
        + "\n".join(sorted(offenders))
    )
