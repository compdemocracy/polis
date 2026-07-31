"""Tests for the in-process / subprocess stage runner (stages/runner.py).

These lock down the mechanical-transformation contract of the run_delphi
orchestration refactor:

* every stage module imports cleanly with no network/DynamoDB access at import
  time, and quickly;
* each numbered CLI shim delegates to the right stage module;
* ``run_stage`` dispatches in-process vs subprocess per the isolation flag, and
  faithfully converts a stage's outcome (return value, ``sys.exit``, argparse
  error, or crash) into a subprocess-style exit code;
* two stages' ``main(argv)`` calls do not pollute one another via global
  ``sys.argv``.
"""

import argparse
import os
import subprocess
import sys
import textwrap
import time

import pytest

# Put umap_narrative/ on sys.path so ``stages.*`` resolves as a top-level
# package (the same convention the numbered scripts and the runner rely on).
_UMAP_NARRATIVE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "umap_narrative")
)
if _UMAP_NARRATIVE_DIR not in sys.path:
    sys.path.insert(0, _UMAP_NARRATIVE_DIR)

from stages import runner  # noqa: E402
from stages.runner import (  # noqa: E402
    ISOLATION_IN_PROCESS,
    ISOLATION_SUBPROCESS,
    STAGES,
    Stage,
    default_isolation,
    run_stage,
)


# --------------------------------------------------------------------------- #
# default_isolation / env flag
# --------------------------------------------------------------------------- #


def test_default_isolation_is_in_process(monkeypatch):
    monkeypatch.delenv("DELPHI_STAGE_ISOLATION", raising=False)
    assert default_isolation() == ISOLATION_IN_PROCESS


@pytest.mark.parametrize("value", ["subprocess", "  subprocess  ", "SUBPROCESS"])
def test_default_isolation_subprocess_flag(monkeypatch, value):
    monkeypatch.setenv("DELPHI_STAGE_ISOLATION", value)
    assert default_isolation() == ISOLATION_SUBPROCESS


def test_default_isolation_unknown_value_falls_back_in_process(monkeypatch):
    monkeypatch.setenv("DELPHI_STAGE_ISOLATION", "yes-please")
    assert default_isolation() == ISOLATION_IN_PROCESS


# --------------------------------------------------------------------------- #
# run_stage — in-process dispatch and outcome conversion
# --------------------------------------------------------------------------- #


def test_in_process_returns_target_code():
    seen = {}

    def target(argv):
        seen["argv"] = argv
        return 5

    stage = Stage("fake", "unused.py", target)
    assert run_stage(stage, ["--x", "1"], ISOLATION_IN_PROCESS) == 5
    assert seen["argv"] == ["--x", "1"]


def test_in_process_none_return_is_zero():
    stage = Stage("fake", "unused.py", lambda argv: None)
    assert run_stage(stage, [], ISOLATION_IN_PROCESS) == 0


def test_in_process_sys_exit_code_is_preserved():
    def target(argv):
        sys.exit(3)

    stage = Stage("fake", "unused.py", target)
    assert run_stage(stage, [], ISOLATION_IN_PROCESS) == 3


def test_in_process_bare_sys_exit_is_zero():
    def target(argv):
        sys.exit()

    stage = Stage("fake", "unused.py", target)
    assert run_stage(stage, [], ISOLATION_IN_PROCESS) == 0


def test_in_process_argparse_error_returns_two():
    def target(argv):
        parser = argparse.ArgumentParser()
        parser.add_argument("--known")
        parser.parse_args(argv)  # unknown arg -> argparse SystemExit(2)
        return 0

    stage = Stage("fake", "unused.py", target)
    assert run_stage(stage, ["--nope"], ISOLATION_IN_PROCESS) == 2


def test_in_process_exception_returns_nonzero():
    def target(argv):
        raise RuntimeError("boom")

    stage = Stage("fake", "unused.py", target)
    assert run_stage(stage, [], ISOLATION_IN_PROCESS) == 1


# --------------------------------------------------------------------------- #
# run_stage — subprocess dispatch and env-flag routing
# --------------------------------------------------------------------------- #


def _write_fake_stage_script(tmp_path, marker):
    """A trivial standalone stage: writes a marker file, echoes argv, and exits
    with the integer value of its first CLI argument (default 0)."""
    script = tmp_path / "fake_stage.py"
    script.write_text(
        textwrap.dedent(
            f"""
            import sys
            with open({str(marker)!r}, "w") as fh:
                fh.write(" ".join(sys.argv[1:]))
            code = int(sys.argv[1]) if len(sys.argv) > 1 else 0
            sys.exit(code)
            """
        )
    )
    return script


def test_subprocess_runs_script_and_returns_exit_code(tmp_path):
    marker = tmp_path / "ran.txt"
    script = _write_fake_stage_script(tmp_path, marker)
    stage = Stage("fake", str(script))  # absolute path used as-is
    rc = run_stage(stage, ["7", "extra"], ISOLATION_SUBPROCESS)
    assert rc == 7
    assert marker.read_text() == "7 extra"


def test_env_flag_routes_to_subprocess(tmp_path, monkeypatch):
    marker = tmp_path / "ran.txt"
    script = _write_fake_stage_script(tmp_path, marker)
    # A target that would return 99 if ever called in-process.
    stage = Stage("fake", str(script), target=lambda argv: 99)
    monkeypatch.setenv("DELPHI_STAGE_ISOLATION", "subprocess")
    rc = run_stage(stage, ["0"])  # no explicit isolation -> env decides
    assert rc == 0
    assert marker.exists(), "expected the subprocess (not the in-process target) to run"


def test_subprocess_only_stage_is_pinned_even_in_process_mode(tmp_path):
    marker = tmp_path / "ran.txt"
    script = _write_fake_stage_script(tmp_path, marker)
    stage = Stage("subproc-only", str(script), target=None)
    rc = run_stage(stage, ["4"], ISOLATION_IN_PROCESS)  # requested in-process...
    assert rc == 4  # ...but target=None forces subprocess
    assert marker.exists()


# --------------------------------------------------------------------------- #
# argparse isolation — two stages must not leak state through sys.argv
# --------------------------------------------------------------------------- #


def test_argparse_isolation_between_stages(monkeypatch):
    # Poison sys.argv: a stage that (incorrectly) read it would parse 999.
    monkeypatch.setattr(sys, "argv", ["prog", "--value", "999"])

    def target(argv):
        parser = argparse.ArgumentParser()
        parser.add_argument("--value", type=int, required=True)
        return parser.parse_args(argv).value

    stage_a = Stage("a", "unused.py", target)
    stage_b = Stage("b", "unused.py", target)

    assert run_stage(stage_a, ["--value", "1"], ISOLATION_IN_PROCESS) == 1
    assert run_stage(stage_b, ["--value", "2"], ISOLATION_IN_PROCESS) == 2
    # sys.argv untouched throughout.
    assert sys.argv == ["prog", "--value", "999"]


# --------------------------------------------------------------------------- #
# Stage modules import cleanly, quickly, and with no network/DynamoDB at import
# --------------------------------------------------------------------------- #


# The heavy sub-orchestrator ``run_pipeline`` (sentence-transformers / torch /
# umap / evoc) is exercised by test_umap_narrative_pipeline; it is intentionally
# excluded from this fast import-hygiene bound.
_LIGHT_STAGE_MODULES = [
    "stages.comment_extremity",
    "stages.comment_priorities",
    "stages.datamapplot_layer",
]
_IMPORT_TIME_BUDGET_S = 30.0


@pytest.mark.parametrize("module_name", _LIGHT_STAGE_MODULES)
def test_stage_module_imports_without_network(module_name):
    """Importing a stage module must not touch DynamoDB/Postgres or hang.

    Runs the import in a fresh interpreter with DynamoDB/Postgres endpoints
    pointed at a non-routable host: if the module opened a connection at import
    time it would raise or hang (and blow the time budget) instead of importing
    cleanly.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = _UMAP_NARRATIVE_DIR + os.pathsep + env.get("PYTHONPATH", "")
    env["DYNAMODB_ENDPOINT"] = "http://10.255.255.1:1"  # non-routable
    env["DATABASE_HOST"] = "10.255.255.1"

    start = time.perf_counter()
    proc = subprocess.run(
        [sys.executable, "-c", f"import importlib; importlib.import_module({module_name!r})"],
        env=env,
        capture_output=True,
        text=True,
        timeout=_IMPORT_TIME_BUDGET_S,
    )
    elapsed = time.perf_counter() - start
    assert proc.returncode == 0, f"import of {module_name} failed:\n{proc.stderr}"
    assert elapsed < _IMPORT_TIME_BUDGET_S, f"{module_name} import took {elapsed:.1f}s"


# --------------------------------------------------------------------------- #
# Numbered CLI shims delegate to the right stage module
# --------------------------------------------------------------------------- #


_SHIM_TO_MODULE = {
    "501_calculate_comment_extremity.py": "comment_extremity",
    "502_calculate_priorities.py": "comment_priorities",
    "700_datamapplot_for_layer.py": "datamapplot_layer",
}


@pytest.mark.parametrize("shim_name, module", sorted(_SHIM_TO_MODULE.items()))
def test_numbered_shim_delegates_to_module(shim_name, module):
    shim_path = os.path.join(_UMAP_NARRATIVE_DIR, shim_name)
    with open(shim_path, encoding="utf-8") as f:
        source = f.read()
    assert f"from stages.{module} import main" in source, (
        f"{shim_name} should delegate to stages.{module}"
    )
    assert "sys.exit(main())" in source, f"{shim_name} should exit with main()'s code"


# --------------------------------------------------------------------------- #
# Registry wiring
# --------------------------------------------------------------------------- #


def test_registry_maps_stages_to_expected_scripts():
    expected = {
        "math": "polismath/run_math_pipeline.py",
        "reset": "umap_narrative/reset_conversation.py",
        "umap-pipeline": "umap_narrative/run_pipeline.py",
        "extremity": "umap_narrative/501_calculate_comment_extremity.py",
        "priorities": "umap_narrative/502_calculate_priorities.py",
        "datamapplot": "umap_narrative/700_datamapplot_for_layer.py",
    }
    assert {name: st.script for name, st in STAGES.items()} == expected


def test_math_stage_is_subprocess_only():
    # Owned by delphi/polismath/ (a different workstream): no in-process entry.
    assert STAGES["math"].target is None


def test_umap_narrative_stages_have_in_process_targets():
    for name in ("reset", "umap-pipeline", "extremity", "priorities", "datamapplot"):
        assert STAGES[name].target is not None, f"{name} should be callable in-process"


def test_stage_script_path_resolves_under_delphi_root():
    # Relative scripts resolve against the delphi/ root and exist on disk.
    for name in ("reset", "extremity", "priorities", "datamapplot"):
        assert os.path.isfile(STAGES[name].script_path), name
