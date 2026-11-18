"""The optional executor must retain its local journal and shadow boundary."""
import importlib.util

import pytest

from tests.test_compose_math_env import CHECKOUT, requires_checkout

# The deploy hook's validator, read from the checkout the Compose tests read
# ($POLIS_CHECKOUT_DIR in the Delphi test container, where the deploy-hook
# runner copies it). A missing file fails these tests; it is never a skip.
pytestmark = requires_checkout


@pytest.fixture(scope="module")
def module():
    spec = importlib.util.spec_from_file_location(
        "shadow_graph_compose", CHECKOUT / "scripts/check-shadow-graph.py")
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def valid():
    env = dict(DELPHI_SHADOW_GRAPH_DAEMON="1", POLIS_JOBS_ENABLED="1",
               QUEUE_ENV="shadow-graph-1", DELPHI_RESULT_ENV="shadow-graph-1",
               POLIS_JOBS_WORKER_CLASS="delphi",
               POLIS_JOBS_STAGES="graph_embed,graph_cluster,graph_topics,graph_narrative",
               POLIS_JOBS_CONCURRENCY="1", POLIS_JOBS_JOURNAL_DIR="/var/lib/delphi-shadow-graph/journal",
               POLIS_JOBS_JOURNAL_HOST_FILE="/run/polis-host-id", DELPHI_EMBEDDINGS_TABLE="1",
               HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", ANTHROPIC_TOPIC_MODEL="none")
    graph = dict(environment=env, command=["polis-delphi-shadow", "daemon"],
                 volumes=[dict(type="volume", target="/var/lib/delphi-shadow-graph"),
                          dict(type="bind", source="/etc/machine-id", target="/run/polis-host-id", read_only=True)],
                 deploy=dict(resources=dict(limits=dict(memory=6*1024**3, cpus="2"))),
                 cpu_shares=2, oom_score_adj=1000)
    scheduler = dict(environment=dict(DELPHI_SHADOW_ENV="shadow-delphi-1", DELPHI_SHADOW_GRAPH_ENV="shadow-graph-1"))
    return dict(services={"delphi-shadow-graph": graph, "delphi-shadow-scheduler": scheduler})


def test_accepts_the_isolated_executor(module):
    assert module.errors(valid()) == []


def test_refuses_a_served_or_shared_env(module):
    for env in ["prod", "shadow-delphi-1"]:
        config = valid()
        config["services"]["delphi-shadow-graph"]["environment"]["QUEUE_ENV"] = env
        assert module.errors(config)


def test_refuses_a_missing_journal_or_host_identity(module):
    for index in [0, 1]:
        config = valid()
        config["services"]["delphi-shadow-graph"]["volumes"].pop(index)
        assert module.errors(config)


def test_refuses_a_different_process_namespace_or_stage(module):
    for key, value in [("init", True), ("pid", "host"), ("privileged", True)]:
        config = valid()
        config["services"]["delphi-shadow-graph"][key] = value
        assert module.errors(config)
    config = valid()
    config["services"]["delphi-shadow-graph"]["environment"]["POLIS_JOBS_STAGES"] = "delphi_full_pipeline"
    assert module.errors(config)
