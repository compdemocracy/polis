"""
Unit tests for job-size routing in the Delphi job poller.

The dedicated "large" worker ASG is at zero, so the normal/default class must
process ALL job sizes; "large" stays an opt-in large-only class.
"""

from scripts.job_poller import should_process_job


def test_default_processes_all_sizes():
    assert should_process_job("default", "normal") is True
    assert should_process_job("default", "large") is True


def test_small_processes_all_sizes():
    assert should_process_job("small", "normal") is True
    assert should_process_job("small", "large") is True


def test_dev_processes_all_sizes():
    assert should_process_job("dev", "normal") is True
    assert should_process_job("dev", "large") is True


def test_large_is_large_only():
    assert should_process_job("large", "large") is True
    assert should_process_job("large", "normal") is False
