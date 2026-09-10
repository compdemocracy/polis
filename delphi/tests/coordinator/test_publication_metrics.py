"""S3 outcome accounting at a real severed COMMIT, including failed readback.

The local observer checks the published EMF alarm rule. This is not proof of
cloud ingestion, a deployed alarm or an independent production observer.
"""
import json

import pytest

from coordinator.conftest import connect, rows, seed
from coordinator.test_incremental import catalog, emf
from coordinator.test_s1_identity import CommitProxy
from coordinator.test_store import fixture_file


def observe(records):
    """Independent consumer: never infer resolution from an attempt/loop total."""
    rule = catalog()["publication_readback_alarm"]
    assert rule == dict(metric="PublishUnresolvedLost", statistic="Sum", threshold=1,
                        comparison="GreaterThanOrEqualToThreshold", period_seconds=60,
                        evaluation_periods=1, datapoints_to_alarm=1,
                        treat_missing_data="notBreaching", deployed=False, note=rule["note"])
    scoped = [r for r in records if r["Environment"] == "synthetic" and r["MathEnv"] == "rustproto"]
    attempts = sum(r.get("PublishUncertain", 0) for r in scoped)
    own = sum(r.get("PublishResolvedOwn", 0) for r in scoped)
    lost = sum(r.get(rule["metric"], 0) for r in scoped)
    if lost >= rule["threshold"]:
        return "ALARM"
    if not attempts or attempts != own + lost:
        return "UNKNOWN"
    return "RESOLVED_OWN"


def assert_outcome(path, committed, *, own, reason=None):
    records = emf(path)
    attempts = [r for r in records if r["operation"] == "publication_ambiguous"]
    outcomes = [r for r in records if r["operation"] == "publication_readback"]
    assert len(attempts) == len(outcomes) == 1
    assert records.index(attempts[0]) < records.index(outcomes[0])
    for r in attempts + outcomes:
        assert r["context"]["operation_id"] == committed["math_ticks"]["operation_id"]
        assert r["context"]["epoch"] == committed["math_ticks"]["publisher_epoch"]
        assert r["context"]["math_tick"] == committed["math_ticks"]["math_tick"]
        assert r["context"]["zid"] == 1
        assert r["_aws"]["CloudWatchMetrics"][0]["Dimensions"] == [["Environment", "MathEnv"]]
    outcome = outcomes[0]
    assert outcome["context"]["outcome"] == ("resolved-own" if own else "unresolved-lost")
    assert outcome["context"]["readback"] == (reason or ("own" if own else "identity-not-observed"))
    # Count over ALL records: catches duplicate event + pass emission, not only
    # the selected record's value. Confirmed commits are a separate total.
    assert sum(r.get("PublishUncertain", 0) for r in records) == 1
    assert sum(r.get("PublishResolvedOwn", 0) for r in records) == int(own)
    assert sum(r.get("PublishUnresolvedLost", 0) for r in records) == int(not own)
    assert observe(records) == ("RESOLVED_OWN" if own else "ALARM")
    assert observe(attempts) == "UNKNOWN", "an attempt is not a resolution"
    assert observe([]) == "UNKNOWN", "missing telemetry is not success"
    assert observe([dict(r, MathEnv="different") for r in records]) == "UNKNOWN"
    if not own:
        # Later healthy activity must not erase the lost operation's alarm.
        later = dict(outcome, PublishResolvedOwn=1, PublishUnresolvedLost=0)
        assert observe(records + [dict(attempts[0]), later]) == "ALARM"


@pytest.mark.parametrize("fault", ["absent", "inconsistent", "reconnect", "read"])
@pytest.mark.parametrize("mode", ["once", "publish-fixture"])
def test_failed_readback_is_unresolved_and_alarmable(db, launch, tmp_path, fault, mode):
    seed(db)
    args = ()
    if mode == "publish-fixture":
        launch(db).done()
        prior = rows(db)
        payloads = {key: prior["math_" + key]["data"] for key in ("main", "bidtopid", "ptptstats")}
        args = (fixture_file(tmp_path, payloads, expected=0),)
    metrics = tmp_path / "outcomes.jsonl"
    proxy = CommitProxy(db)
    renamed = False
    try:
        child = launch(proxy.url, mode, args=args, extra={"P026_METRICS": str(metrics)})
        assert proxy.committed.wait(30), "publication COMMIT not intercepted"
        committed = rows(db)
        if fault == "reconnect":
            proxy.reject_connections = True
        else:
            c = connect(db)
            try:
                with c.cursor() as cur:
                    if fault == "absent":
                        cur.execute("DELETE FROM polis_coordinator_payloads WHERE math_env='rustproto'")
                        cur.execute("DELETE FROM polis_coordinator_generations WHERE math_env='rustproto'")
                    elif fault == "inconsistent":
                        cur.execute("UPDATE polis_coordinator_payloads SET storage_sha256=repeat('0',64) WHERE math_env='rustproto' AND payload_kind='bidtopid'")
                    else:
                        cur.execute("ALTER TABLE polis_coordinator_generations RENAME TO s3_hidden_generations")
                        renamed = True
            finally:
                c.close()
        proxy.release.set()
        out, err = child.done(code=1)
        assert "DONE" not in out and "Committed(" not in out
        if fault in ("absent", "inconsistent"):
            assert "UNCERTAIN_COMMIT_LOST" in err
        assert_outcome(metrics, committed, own=False,
                       reason="readback-failed" if fault in ("reconnect", "read") else None)
        assert not proxy.errors
    finally:
        proxy.close()
        if renamed:
            c = connect(db)
            with c.cursor() as cur:
                cur.execute("ALTER TABLE s3_hidden_generations RENAME TO polis_coordinator_generations")
            c.close()


def test_confirmed_commit_emits_no_ambiguous_outcome(db, launch, tmp_path):
    seed(db)
    metrics = tmp_path / "confirmed.jsonl"
    launch(db, extra={"P026_METRICS": str(metrics)}).done()
    records = emf(metrics)
    assert sum(r.get("PublishCommitted", 0) for r in records) == 1
    assert all(not r.get(key) for r in records for key in
               ("PublishUncertain", "PublishResolvedOwn", "PublishUnresolvedLost"))
