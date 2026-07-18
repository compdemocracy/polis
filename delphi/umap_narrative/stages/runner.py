"""In-process (default) vs subprocess (escape hatch) execution of Delphi stages.

The orchestrator (``run_delphi.py``) drives the UMAP / narrative pipeline as an
ordered sequence of stages. Historically each stage was spawned as its own
Python subprocess, paying full interpreter startup plus heavy imports
(sentence-transformers, torch, umap, evoc, datamapplot) *every time*. This
module lets the orchestrator call each stage in-process instead, so those
imports are paid once and stay resident for later stages.

Stages stay independently runnable as standalone scripts; this module only
changes how the *orchestrator* invokes them. Set
``DELPHI_STAGE_ISOLATION=subprocess`` to restore the old per-stage subprocess
behaviour (e.g. to debug or profile a single stage in isolation).

The public surface is intentionally tiny -- one ``Stage`` value type, one
``run_stage()`` function, and a ``STAGES`` registry -- not a framework.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

logger = logging.getLogger("delphi.stage_runner")

# umap_narrative/stages/runner.py -> umap_narrative/stages -> umap_narrative -> delphi
_STAGES_DIR = os.path.dirname(os.path.abspath(__file__))
_UMAP_NARRATIVE_DIR = os.path.dirname(_STAGES_DIR)
_DELPHI_ROOT = os.path.dirname(_UMAP_NARRATIVE_DIR)

# Put umap_narrative/ on sys.path so that top-level imports (``stages.*``,
# ``run_pipeline``, ``reset_conversation``, ``polismath_commentgraph``) resolve
# exactly as they do when a numbered script is run directly (CPython puts the
# script's own directory on sys.path[0]).
if _UMAP_NARRATIVE_DIR not in sys.path:
    sys.path.insert(0, _UMAP_NARRATIVE_DIR)

ISOLATION_IN_PROCESS = "in-process"
ISOLATION_SUBPROCESS = "subprocess"
_ENV_FLAG = "DELPHI_STAGE_ISOLATION"


def default_isolation() -> str:
    """Resolve the default isolation mode from the ``DELPHI_STAGE_ISOLATION`` flag.

    Returns ``ISOLATION_SUBPROCESS`` when the flag is exactly ``subprocess``
    (case-insensitive, surrounding whitespace ignored); otherwise the in-process
    default.
    """
    if os.environ.get(_ENV_FLAG, "").strip().lower() == ISOLATION_SUBPROCESS:
        return ISOLATION_SUBPROCESS
    return ISOLATION_IN_PROCESS


@dataclass(frozen=True)
class Stage:
    """A pipeline stage runnable in-process or as a subprocess.

    Attributes:
        name: Short label used as a per-stage log prefix so operators can tell
            interleaved in-process stage logs apart.
        script: Path to the standalone script. Relative paths are resolved
            against the ``delphi/`` root; absolute paths are used as-is. Used
            for subprocess execution.
        target: In-process entry point taking an argv list and returning an int
            exit code (``None`` is treated as ``0``). When ``None`` the stage is
            subprocess-only (e.g. owned by another service) and always runs as a
            subprocess regardless of the requested isolation.
    """

    name: str
    script: str
    target: Optional[Callable[[Sequence[str]], Optional[int]]] = None

    @property
    def script_path(self) -> str:
        if os.path.isabs(self.script):
            return self.script
        return os.path.join(_DELPHI_ROOT, self.script)


def _run_subprocess(stage: Stage, argv: Sequence[str], python: Optional[str]) -> int:
    exe = python or sys.executable
    cmd = [exe, stage.script_path, *argv]
    logger.info("[%s] running as subprocess: %s", stage.name, " ".join(cmd))
    completed = subprocess.run(cmd)
    logger.info("[%s] subprocess exited with code %s", stage.name, completed.returncode)
    return completed.returncode


def _run_in_process(stage: Stage, argv: Sequence[str]) -> int:
    logger.info("[%s] running in-process", stage.name)
    try:
        result = stage.target(list(argv))  # type: ignore[misc]
    except SystemExit as exc:
        # argparse errors (exit 2) and any stage that calls sys.exit(...).
        code = exc.code
        if code is None:
            code = 0
        elif not isinstance(code, int):
            # sys.exit("message"): CPython prints the message and exits 1.
            logger.error("[%s] %s", stage.name, code)
            code = 1
        logger.info("[%s] exited in-process with code %s", stage.name, code)
        return code
    except Exception:
        # Mirror a crashing subprocess: log the traceback and return nonzero so
        # the orchestrator's existing per-stage abort/warn logic still applies.
        logger.exception("[%s] failed in-process", stage.name)
        return 1
    code = 0 if result is None else int(result)
    logger.info("[%s] completed in-process with code %s", stage.name, code)
    return code


def run_stage(
    stage: Stage,
    argv: Optional[Sequence[str]] = None,
    isolation: Optional[str] = None,
    *,
    python: Optional[str] = None,
) -> int:
    """Run a pipeline stage and return its exit code.

    Args:
        stage: The :class:`Stage` to run.
        argv: CLI-style arguments for the stage (no program name).
        isolation: ``ISOLATION_IN_PROCESS`` or ``ISOLATION_SUBPROCESS``.
            Defaults to :func:`default_isolation` (env-driven). A stage with
            ``target=None`` is always run as a subprocess.
        python: Interpreter for subprocess execution (defaults to
            ``sys.executable``, the current interpreter).

    Returns:
        The stage's exit code (``0`` == success), matching subprocess
        return-code semantics so callers keep their existing per-stage
        abort/warn control flow.
    """
    argv = list(argv or [])
    mode = isolation or default_isolation()
    if stage.target is None and mode == ISOLATION_IN_PROCESS:
        logger.info("[%s] no in-process entry point; pinned to subprocess", stage.name)
        mode = ISOLATION_SUBPROCESS
    if mode == ISOLATION_SUBPROCESS:
        return _run_subprocess(stage, argv, python)
    return _run_in_process(stage, argv)


# --- In-process entry points (lazy imports keep heavy deps out of startup) ---


def _reset_target(argv: Sequence[str]) -> int:
    import reset_conversation

    return reset_conversation.cli(list(argv))


def _umap_pipeline_target(argv: Sequence[str]) -> Optional[int]:
    # Heavy: pulls sentence-transformers / torch / umap / evoc at import time.
    import run_pipeline

    return run_pipeline.main(list(argv))


def _extremity_target(argv: Sequence[str]) -> Optional[int]:
    from stages.comment_extremity import main

    return main(list(argv))


def _priorities_target(argv: Sequence[str]) -> Optional[int]:
    from stages.comment_priorities import main

    return main(list(argv))


def _datamapplot_target(argv: Sequence[str]) -> Optional[int]:
    # Heavy: pulls datamapplot / matplotlib at import time.
    from stages.datamapplot_layer import main

    return main(list(argv))


# Registry of the stages the orchestrator drives, keyed by logical name. The
# ``script`` paths point at the standalone CLI entry points (used for the
# subprocess escape hatch and to locate each stage on disk).
STAGES: dict[str, Stage] = {
    # The Clojure-parity math pipeline lives under delphi/polismath/, owned by a
    # different workstream. It is left subprocess-only (target=None) here.
    "math": Stage(
        "math",
        "polismath/run_math_pipeline.py",
        None,
    ),
    "reset": Stage(
        "reset",
        "umap_narrative/reset_conversation.py",
        _reset_target,
    ),
    "umap-pipeline": Stage(
        "umap-pipeline",
        "umap_narrative/run_pipeline.py",
        _umap_pipeline_target,
    ),
    "extremity": Stage(
        "extremity",
        "umap_narrative/501_calculate_comment_extremity.py",
        _extremity_target,
    ),
    "priorities": Stage(
        "priorities",
        "umap_narrative/502_calculate_priorities.py",
        _priorities_target,
    ),
    "datamapplot": Stage(
        "datamapplot",
        "umap_narrative/700_datamapplot_for_layer.py",
        _datamapplot_target,
    ),
}
