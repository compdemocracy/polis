"""Boolean job flags parse the text, not its truthiness.

The scripts declared ``--include_moderation`` and ``--exclude_comment_selections``
with ``type=bool``; ``bool("False")`` is True, so the poller's
``--include_moderation=False`` always arrived as True. Each script's real
``main`` is driven here with its work function replaced by a recorder.
"""

import argparse
import asyncio
import importlib
import json
import os
import sys
from pathlib import Path

import pytest

from polismath.utils.cli_flags import parse_bool_flag
from scripts.job_poller import report_filter_flags
from tests.test_run_delphi_exit_codes import app_dir  # noqa: F401  (fixture)

DELPHI_ROOT = Path(__file__).resolve().parents[1]
UMAP_DIR = str(DELPHI_ROOT / "umap_narrative")
if UMAP_DIR not in sys.path:
    sys.path.insert(0, UMAP_DIR)


@pytest.mark.parametrize("text, expected", [
    ("False", False), ("false", False), ("0", False), ("no", False),
    ("True", True), ("true", True), ("1", True), ("yes", True),
    (False, False), (True, True),
])
def test_parse_bool_flag(text, expected):
    assert parse_bool_flag(text) is expected


@pytest.mark.parametrize("text", ["", "maybe", "None", None, 2])
def test_parse_bool_flag_refuses_non_booleans(text):
    with pytest.raises(argparse.ArgumentTypeError):
        parse_bool_flag(text)


FLAG_CASES = [
    (["--include_moderation=False", "--exclude_comment_selections=False"], False, False),
    (["--include_moderation=True", "--exclude_comment_selections=True"], True, True),
    (["--include_moderation=False", "--exclude_comment_selections=True"], False, True),
]


@pytest.mark.parametrize("flags, include_moderation, exclude_selections", FLAG_CASES)
def test_run_pipeline_main(monkeypatch, flags, include_moderation, exclude_selections):
    import run_pipeline

    seen = {}
    monkeypatch.setattr(run_pipeline, "setup_environment", lambda **kw: None)
    monkeypatch.setattr(run_pipeline, "process_conversation",
                        lambda zid, **kw: seen.update(kw) or True)
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=1", *flags])
    run_pipeline.main()
    assert seen["include_moderation"] is include_moderation
    assert seen["exclude_comment_selections"] is exclude_selections


@pytest.mark.parametrize("flags, include_moderation, exclude_selections", FLAG_CASES)
def test_extremity_main(monkeypatch, flags, include_moderation, exclude_selections):
    module = importlib.import_module("501_calculate_comment_extremity")
    seen = {}

    def record(zid, force, include, exclude):
        seen.update(include=include, exclude=exclude)
        return {}

    monkeypatch.setattr(module, "calculate_and_store_extremity", record)
    monkeypatch.setattr(sys, "argv", ["501.py", "--zid=1", *flags])
    module.main()
    assert seen["include"] is include_moderation
    assert seen["exclude"] is exclude_selections


@pytest.mark.parametrize("flags, include_moderation, exclude_selections", FLAG_CASES)
def test_narrative_batch_main(monkeypatch, flags, include_moderation, exclude_selections):
    module = importlib.import_module("801_narrative_report_batch")
    seen = {}

    class Recorder:
        def __init__(self, **kwargs):
            seen.update(kwargs)

        async def submit_batch(self):
            return True

    monkeypatch.setattr(module, "BatchReportGenerator", Recorder)
    for name in ("DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME", "DATABASE_USER", "DATABASE_PASSWORD"):
        monkeypatch.setenv(name, "generated-fixture")
    monkeypatch.setattr(sys, "argv", ["801.py", "--conversation_id=1", *flags])
    asyncio.run(module.main())
    assert seen["include_moderation"] is include_moderation
    assert seen["exclude_comment_selections"] is exclude_selections


@pytest.mark.parametrize("flags, include_moderation, exclude_selections", FLAG_CASES)
def test_run_delphi_forwards_parsed_flags(app_dir, monkeypatch, flags, include_moderation, exclude_selections):
    """run_delphi.py re-emits the parsed value to the UMAP and extremity stages."""
    import subprocess

    argv_log = Path(os.environ["STAGE_LOG"]).with_name("argv.log")
    monkeypatch.setenv("ARGV_LOG", str(argv_log))
    for rel in ("umap_narrative/run_pipeline.py", "umap_narrative/501_calculate_comment_extremity.py"):
        stub = app_dir / rel
        stub.write_text(
            "import json, os, sys\n"
            "open(os.environ['ARGV_LOG'], 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
        )
    result = subprocess.run(
        [sys.executable, str(app_dir / "run_delphi.py"), "--zid=1", *flags],
        cwd=app_dir, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    calls = [json.loads(line) for line in argv_log.read_text().splitlines()]
    assert len(calls) == 2
    for argv in calls:
        assert f"--include_moderation={include_moderation}" in argv
        assert f"--exclude_comment_selections={exclude_selections}" in argv


# --- the poller reads the flags where each producer puts them ---------------


def test_full_pipeline_job_config_top_level():
    # POST /delphi/jobs: {"include_moderation": false}
    assert report_filter_flags({"include_moderation": False}) == (False, True)
    assert report_filter_flags({"include_moderation": True}) == (True, True)


def test_narrative_job_config_nested_under_first_stage():
    # POST /delphi/batchReports nests the flag under stages[0].config.
    nested = {"job_type": "CREATE_NARRATIVE_BATCH",
              "stages": [{"stage": "X", "config": {"include_moderation": False}}]}
    assert report_filter_flags(nested) == (False, True)
    nested["stages"][0]["config"]["include_moderation"] = True
    assert report_filter_flags(nested) == (True, True)


def test_absent_flags_keep_the_values_jobs_have_run_with():
    assert report_filter_flags({}) == (True, True)
    assert report_filter_flags({"stages": [{"config": {}}]}) == (True, True)
