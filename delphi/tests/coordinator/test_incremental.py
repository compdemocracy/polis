"""CO01 incremental discovery and the metrics the contract names.

The probe is a filter, never a gate: a differing probe always forces the
authoritative snapshot, and a matching probe only skips a read while the
conversation's last full reconciliation is younger than the configured ceiling.
`test_the_aggregate_probe_is_weak_but_the_ceiling_repairs_it` is the negative
control for exactly that, staged with a change no aggregate can see.
"""
import json
import subprocess
import time
from pathlib import Path

from conftest import BINARY, assert_coherent, connect, rows, seed, wait


def query(db, sql, args=()):
    c = connect(db)
    try:
        with c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall() if cur.description else None
    finally:
        c.close()


def emf(path, operation=None):
    """Every Embedded Metric Format record the process wrote, in order."""
    path = Path(path)
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if operation is None or record.get("operation") == operation:
            out.append(record)
    return out


def catalog():
    return json.loads(subprocess.check_output([str(BINARY), "metrics"], text=True))


def test_probe_skips_the_full_source_read_and_a_real_change_still_publishes(db, launch, tmp_path):
    seed(db)
    first, second, third = (tmp_path / f"{n}.jsonl" for n in ("first", "second", "third"))

    launch(db, extra={"P026_METRICS": str(first)}).done()
    pass_one = emf(first, "source_pass")[-1]
    assert pass_one["SourcePassReconciled"] == 1
    assert pass_one["SourcePassPublished"] == 1
    assert pass_one["SourcePassSkipped"] == 0
    assert_coherent(db)
    published = rows(db)["math_main"]["math_tick"]

    # Nothing changed: the probe matches the one recorded before the snapshot
    # that certified this generation, so no source read is taken at all.
    launch(db, extra={"P026_METRICS": str(second)}).done()
    pass_two = emf(second, "source_pass")[-1]
    assert pass_two["SourcePassProbed"] == 1
    assert pass_two["SourcePassSkipped"] == 1
    assert pass_two["SourcePassReconciled"] == 0
    assert emf(second, "reconciliation") == [], "a skipped conversation must not read the source"
    assert rows(db)["math_main"]["math_tick"] == published

    # A committed vote changes the probe, so the full authoritative snapshot is
    # taken and the new generation is published.
    query(db, "INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,2000)")
    launch(db, extra={"P026_METRICS": str(third)}).done()
    pass_three = emf(third, "source_pass")[-1]
    assert pass_three["SourcePassSkipped"] == 0
    assert pass_three["SourcePassReconciled"] == 1
    assert pass_three["SourcePassPublished"] == 1
    tables = assert_coherent(db)
    assert tables["math_main"]["math_tick"] > published
    assert tables["math_ticks"]["input_checkpoint"]["event_count"] == 25


def test_the_aggregate_probe_is_weak_but_the_reconciliation_ceiling_repairs_it(db, launch, tmp_path):
    """Rev5: count/max are hints, not completeness proof. Stage a change every
    aggregate in the probe is blind to, show the fast path really does miss it,
    and show the bounded authoritative reconciliation finds it anyway."""
    seed(db)
    launch(db).done()
    before = rows(db)["math_main"]
    # Swap two votes' values: count, min/max/sum(created), sum(vote), sum(weight),
    # comment and participant aggregates are all identical afterwards.
    query(db, "UPDATE votes SET vote=1 WHERE zid=1 AND pid=0 AND tid=0")
    query(db, "UPDATE votes SET vote=-1 WHERE zid=1 AND pid=0 AND tid=1")
    hidden = tmp_path / "hidden.jsonl"
    launch(db, extra={"P026_METRICS": str(hidden), "P026_RECONCILE_SECONDS": "3600"}).done()
    skipped = emf(hidden, "source_pass")[-1]
    assert skipped["SourcePassSkipped"] == 1, "the probe genuinely cannot see this change"
    assert rows(db)["math_main"]["math_tick"] == before["math_tick"]

    # ... which is why the probe may never be the only rebuild gate.
    time.sleep(1.2)
    repaired = tmp_path / "repaired.jsonl"
    launch(db, extra={"P026_METRICS": str(repaired), "P026_RECONCILE_SECONDS": "1"}).done()
    pass_two = emf(repaired, "source_pass")[-1]
    assert pass_two["SourcePassSkipped"] == 0
    assert pass_two["SourcePassReconciled"] == 1
    assert pass_two["SourcePassPublished"] == 1
    tables = assert_coherent(db)
    assert tables["math_main"]["math_tick"] > before["math_tick"]
    assert tables["math_main"]["data"] != before["data"]


def test_disabling_the_fast_path_restores_the_unconditional_full_sweep(db, launch, tmp_path):
    """CO05: the complete pass stays available as the fallback."""
    seed(db)
    launch(db).done()
    metrics = tmp_path / "full.jsonl"
    launch(db, extra={"P026_METRICS": str(metrics), "P026_INCREMENTAL": "0"}).done()
    record = emf(metrics, "source_pass")[-1]
    assert record["SourcePassSkipped"] == 0
    assert record["SourcePassReconciled"] == 1, "the full snapshot runs regardless of the probe"
    assert record["SourcePassPublished"] == 0, "and it agrees with the published generation"
    assert record["context"]["incremental"] is False


def test_emitted_records_match_the_declared_catalog_and_p031_dimensions(db, launch, tmp_path):
    declared = catalog()
    assert declared["namespace"] == "Polis/Math"
    assert declared["dimensions"] == ["Environment", "MathEnv"]
    names = {m["name"]: m for m in declared["metrics"]}
    seed(db)
    metrics = tmp_path / "m.jsonl"
    launch(db, extra={"P026_METRICS": str(metrics)}).done()
    records = emf(metrics)
    assert records
    for record in records:
        block = record["_aws"]["CloudWatchMetrics"][0]
        assert block["Namespace"] == "Polis/Math"
        # P-031: "Math uses only fixed Environment=prod, MathEnv=prod ... No
        # conversation/job/report/run/instance dimensions."
        assert block["Dimensions"] == [["Environment", "MathEnv"]]
        assert record["Environment"] == "synthetic" and record["MathEnv"] == "rustproto"
        assert isinstance(record["_aws"]["Timestamp"], int)
        for entry in block["Metrics"]:
            assert entry["Name"] in names, entry
            assert entry["Unit"] == names[entry["Name"]]["unit"]
            assert isinstance(record[entry["Name"]], (int, float))
    pass_record = emf(metrics, "source_pass")[-1]
    assert pass_record["PollHealthy"] == 1
    assert pass_record["LeaseAcquired"] == 1
    assert pass_record["PublishCommitted"] == 1
    assert pass_record["LeaseFenced"] == 0 and pass_record["PublishRefused"] == 0
    assert pass_record["MetricsDropped"] == 0
    for gauge in ("OldestReconciliationAgeSeconds", "ReconciliationBacklogConversations",
                  "FailureBacklogConversations", "OldestUnrepairedAgeSeconds"):
        assert gauge in pass_record, gauge
    per_zid = emf(metrics, "reconciliation")[-1]
    for timing in ("SourceReadSeconds", "ComputeSeconds", "PublishSeconds"):
        assert per_zid[timing] >= 0
    assert per_zid["context"]["zid"] == 1
    assert emf(metrics, "conversation")[-1]["ConversationLatencySeconds"] > 0


def test_scan_age_and_backlog_are_exposed_and_drain(db, launch, tmp_path):
    """CO01 asks for scan age and backlog. One conversation per page, so the
    first pass leaves the second conversation measurably unreconciled."""
    seed(db, 1)
    seed(db, 2)
    metrics = tmp_path / "backlog.jsonl"
    child = launch(db, "run", extra={"P026_METRICS": str(metrics), "P026_PAGE_SIZE": "1",
                                     "P026_GAUGE_SECONDS": "0", "P026_POLL_MS": "50"})
    wait(lambda: any(r.get("ReconciliationBacklogConversations") == 1
                     for r in emf(metrics, "source_pass")),
         alive=child, why="the unvisited conversation is counted as backlog")
    wait(lambda: any(r.get("ReconciliationBacklogConversations") == 0
                     for r in emf(metrics, "source_pass")),
         alive=child, why="the backlog drains once every conversation is reconciled")
    child.kill()
    assert_coherent(db, 1)
    assert_coherent(db, 2)
    ages = [r["OldestReconciliationAgeSeconds"] for r in emf(metrics, "source_pass")
            if "OldestReconciliationAgeSeconds" in r]
    assert ages and all(age >= 0 for age in ages)


def test_failures_appear_as_backlog_and_unrepaired_age_without_faking_health(db, launch, tmp_path):
    """CO06 oldest unrepaired age. A stuck conversation must be visible as
    stuck; the pass itself still completed, and PollHealthy says only that."""
    seed(db)
    metrics = tmp_path / "failures.jsonl"
    child = launch(db, "run", extra={"P026_METRICS": str(metrics),
                                     "P026_PYTHON": str(tmp_path / "no-such-interpreter"),
                                     "P026_GAUGE_SECONDS": "0", "P026_POLL_MS": "50"})
    wait(lambda: any(r.get("FailureBacklogConversations", 0) >= 1
                     for r in emf(metrics, "source_pass")),
         alive=child, why="the failing conversation reaches the durable failure backlog")
    child.kill()
    stuck = [r for r in emf(metrics, "source_pass") if r.get("FailureBacklogConversations", 0) >= 1][-1]
    assert stuck["SourcePassDeferred"] >= 1
    assert stuck["OldestUnrepairedAgeSeconds"] >= 0
    assert stuck["PollHealthy"] == 1, "the loop is alive; stuck work is a different signal"
    assert rows(db)["math_main"] is None, "nothing was published"
