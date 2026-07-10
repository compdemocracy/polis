"""Benchmarks must stay importable as the production API evolves.

PR 14a deleted the scalar repness functions; `bench_repness.py` still
imported `comment_stats`, so running any benchmark in that module crashed
with ImportError. Plain import tests catch this class of drift at CI time
(Copilot review 2026-07-04, g2).
"""

import importlib

import pytest


@pytest.mark.parametrize('module_name', [
    'polismath.benchmarks.bench_repness',
    'polismath.benchmarks.bench_pca',
    'polismath.benchmarks.bench_update_votes',
    'polismath.benchmarks.benchmark_utils',
])
def test_benchmark_module_imports(module_name):
    importlib.import_module(module_name)
