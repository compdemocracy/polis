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
    the image offline, and its scratch on tmpfs; its limits are 2 CPUs and 6 GiB;
  * the scheduler and the daemon name the same env, and that env is a shadow env.
"""

import re

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
    assert service["command"] == ["polis-jobs"]
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
    limits = service["deploy"]["resources"]["limits"]
    assert _interpolate(str(limits["cpus"]), {}) == "2"
    assert _interpolate(str(limits["memory"]), {}) == "6g"


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
