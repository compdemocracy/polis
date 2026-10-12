"""Shards and result records for ci/local/delphi-python.sh.

Registered from conftest.pytest_configure. It does nothing unless the entry
point sets one of these environment variables:

  DELPHI_TEST_SHARD="I/N"      keep only shard I of N (1-based). Tests are
                               split by unit: an xdist_group name when the
                               test has one (so a dataset is computed in one
                               shard only), otherwise its module file. Units
                               are spread over shards by expected wall seconds
                               (ci/local/delphi-test-durations.json, a
                               per-test default for units it does not list),
                               longest first, so the shards finish together.
                               The plan depends only on the collection and that
                               file, never on the machine, so every shard
                               computes the same plan.
  DELPHI_TEST_MANIFEST=<path>  write the collected and selected node ids
                               (before -m), so the combine step can prove every
                               test ran in exactly one shard.
  DELPHI_TEST_RESULTS=<path>   append one JSON line per test report
                               (controller side under xdist) and write
                               pytest's summary counts to <path>.counts.json.

Selection never drops a test from the whole run: each unit is in exactly one
shard, and the combine step fails if the shard manifests do not add up to the
collected set.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# Seconds assumed for a test in a unit the durations file does not list.
DEFAULT_TEST_SECONDS = 0.5
# Workers assumed when turning parallel-pass seconds into wall seconds (a
# hosted runner's CPUs). A constant, so the plan is the same on every machine.
PLAN_WORKERS = 4


def base_nodeid(nodeid: str) -> str:
    """Strip the '@group' suffix xdist's loadgroup scheduler appends."""
    if "@" in nodeid.rsplit("::", 1)[-1]:
        return nodeid.rsplit("@", 1)[0]
    return nodeid


def dataset_of(item) -> str:
    """The dataset a test is parametrized with ('' if none); the same rule as
    conftest's reordering (composite '<dataset>-<blob>' ids map to the dataset)."""
    params = getattr(getattr(item, "callspec", None), "params", None) or {}
    for name in ("dataset_name", "dataset_blob_id"):
        value = params.get(name)
        if isinstance(value, str):
            for suffix in ("-incremental", "-cold_start"):
                if value.endswith(suffix):
                    return value[: -len(suffix)]
            return value
    return ""


def unit_of(item) -> str:
    mark = item.get_closest_marker("xdist_group")
    if mark is not None:
        name = mark.kwargs.get("name", mark.args[0] if mark.args else "")
        if name:
            return f"group:{name}"
    return "file:" + base_nodeid(item.nodeid).split("::", 1)[0]


def _load_durations() -> dict[str, float]:
    """Expected wall seconds per unit. The file holds [parallel, serial]
    seconds per unit: parallel-pass tests share PLAN_WORKERS workers, the
    serial pass has the shard to itself."""
    path = os.environ.get("DELPHI_TEST_DURATIONS")
    if not path or not Path(path).is_file():
        return {}
    data = json.loads(Path(path).read_text())
    out = {}
    for unit, value in data.get("units", {}).items():
        parallel, serial = value if isinstance(value, list) else (value, 0.0)
        out[str(unit)] = float(parallel) / PLAN_WORKERS + float(serial)
    return out


def assign_shards(units: dict[str, int], durations: dict[str, float], count: int) -> dict[str, int]:
    """Longest-expected unit first onto the least-loaded shard (1-based)."""
    weight = {u: durations.get(u, n * DEFAULT_TEST_SECONDS / PLAN_WORKERS) for u, n in units.items()}
    loads = [0.0] * count
    out = {}
    for unit in sorted(units, key=lambda u: (-weight[u], u)):
        shard = min(range(count), key=lambda s: (loads[s], s))
        loads[shard] += weight[unit]
        out[unit] = shard + 1
    return out


def _parse_shard(text: str) -> tuple[int, int]:
    try:
        index, count = (int(p) for p in text.split("/"))
    except ValueError:
        raise pytest.UsageError(f"DELPHI_TEST_SHARD must look like 2/3, got {text!r}")
    if not 1 <= index <= count:
        raise pytest.UsageError(f"DELPHI_TEST_SHARD out of range: {text!r}")
    return index, count


def _is_xdist_worker(config) -> bool:
    return hasattr(config, "workerinput")


class CiPartition:
    def __init__(self, config):
        self.config = config
        self.shard = os.environ.get("DELPHI_TEST_SHARD") or None
        self.manifest = os.environ.get("DELPHI_TEST_MANIFEST") or None
        self.results = os.environ.get("DELPHI_TEST_RESULTS") or None
        # Opened once, before any test runs: some tests monkeypatch open().
        self._results_fh = None
        if self.results and not _is_xdist_worker(config):
            self._results_fh = open(self.results, "a", buffering=1)

    # tryfirst: see the full collection before -m/-k deselect anything.
    @pytest.hookimpl(tryfirst=True)
    def pytest_collection_modifyitems(self, session, config, items):
        # Each dataset's tests share one session-scoped conversation cache: keep
        # them on one xdist worker (--dist loadgroup) and in one shard, so the
        # conversation is computed once rather than once per worker.
        for item in items:
            ds = dataset_of(item)
            if ds and item.get_closest_marker("xdist_group") is None:
                item.add_marker(pytest.mark.xdist_group(f"dataset-{ds}"))
        collected = [base_nodeid(i.nodeid) for i in items]
        units: dict[str, int] = {}
        for item in items:
            units[unit_of(item)] = units.get(unit_of(item), 0) + 1
        index, count = _parse_shard(self.shard) if self.shard else (1, 1)
        if count > 1:
            plan = assign_shards(units, _load_durations(), count)
            keep, drop = [], []
            for item in items:
                (keep if plan[unit_of(item)] == index else drop).append(item)
            if drop:
                config.hook.pytest_deselected(items=drop)
            items[:] = keep
        # One writer: the plain run, or the first xdist worker (every worker
        # collects the same list; xdist refuses to run otherwise).
        worker = getattr(config, "workerinput", {}).get("workerid")
        if self.manifest and worker in (None, "gw0"):
            Path(self.manifest).write_text(json.dumps({
                "shard": f"{index}/{count}",
                "collected": collected,
                "selected": [base_nodeid(i.nodeid) for i in items],
                "units": {base_nodeid(i.nodeid): unit_of(i) for i in items},
                "serial": [base_nodeid(i.nodeid) for i in items
                           if i.get_closest_marker("serial") is not None],
            }))

    def pytest_runtest_logreport(self, report):
        if self._results_fh is None:
            return
        node = getattr(report, "node", None)
        self._results_fh.write(json.dumps({
            "nodeid": base_nodeid(report.nodeid),
            "when": report.when,
            "outcome": report.outcome,
            "xfail": hasattr(report, "wasxfail"),
            "duration": report.duration,
            "worker": node.gateway.id if node is not None else None,
        }) + "\n")

    # The same numbers as pytest's final summary line, from the controller.
    def pytest_terminal_summary(self, terminalreporter):
        if not self.results or _is_xdist_worker(self.config):
            return
        counts = {key: len(reports) for key, reports in terminalreporter.stats.items()
                  if key and key != "warnings"}
        Path(self.results + ".counts.json").write_text(json.dumps(counts, sort_keys=True))


def register(config):
    if any(os.environ.get(k) for k in ("DELPHI_TEST_SHARD", "DELPHI_TEST_MANIFEST", "DELPHI_TEST_RESULTS")):
        config.pluginmanager.register(CiPartition(config), "delphi_ci_partition")
