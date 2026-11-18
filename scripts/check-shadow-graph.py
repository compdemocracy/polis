#!/usr/bin/env python3
"""Validate the optional graph executor in rendered Compose JSON; names only."""
import json
import re
import sys


def errors(config):
    services = config.get("services", {})
    graph = services.get("delphi-shadow-graph", {})
    env = graph.get("environment", {})
    scheduler = services.get("delphi-shadow-scheduler", {}).get("environment", {})
    expected = {
        "DELPHI_SHADOW_GRAPH_DAEMON": "1",
        "POLIS_JOBS_ENABLED": "1",
        "POLIS_JOBS_WORKER_CLASS": "delphi",
        "POLIS_JOBS_STAGES": "graph_embed,graph_cluster,graph_topics,graph_narrative",
        "POLIS_JOBS_CONCURRENCY": "1",
        "POLIS_JOBS_JOURNAL_DIR": "/var/lib/delphi-shadow-graph/journal",
        "POLIS_JOBS_JOURNAL_HOST_FILE": "/run/polis-host-id",
        "DELPHI_EMBEDDINGS_TABLE": "1",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "ANTHROPIC_TOPIC_MODEL": "none",
    }
    bad = [key for key, value in expected.items() if env.get(key) != value]
    queue = env.get("QUEUE_ENV", "")
    if (not re.fullmatch(r"shadow-[a-z0-9_-]{1,57}", queue)
            or queue != env.get("DELPHI_RESULT_ENV")
            or queue != scheduler.get("DELPHI_SHADOW_GRAPH_ENV")
            or queue == scheduler.get("DELPHI_SHADOW_ENV")):
        bad.append("QUEUE_ENV/DELPHI_RESULT_ENV")
    if graph.get("command") != ["polis-delphi-shadow", "daemon"]:
        bad.append("command")
    if graph.get("init") or graph.get("pid") or graph.get("privileged"):
        bad.append("process_namespace")
    volumes = graph.get("volumes", [])
    if not any(v.get("type") == "volume" and v.get("target") == "/var/lib/delphi-shadow-graph" for v in volumes):
        bad.append("journal_volume")
    if not any(v.get("type") == "bind" and str(v.get("source", "")).startswith("/") and v.get("target") == "/run/polis-host-id" and v.get("read_only") for v in volumes):
        bad.append("host_identity")
    limits = graph.get("deploy", {}).get("resources", {}).get("limits", {})
    if not limits.get("memory") or not limits.get("cpus"):
        bad.append("resource_limits")
    if graph.get("cpu_shares") != 2 or graph.get("oom_score_adj") != 1000:
        bad.append("resource_priority")
    return bad


if __name__ == "__main__":
    try:
        bad = errors(json.load(sys.stdin))
    except (ValueError, TypeError, AttributeError):
        bad = ["unreadable"]
    if bad:
        print("graph shadow settings: " + " ".join(bad), file=sys.stderr)
    sys.exit(bool(bad))
