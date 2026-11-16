"""The Delphi shadow's two Compose services: off, free by construction, bounded.

Read from docker-compose.yml as YAML (no docker daemon), with ${...}
interpolation evaluated as `docker compose config` would, using the helpers of
test_compose_math_env.py. What this pins:
  * both services are profile-gated and each process's switch defaults off;
  * no LLM provider key, no Anthropic model and no AWS key or S3 setting is
    listed, so an environment document that carries them still puts none into
    either container (a key not listed never reaches it: no env_file);
  * the daemon claims only the shadow env, the full pipeline, one job at a
    time, with the visualization pages skipped, the embedding model read from
    the image offline, and its scratch on tmpfs;
  * the daemon yields instead of being fenced: the lowest CPU weight of any
    service and no CPU cap unless the document sets one, a 16 GiB memory
    ceiling, and the first process the kernel kills when memory runs out;
  * the scheduler and the daemon name the same env, and that env is a shadow env;
  * the deploy hook's read-back of the two services passes this file as it
    is, and names the settings when one line of the environment document
    gives the shadow a served env.
"""

import json
import re
import shutil
import subprocess

import pytest
import yaml

from tests.test_compose_math_env import CHECKOUT, _interpolate, requires_checkout

SERVICES = ("delphi-shadow", "delphi-shadow-scheduler")
SECRET_LIKE = re.compile(r"(API_KEY|SECRET|PASSWORD|TOKEN|ANTHROPIC_MODEL$|^AWS_ACCESS|^AWS_S3|^OLLAMA)")

# An environment document as production's carries it, plus the shadow switch.
PRODUCTION_LIKE = {
    "ANTHROPIC_API_KEY": "sk-generated-not-a-key",
    "ANTHROPIC_MODEL": "claude-generated",
    "AWS_ACCESS_KEY_ID": "generated",
    "AWS_SECRET_ACCESS_KEY": "generated",
    "AWS_S3_BUCKET_NAME": "generated-bucket",
    "DATABASE_URL": "postgres://u:p@db.internal:5432/polis?sslmode=require",
    "QUEUE_DATABASE_URL": "postgres://q@db.internal:5432/polis",
    "MATH_POLLER_SOURCE_COMMIT": "0123456789abcdef0123456789abcdef01234567",
    "DELPHI_SHADOW_ENABLED": "1",
}


def _services():
    compose = yaml.safe_load((CHECKOUT / "docker-compose.yml").read_text())
    return compose["services"], compose.get("volumes", {})


def _environment(service, env):
    out = {}
    for entry in service.get("environment", []):
        key, _, value = entry.partition("=")
        out[key] = _interpolate(value, env) if "=" in entry else env.get(key)
    return out


@requires_checkout
def test_both_services_are_profile_gated_and_off_by_default():
    services, volumes = _services()
    for name in SERVICES:
        assert services[name]["profiles"] == ["delphi-shadow"], name
        assert "ports" not in services[name], name
        assert "env_file" not in services[name], name
    assert _environment(services["delphi-shadow"], {})["POLIS_JOBS_ENABLED"] == "0"
    assert _environment(services["delphi-shadow-scheduler"], {})["DELPHI_SHADOW_ENABLED"] == "0"
    assert "delphi-shadow-state" in volumes


@requires_checkout
@pytest.mark.parametrize("name", SERVICES)
def test_no_provider_key_aws_key_or_bucket_reaches_either_container(name):
    services, _ = _services()
    env = _environment(services[name], PRODUCTION_LIKE)
    assert not [k for k in env if SECRET_LIKE.search(k)], env
    for value in env.values():
        assert "sk-generated" not in (value or "")
        assert "generated-bucket" not in (value or "")


@requires_checkout
def test_the_daemon_is_free_paced_offline_and_bounded():
    services, _ = _services()
    service = services["delphi-shadow"]
    env = _environment(service, PRODUCTION_LIKE)
    # The env check in front of polis-jobs (polis-delphi-shadow daemon).
    assert service["command"] == ["polis-delphi-shadow", "daemon"]
    assert env["POLIS_JOBS_ENABLED"] == "1"
    assert env["QUEUE_ENV"] == env["DELPHI_RESULT_ENV"] == "shadow-delphi-1"
    assert env["DELPHI_RESULT_BACKEND"] == "postgres"
    assert env["POLIS_JOBS_STAGES"] == "delphi_full_pipeline"
    assert env["POLIS_JOBS_CONCURRENCY"] == "1"
    assert env["POLIS_JOBS_INPUT_BUNDLE"] == "1"
    assert env["DELPHI_EMBEDDINGS_TABLE"] == "1"
    assert (env["LLM_PROVIDER"], env["ANTHROPIC_TOPIC_MODEL"]) == ("anthropic", "none")
    assert env["DELPHI_SKIP_DATAMAPPLOT"] == "1"
    assert env["DELPHI_LOCAL_OUTPUT_CLEANUP"] == "1"
    assert env["DELPHI_STEP_LOG"] == "1"
    assert env["DELPHI_EMBED_MODEL_PATH"] == "/opt/polis/embedding/all-MiniLM-L6-v2"
    assert env["DELPHI_EMBED_MODEL_LOCK"] == "/opt/polis/embedding/all-MiniLM-L6-v2.lock.json"
    assert env["HF_HUB_OFFLINE"] == env["TRANSFORMERS_OFFLINE"] == "1"
    # Scratch, caches and local outputs are tmpfs, not the box's disk.
    tmpfs = service["tmpfs"]
    assert any(t.startswith("/tmp:size=") for t in tmpfs)
    assert {t.split(":")[0] for t in tmpfs} >= {"/tmp", "/app/polis_data", "/app/visualizations"}
    for key in ("POLIS_JOBS_WORK_DIR", "HF_HOME", "NUMBA_CACHE_DIR", "TMPDIR"):
        assert env[key].startswith("/tmp"), key
    assert env["POLIS_JOBS_JOURNAL_DIR"].startswith("/var/lib/delphi-shadow/")
    # No CPU cap by default (0 is none), a low CPU weight instead, a memory
    # ceiling, and the first to go when the box runs out of memory.
    limits = service["deploy"]["resources"]["limits"]
    assert _interpolate(str(limits["cpus"]), {}) == "0"
    assert _interpolate(str(limits["memory"]), {}) == "16g"
    assert service["cpu_shares"] == 2
    assert service["oom_score_adj"] == 1000
    assert "reservations" not in service["deploy"]["resources"]


@requires_checkout
def test_the_scheduler_names_the_daemons_shadow_env():
    services, _ = _services()
    daemon = _environment(services["delphi-shadow"], PRODUCTION_LIKE)
    scheduler = _environment(services["delphi-shadow-scheduler"], PRODUCTION_LIKE)
    assert services["delphi-shadow-scheduler"]["command"] == ["polis-delphi-shadow"]
    assert scheduler["DELPHI_SHADOW_ENV"] == scheduler["QUEUE_ENV"] == daemon["QUEUE_ENV"]
    assert scheduler["DELPHI_SHADOW_ENV"].startswith("shadow-")
    assert scheduler["DELPHI_SHADOW_CODE_VERSION"] == PRODUCTION_LIKE["MATH_POLLER_SOURCE_COMMIT"]
    assert scheduler["DELPHI_SHADOW_TWIN_EVERY"] == "0", "twin runs are off unless asked"
    # The storage budget: 3 GiB in all, no daily limit (0) and 1 GiB of it
    # kept for live conversations, unless the document says; a daily limit
    # or a reserve the document sets is passed through.
    assert (
        scheduler["DELPHI_SHADOW_STORAGE_BUDGET_MB"],
        scheduler["DELPHI_SHADOW_STORAGE_DAILY_MB"],
        scheduler["DELPHI_SHADOW_LIVE_RESERVE_MB"],
    ) == ("3072", "0", "1024")
    set_env = dict(PRODUCTION_LIKE, DELPHI_SHADOW_STORAGE_DAILY_MB="300", DELPHI_SHADOW_LIVE_RESERVE_MB="512")
    daily = _environment(services["delphi-shadow-scheduler"], set_env)
    assert (daily["DELPHI_SHADOW_STORAGE_DAILY_MB"], daily["DELPHI_SHADOW_LIVE_RESERVE_MB"]) == ("300", "512")
    # No conversation is a benchmark unless the document lists it; the
    # featured (open-data) and current (live) sets need no setting. The
    # participant-count source and the list's old name are gone: a document
    # line of either reaches neither service.
    assert scheduler["DELPHI_SHADOW_BENCHMARK"] == ""
    listed = dict(
        PRODUCTION_LIKE,
        DELPHI_SHADOW_BENCHMARK="2abc,3def",
        DELPHI_SHADOW_IMPORTANT="4ghi",
        DELPHI_SHADOW_LARGE_PARTICIPANTS="200",
    )
    listed_env = _environment(services["delphi-shadow-scheduler"], listed)
    assert listed_env["DELPHI_SHADOW_BENCHMARK"] == "2abc,3def"
    daemon_env = _environment(services["delphi-shadow"], listed)
    for retired in ("DELPHI_SHADOW_IMPORTANT", "DELPHI_SHADOW_LARGE_PARTICIPANTS"):
        assert retired not in listed_env and retired not in daemon_env
    # The daemon, which runs the pipeline, is never given the list.
    assert "DELPHI_SHADOW_BENCHMARK" not in daemon_env
    other = dict(PRODUCTION_LIKE, DELPHI_SHADOW_ENV="shadow-twin-1")
    assert _environment(services["delphi-shadow"], other)["QUEUE_ENV"] == "shadow-twin-1"
    assert _environment(services["delphi-shadow-scheduler"], other)["QUEUE_ENV"] == "shadow-twin-1"


@requires_checkout
def test_the_production_report_service_is_unchanged_by_the_shadow():
    services, _ = _services()
    delphi = _environment(services["delphi"], PRODUCTION_LIKE)
    for key in ("DELPHI_SKIP_DATAMAPPLOT", "DELPHI_EMBED_MODEL_PATH", "DELPHI_STEP_LOG",
                "DELPHI_LOCAL_OUTPUT_CLEANUP", "HF_HUB_OFFLINE"):
        assert key not in delphi, key


def _hook_program():
    """The jq program of the deploy hook's Delphi shadow read-back."""
    (line,) = [line for line in (CHECKOUT / "scripts/after_install.sh").read_text().splitlines()
               if line.lstrip().startswith("DELPHI_SHADOW_SETTINGS_WRONG=$(")]
    return line.split("'")[1]


def _composed(env):
    services, _ = _services()
    return {"services": {name: {"environment": _environment(services[name], env),
                                "command": services[name]["command"]} for name in SERVICES}}


@requires_checkout
@pytest.mark.skipif(shutil.which("jq") is None, reason="runs the hook's jq program with the real jq")
@pytest.mark.parametrize("extra,named", [
    ({}, ""),
    ({"DELPHI_SHADOW_ENV": "shadow-twin-1"}, ""),
    # One wrong line: the served env given to the shadow. The daemon would
    # claim and publish under it; the hook refuses to start either service.
    ({"DELPHI_SHADOW_ENV": "import-example-1"}, "delphi-shadow.QUEUE_ENV delphi-shadow-scheduler.DELPHI_SHADOW_ENV"),
    ({"DELPHI_SHADOW_ENV": "prod"}, "delphi-shadow.QUEUE_ENV delphi-shadow-scheduler.DELPHI_SHADOW_ENV"),
])
def test_the_deploy_hooks_read_back_passes_this_file_and_refuses_a_served_env(extra, named):
    proc = subprocess.run(["jq", "-r", _hook_program()], input=json.dumps(_composed(dict(PRODUCTION_LIKE, **extra))),
                          text=True, capture_output=True)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == named + "\n"
    assert "import-example-1" not in proc.stdout


# Docker's defaults for a service that sets neither: cgroup v2 cpu.weight 100
# (cpu_shares 1024 on cgroup v1) and oom_score_adj 0.
DEFAULT_CPU_SHARES = 1024
DEFAULT_OOM_SCORE_ADJ = 0


@requires_checkout
def test_the_shadow_yields_cpu_and_memory_to_every_other_service():
    # Every other service, the math engine, the report service and the web
    # services included, keeps Docker's default weight and OOM adjustment (or
    # sets a higher weight and a lower adjustment), so under contention the
    # shadow gets the smallest share of a CPU, and when the box runs out of
    # memory it is killed first.
    services, _ = _services()
    shadow = services["delphi-shadow"]
    for name, service in services.items():
        if name == "delphi-shadow":
            continue
        assert service.get("cpu_shares", DEFAULT_CPU_SHARES) > shadow["cpu_shares"], name
        assert service.get("oom_score_adj", DEFAULT_OOM_SCORE_ADJ) < shadow["oom_score_adj"], name
    # Neither the math engine nor the report service is capped or weighted by
    # this file on the shadow's account: the math engine has no CPU cap.
    assert "cpus" not in services["math-python"]["deploy"]["resources"]["limits"]
    assert "cpu_shares" not in services["math-python"]


@requires_checkout
def test_an_operator_may_fence_the_shadow_and_size_its_ceiling():
    services, _ = _services()
    limits = services["delphi-shadow"]["deploy"]["resources"]["limits"]
    fenced = {"DELPHI_SHADOW_CONTAINER_CPUS": "2", "DELPHI_SHADOW_CONTAINER_MEMORY": "6g"}
    assert _interpolate(str(limits["cpus"]), fenced) == "2"
    assert _interpolate(str(limits["memory"]), fenced) == "6g"
    # An empty line in the document is no fence, as unset is.
    assert _interpolate(str(limits["cpus"]), {"DELPHI_SHADOW_CONTAINER_CPUS": ""}) == "0"
