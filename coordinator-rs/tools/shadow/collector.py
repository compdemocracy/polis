"""Private daily capture entry. No writer credentials and no fixture auth.

The default absent history custody closes INCOMPLETE immediately. A reviewed
same-host custodian may provide exact legacy history; current rows and cursors
are never promoted to that authority. Bound captures read one common exported
snapshot through two instances of the original Node application.
"""
from __future__ import annotations

import argparse
from collections import Counter
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import time

import bridge_adapter
import capture
import daily
import readers
import views


def load(path):
    return bridge_adapter.strict(views.private_bytes(path))


def host_identity():
    """Linux instance and boot identity; never infer locality from caller text."""
    machine = Path("/etc/machine-id").read_text().strip()
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if not machine or not boot:
        raise ValueError("SHADOW_HOST")
    return hashlib.sha256((machine + "\n" + boot).encode()).hexdigest()


def pending(request, profile):
    daily.closed(request, ("run", "window", "start", "end", "build", "policy"))
    if (type(request["start"]) is not int or type(request["end"]) is not int
            or request["end"] - request["start"] != 86400):
        raise ValueError("SHADOW_WINDOW")
    routes = {key: dict(expected=profile["expected_routes"][key], observed=0,
                       **{verdict: 0 for verdict in daily.VERDICTS}) for key in daily.ROUTES}
    value = dict(schema="polis-shadow-receipt/1", run=request["run"], window=request["window"],
        seconds=0, build=request["build"], policy=request["policy"],
        admission=dict(host=False, runtime=False, input=False, collector=False, clojure_serving=False),
        windows=dict(expected=profile["expected_cuts"], bound=0, incomplete=profile["expected_cuts"]),
        residuals={"cut-unbound-late-row": 0}, routes=routes,
        observer=dict(expected=profile["observer_expected"], observed=0, alarms=0, unresolved=0),
        delivery="PENDING", cleanup="RETAINED", verdict="INCOMPLETE")
    return daily.validate_receipt(value)


def collect_bound(custody, profile, directory, *, connect=views.connect, launch=readers.launch):
    """Custody is private trusted collector evidence, not an exportable claim.

    Its legacy member must come from independently retained actual warm history.
    There is deliberately no adapter from current timestamps to this record.
    """
    daily.closed(custody, ("schema", "expected", "legacy", "legacy_view", "cut_file",
                          "replay_request", "replay_result", "replay_log", "runtime_profile"))
    if custody["schema"] != "polis-shadow-custody/1":
        raise ValueError("SHADOW_CUSTODY")
    expected = custody["expected"]
    if expected["host"] != host_identity():
        raise ValueError("SHADOW_HOST")
    if custody["legacy"]["bundle"] != hashlib.sha256(daily.canonical(custody["legacy_view"])).hexdigest():
        raise ValueError("SHADOW_LEGACY_VIEW_BINDING")
    views.private_bytes(custody["cut_file"])
    daily.verify_cut(custody["cut_file"], expected["cut"])
    request = load(custody["replay_request"])
    # Expected input comes from independent legacy custody, not the bridge's
    # own echo. Remaining replay request fields are separately validated by the
    # actual adapter and retained publication checks.
    if (request["zid"] != profile["zid"] or request["host"] != expected["host"] or request["cut_sha256"] != expected["cut"]
            or request["history_sha256"] != expected["history"]
            or request["namespace"] != expected["python_namespace"]
            or request["legacy_namespace"] != expected["clojure_namespace"]):
        raise ValueError("SHADOW_CUSTODY")
    bridge_adapter.admit_request(request, {key: request[key] for key in bridge_adapter.FIELDS - {"schema", "cut_bytes"}})
    result = bridge_adapter.admit_result(views.private_bytes(custody["replay_result"], bridge_adapter.LIMIT),
        views.private_bytes(custody["replay_log"], bridge_adapter.LOG_LIMIT), request, custody["runtime_profile"])
    right = {key: expected[key] for key in ("host", "cut", "history", "node_build", "node_dependencies", "node_settings")}
    right.update(lifecycle=result["lifecycle"], namespace=result["namespace"], engine="python",
        computing_pid=result["computing_pid"], parent_pid=result["parent_pid"], runtime=result["runtime"],
        bundle=result["bundle_sha256"], read_only=True)
    daily.admit_pair(custody["legacy"], right, expected)
    common = profile["readers"]["common"]
    for key in ("node_build", "node_dependencies", "node_settings"):
        if common[key] != expected[key]:
            raise ValueError("SHADOW_READER_BINDING")
    for engine in ("clojure", "python"):
        if profile["readers"][engine + "_namespace"] != expected[engine + "_namespace"]:
            raise ValueError("SHADOW_NAMESPACE")
    inventory = [entry["route"] for entry in profile["requests"]]
    if sorted(common["requests"]) != sorted(entry["request_sha256"] for entry in inventory):
        raise ValueError("SHADOW_ROUTE")
    outcomes = []
    with views.Keeper(connect(profile["database"])) as keeper:
        keeper.admit(expected["clojure_namespace"], request["zid"], custody["legacy_view"])
        keeper.admit_python(result)
        with launch(profile["readers"], keeper.snapshot, profile["database"], directory) as (endpoints, _):
            full = {}
            for entry in profile["requests"]:
                daily.closed(entry, ("route", "headers", "full_request"))
                route = entry["route"]
                keeper.alive()
                pair = capture.pair(endpoints, route, inventory, entry["headers"])
                full_pair = None
                reference = entry["full_request"]
                if reference is not None:
                    prior = full.get(reference)
                    # Bind conditional observations to an earlier full request
                    # with the identical URL and nonconditional auth headers.
                    base_headers = {k: v for k, v in entry["headers"].items()
                                    if k not in ("if-none-match", "if-modified-since")}
                    if prior is None or prior[0] != (route["path"], base_headers):
                        raise ValueError("SHADOW_CONDITIONAL_BINDING")
                    full_pair = prior[1]
                    for response, original in zip(pair, full_pair):
                        response["full_body"] = hashlib.sha256(daily.body(original)).hexdigest()
                outcome = daily.compare(*pair, route, full_pair)
                # Equal denials/errors are observations, not successful math
                # route coverage. Do not certify an app that only returns 404.
                if any(row["status"] not in (200, 304) for row in pair):
                    outcome = "INCOMPLETE"
                if outcome in ("EXACT", "UNORDERED_QUERY_RESIDUAL"):
                    for row in (full_pair or pair):
                        if not isinstance(row["content_type"], str) or row["content_type"].split(";", 1)[0].strip().lower() != "application/json":
                            outcome = "INCOMPLETE"
                            break
                        # Validate syntax only. The parsed value is discarded;
                        # the comparison remains the untouched original bytes.
                        try:
                            bridge_adapter.strict(daily.body(row))
                        except (ValueError, UnicodeError):
                            outcome = "INCOMPLETE"
                            break
                outcomes.append((route["class"], outcome))
                if all(row["status"] == 200 for row in pair):
                    full[route["request_sha256"]] = ((route["path"], entry["headers"]), pair)
                if outcome in ("ENGINE_DIFFERENCE", "INCOMPLETE"):
                    break
            keeper.alive()
    return outcomes


def observer_counts(path, request, expected, environment, namespace, now):
    """Count actual D06 EMF samples, one per minute; no silence-as-success."""
    rows = {}
    for line in views.private_bytes(path).splitlines():
        row = bridge_adapter.strict(line)
        if (row.get("schema") != "polis-observer/1" or row.get("Environment") != environment
                or row.get("MathEnv") != namespace):
            raise ValueError("SHADOW_OBSERVER_SCOPE")
        for key in ("ObserverHealthy", "PollHealthy"):
            if type(row.get(key)) is not int or row[key] not in (0, 1):
                # Failed observer samples may omit PollHealthy; they are
                # still missing evidence, never a fabricated healthy value.
                if key == "PollHealthy" and row.get("ObserverHealthy") == 0:
                    continue
                raise ValueError("SHADOW_OBSERVER_SAMPLE")
        for key in ("PublishLagSeconds", "UnresolvedOperations", "MetricsDropped"):
            value = row.get(key)
            if row.get("ObserverHealthy") == 1 and (type(value) not in (int, float)
                    or not math.isfinite(value) or value < 0):
                raise ValueError("SHADOW_OBSERVER_SAMPLE")
        if row.get("MetricsDropped", 0):
            raise ValueError("SHADOW_OBSERVER_DROPPED")
        stamp = row.get("_aws", {}).get("Timestamp")
        if type(stamp) is not int or stamp > now * 1000:
            raise ValueError("SHADOW_OBSERVER_CLOCK")
        minute = (stamp // 1000 - request["start"]) // 60
        if not -4 <= minute < expected:
            continue
        if minute in rows:
            raise ValueError("SHADOW_OBSERVER_DUPLICATE")
        rows[minute] = row
    observed = alarms = unresolved = 0
    for minute in range(min(expected, max(0, int((now-request["start"])//60)))):
        row = rows.get(minute)
        if row is not None:
            observed += int(row.get("ObserverHealthy") == 1 and row.get("PollHealthy") == 1
                            and row.get("CurrentPointerHealthy") == 1 and row.get("code") == "OK")
            count = row.get("UnresolvedOperations", 0)
            daily.number(count)
            unresolved += count
        for key in ("PollHealthy", "ObserverHealthy", "PublishLagSeconds"):
            values = [rows.get(n, {}).get(key) for n in range(minute-4, minute+1)]
            breached = sum((value is None and key != "PublishLagSeconds") or
                          (value is not None and (value > 600 if key == "PublishLagSeconds" else value < 1))
                          for value in values)
            alarms += int(breached >= 3)
    return dict(expected=expected, observed=observed, alarms=alarms, unresolved=unresolved)


def run_window(request, profile, *, wall=time.time, monotonic=time.monotonic, sleep=time.sleep,
               collect=collect_bound, previous_receipt=None):
    daily.closed(profile, ("schema", "expected_cuts", "expected_routes", "observer_expected",
        "cuts", "readers", "database", "private_directory", "observer_file", "environment"))
    if profile["schema"] != "polis-shadow-collector/1" or profile["observer_expected"] != 1440:
        raise ValueError("SHADOW_PROFILE")
    value = pending(request, profile)
    if len(profile["cuts"]) != profile["expected_cuts"]:
        raise ValueError("SHADOW_SCOPE")
    actual = Counter()
    for cut in profile["cuts"]:
        daily.closed(cut, ("offset", "custody_file", "zid", "requests"))
        daily.number(cut["offset"], 86399)
        if type(cut["zid"]) is not int or not 0 < cut["zid"] < 2**31:
            raise ValueError("SHADOW_SCOPE")
        inventory = [entry["route"] for entry in cut["requests"]]
        for entry in cut["requests"]:
            daily.closed(entry, ("route", "headers", "full_request"))
            capture.admit_request(entry["route"], inventory, entry["headers"])
            actual[entry["route"]["class"]] += 1
    if dict(actual) != profile["expected_routes"] or any(actual[key] <= 0 for key in daily.ROUTES):
        raise ValueError("SHADOW_SCOPE")
    # Be alive before the window, including ordinary subprocess startup. The
    # monotonic boundary is anchored before waiting, so sleep wakeup jitter
    # does not erase time during which this collector was already monitoring.
    entered_mono = monotonic()
    entered_wall = wall()
    if not request["start"] - 60 <= entered_wall <= request["start"]:
        return value
    began = entered_mono + request["start"] - entered_wall
    while wall() < request["start"]:
        if abs((wall()-entered_wall) - (monotonic()-entered_mono)) > 2:
            return value
        sleep(min(1, request["start"]-wall()))
    schedule = profile["cuts"]
    if [c["offset"] for c in schedule] != sorted(c["offset"] for c in schedule):
        raise ValueError("SHADOW_SCOPE")
    cursor = 0
    seen = set()
    next_observer = 60
    try:
        while wall() < request["end"]:
            elapsed = monotonic() - began
            if abs((wall()-request["start"]) - elapsed) > 2:
                raise ValueError("SHADOW_CLOCK")
            while cursor < len(schedule) and elapsed >= schedule[cursor]["offset"]:
                cut = schedule[cursor]
                if cursor == 0 and request["window"] > 0:
                    # A prewarmed later collector may observe the boundary,
                    # but cannot capture before the preceding window passed.
                    if previous_receipt is None:
                        raise ValueError("SHADOW_PREVIOUS_WINDOW")
                    prior = daily.validate_receipt(load(previous_receipt))
                    if (prior["verdict"] != "PASS" or prior["delivery"] != "CONFIRMED"
                            or prior["window"] != request["window"] - 1
                            or any(prior[key] != request[key] for key in ("run", "build", "policy"))):
                        raise ValueError("SHADOW_PREVIOUS_WINDOW")
                if cut["custody_file"] is None:
                    value["residuals"]["cut-unbound-late-row"] += 1
                    return value
                custody = load(cut["custody_file"])
                identity = (cut["zid"], custody["expected"]["cut"], custody["expected"]["history"])
                if identity in seen:
                    raise ValueError("SHADOW_DUPLICATE_CUT")
                seen.add(identity)
                directory = str(Path(profile["private_directory"]) / f"readers-{request['window']}-{cursor}")
                scoped = copy.deepcopy(profile)
                scoped.update(zid=cut["zid"], requests=cut["requests"])
                scoped["readers"]["common"]["requests"] = [entry["route"]["request_sha256"] for entry in cut["requests"]]
                outcomes = collect(custody, scoped, directory)
                after = monotonic() - began
                if wall() > request["end"] or after > 86400 or abs((wall()-request["start"]) - after) > 2:
                    raise ValueError("SHADOW_CAPTURE_OUTSIDE_WINDOW")
                elapsed = after
                value["windows"]["bound"] += 1
                value["windows"]["incomplete"] -= 1
                value["admission"] = dict.fromkeys(value["admission"], True)
                value["admission"]["input"] = value["windows"]["incomplete"] == 0
                for route, verdict in outcomes:
                    value["routes"][route]["observed"] += 1
                    value["routes"][route][verdict] += 1
                cursor += 1
                if any(verdict in ("ENGINE_DIFFERENCE", "INCOMPLETE") for _, verdict in outcomes):
                    return value
            if elapsed >= next_observer:
                observed_at = wall()
                due_samples = min(1440, max(0, int((observed_at-request["start"])//60)))
                value["observer"] = observer_counts(profile["observer_file"], request, 1440,
                    profile["environment"], profile["readers"]["python_namespace"], observed_at)
                next_observer = (due_samples + 1) * 60
                if (value["observer"]["alarms"] or value["observer"]["unresolved"]
                        or value["observer"]["observed"] != due_samples):
                    return value
            sleep(min(1, max(0, request["end"]-wall())))
        value["observer"] = observer_counts(profile["observer_file"], request, 1440,
            profile["environment"], profile["readers"]["python_namespace"], wall())
    except Exception:
        value["admission"]["collector"] = False
    finally:
        if abs((wall()-request["start"]) - (monotonic()-began)) > 2:
            value["admission"]["collector"] = False
        value["seconds"] = min(86400, max(0, int(monotonic()-began)))
        value["verdict"] = daily.receipt_verdict(value)
        daily.validate_receipt(value)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("profile", "request", "output"):
        parser.add_argument("--"+flag, required=True)
    parser.add_argument("--previous-receipt")
    args = parser.parse_args()
    if os.environ.get("SHADOW_COLLECTOR_ENABLE") != "1":
        raise ValueError("SHADOW_COLLECTOR_DISABLED")
    result = run_window(load(args.request), load(args.profile), previous_receipt=args.previous_receipt)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(daily.canonical(result))
        out.flush()
        os.fsync(out.fileno())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("SHADOW_COLLECTOR_REFUSED") from None
