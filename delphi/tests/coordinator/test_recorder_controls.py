"""Controls on the S1 recorder's cargo transcript reader.

The recorder derives its Rust counts from the run instead of asserting a literal
total. Deriving is not trusting: a transcript carries one `test result:` line per
suite, so a passing suite followed by a failing one still leaves passing lines
behind, and a total assembled from those lines alone would certify a failed run.
These controls pin the refusals. They touch no database, no cargo and no engine —
only public-fixture transcripts and status files in a tmp directory.
"""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
RECORDER = ROOT / "coordinator-rs/tools/record_s1.py"

_spec = importlib.util.spec_from_file_location("record_s1", RECORDER)
record_s1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(record_s1)

NAMED = "uncertain_commit_requires_own_epoch_even_at_identical_tick_and_checkpoint ... ok\n"
PASS_ONE = "test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"
PASS_TWO = "test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"
FAILED = "test result: FAILED. 18 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\nerror: test failed\n"
IGNORED = "test result: ok. 18 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\n"


def write(artifacts, transcript, status="0"):
    for profile in record_s1.CARGO_PROFILES:
        (artifacts / f"s1-cargo-{profile}.log").write_text(transcript)
        (artifacts / f"s1-cargo-{profile}.status").write_text(status + "\n")
    return artifacts


def test_multi_suite_success_is_counted_across_every_suite(tmp_path):
    """Positive control: several clean suites sum, with no fixed total anywhere."""
    write(tmp_path, NAMED + PASS_ONE + PASS_TWO)
    assert record_s1.rust_test_counts(tmp_path) == {"default": 31, "fault": 31}


def test_passing_suite_followed_by_failed_suite_is_refused(tmp_path):
    """The reviewed defect: the passing lines must not be reported on their own."""
    write(tmp_path, NAMED + PASS_ONE + FAILED)
    with pytest.raises(AssertionError, match="failed cargo suite"):
        record_s1.rust_test_counts(tmp_path)


def test_ignored_tests_are_not_counted_as_passes(tmp_path):
    write(tmp_path, NAMED + PASS_ONE + IGNORED)
    with pytest.raises(AssertionError, match="ignored cargo tests"):
        record_s1.rust_test_counts(tmp_path)


def test_nonzero_cargo_exit_status_is_refused(tmp_path):
    """A transcript that parses clean cannot rescue a process that exited non-zero."""
    write(tmp_path, NAMED + PASS_ONE, status="101")
    with pytest.raises(AssertionError, match="exited 101"):
        record_s1.rust_test_counts(tmp_path)


def test_missing_cargo_exit_status_is_refused(tmp_path):
    write(tmp_path, NAMED + PASS_ONE)
    (tmp_path / "s1-cargo-fault.status").unlink()
    with pytest.raises(AssertionError, match="no captured exit status"):
        record_s1.rust_test_counts(tmp_path)


def test_malformed_result_line_is_refused(tmp_path):
    write(tmp_path, NAMED + PASS_ONE + "test result: ok. 3 passed\n")
    with pytest.raises(AssertionError, match="malformed cargo test result"):
        record_s1.rust_test_counts(tmp_path)


def test_empty_transcript_is_refused(tmp_path):
    write(tmp_path, NAMED)
    with pytest.raises(AssertionError, match="no cargo test result line"):
        record_s1.rust_test_counts(tmp_path)


def test_profiles_must_agree_and_be_nonempty(tmp_path):
    write(tmp_path, NAMED + PASS_ONE)
    (tmp_path / "s1-cargo-fault.log").write_text(NAMED + PASS_TWO)
    with pytest.raises(AssertionError):
        record_s1.rust_test_counts(tmp_path)
