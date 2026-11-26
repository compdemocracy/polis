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
  * the daemon yields: the lowest CPU weight of any service, a 2-CPU limit
    unless the document sets another (DELPHI_SHADOW_CONTAINER_CPUS; 0
    removes it), a 16 GiB memory ceiling, and the first process the kernel
    kills when memory runs out;
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
    "POLIS_JOBS_HOST_ALLOWLIST": "db.internal",
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
    # Stored comment vectors are handed to the run; only the others are encoded.
    # Hard-set: no deployment variable turns it off here, and no other service has it.
    assert env["POLIS_JOBS_EMBEDDINGS_REUSE"] == "1"
    assert _environment(service, dict(PRODUCTION_LIKE, POLIS_JOBS_EMBEDDINGS_REUSE="0"))["POLIS_JOBS_EMBEDDINGS_REUSE"] == "1"
    assert [name for name, other in services.items()
            if "POLIS_JOBS_EMBEDDINGS_REUSE" in _environment(other, PRODUCTION_LIKE)] == ["delphi-shadow"]
    assert (env["LLM_PROVIDER"], env["ANTHROPIC_TOPIC_MODEL"]) == ("anthropic", "none")
    assert env["DELPHI_SKIP_DATAMAPPLOT"] == "1"
    assert env["DELPHI_LOCAL_OUTPUT_CLEANUP"] == "1"
    assert env["DELPHI_STEP_LOG"] == "1"
    # The topic map step is off unless the environment document turns it on.
    assert env["DELPHI_TOPIC_MAP_DOCUMENT"] == "0"
    assert _environment(service, dict(PRODUCTION_LIKE, DELPHI_TOPIC_MAP_DOCUMENT="1"))["DELPHI_TOPIC_MAP_DOCUMENT"] == "1"
    assert env["SENTENCE_TRANSFORMER_MODEL"] == "ibm-granite/granite-embedding-311m-multilingual-r2"
    assert env["DELPHI_EMBED_MODEL_PATH"] == "/opt/polis/embedding/granite-embedding-311m-multilingual-r2"
    assert env["DELPHI_EMBED_MODEL_LOCK"] == "/opt/polis/embedding/granite-embedding-311m-multilingual-r2.lock.json"
    assert env["HF_HUB_OFFLINE"] == env["TRANSFORMERS_OFFLINE"] == "1"
    # Scratch, caches and local outputs are tmpfs, not the box's disk.
    tmpfs = service["tmpfs"]
    assert any(t.startswith("/tmp:size=") for t in tmpfs)
    assert {t.split(":")[0] for t in tmpfs} >= {"/tmp", "/app/polis_data", "/app/visualizations"}
    for key in ("POLIS_JOBS_WORK_DIR", "HF_HOME", "NUMBA_CACHE_DIR", "TMPDIR"):
        assert env[key].startswith("/tmp"), key
    assert env["POLIS_JOBS_JOURNAL_DIR"].startswith("/var/lib/delphi-shadow/")
    # A 2-CPU limit by default and the lowest CPU weight, a memory ceiling,
    # and the first to go when the box runs out of memory.
    limits = service["deploy"]["resources"]["limits"]
    assert _interpolate(str(limits["cpus"]), {}) == "2"
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
def test_the_comment_rule_lists_reach_the_scheduler_only_and_are_empty_by_default():
    services, _ = _services()
    keys = ("DELPHI_SHADOW_ALL_COMMENTS", "DELPHI_SHADOW_ALL_BUT_MODERATED_OUT")
    scheduler = _environment(services["delphi-shadow-scheduler"], PRODUCTION_LIKE)
    for key in keys:
        assert scheduler[key] == "", key
    listed = dict(PRODUCTION_LIKE, DELPHI_SHADOW_ALL_COMMENTS="69abcd", DELPHI_SHADOW_ALL_BUT_MODERATED_OUT="2xyz,3def")
    listed_env = _environment(services["delphi-shadow-scheduler"], listed)
    assert (listed_env[keys[0]], listed_env[keys[1]]) == ("69abcd", "2xyz,3def")
    # The daemon, which runs the pipeline, is never given them: a run's rule
    # reaches it only in its admission.
    daemon_env = _environment(services["delphi-shadow"], listed)
    for key in keys:
        assert key not in daemon_env, key


@requires_checkout
def test_the_production_report_service_is_unchanged_by_the_shadow():
    # The shadow's run settings stay its own. (The baked model's directory and
    # lock are shared on purpose: the next test.)
    services, _ = _services()
    delphi = _environment(services["delphi"], PRODUCTION_LIKE)
    for key in ("DELPHI_SKIP_DATAMAPPLOT", "DELPHI_STEP_LOG",
                "DELPHI_LOCAL_OUTPUT_CLEANUP", "HF_HUB_OFFLINE", "DELPHI_TOPIC_MAP_DOCUMENT"):
        assert key not in delphi, key


@requires_checkout
def test_the_production_report_service_reads_the_model_baked_into_its_image():
    # The same directory and lock the shadow reads, so a run checks the files
    # against the lock and downloads nothing; a document may override both, as
    # it may the service's other model settings.
    services, _ = _services()
    delphi = _environment(services["delphi"], PRODUCTION_LIKE)
    shadow = _environment(services["delphi-shadow"], PRODUCTION_LIKE)
    assert delphi["DELPHI_EMBED_MODEL_PATH"] == "/opt/polis/embedding/granite-embedding-311m-multilingual-r2"
    assert delphi["DELPHI_EMBED_MODEL_LOCK"] == "/opt/polis/embedding/granite-embedding-311m-multilingual-r2.lock.json"
    for key in ("SENTENCE_TRANSFORMER_MODEL", "DELPHI_EMBED_MODEL_PATH", "DELPHI_EMBED_MODEL_LOCK"):
        assert delphi[key] == shadow[key], key
    override = dict(PRODUCTION_LIKE, DELPHI_EMBED_MODEL_PATH="/srv/model", DELPHI_EMBED_MODEL_LOCK="/srv/model.lock.json")
    overridden = _environment(services["delphi"], override)
    assert (overridden["DELPHI_EMBED_MODEL_PATH"], overridden["DELPHI_EMBED_MODEL_LOCK"]) == (
        "/srv/model", "/srv/model.lock.json")


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
    # memory it is killed first. The optional graph executor and the derived
    # topic map worker are shadow work too: each carries exactly the shadow's
    # weight and OOM adjustment, and every other service outranks them.
    services, _ = _services()
    shadow = services["delphi-shadow"]
    shadow_daemons = ("delphi-shadow", "delphi-shadow-graph", "delphi-derived-worker")
    for name in shadow_daemons:
        assert services[name]["cpu_shares"] == shadow["cpu_shares"], name
        assert services[name]["oom_score_adj"] == shadow["oom_score_adj"], name
    for name, service in services.items():
        if name in shadow_daemons:
            continue
        assert service.get("cpu_shares", DEFAULT_CPU_SHARES) > shadow["cpu_shares"], name
        assert service.get("oom_score_adj", DEFAULT_OOM_SCORE_ADJ) < shadow["oom_score_adj"], name
    # Neither the math engine nor the report service is capped or weighted by
    # this file on the shadow's account: the math engine has no CPU cap.
    assert "cpus" not in services["math-python"]["deploy"]["resources"]["limits"]
    assert "cpu_shares" not in services["math-python"]


@requires_checkout
def test_an_operator_may_resize_or_remove_the_cpu_limit_and_size_the_ceiling():
    services, _ = _services()
    limits = services["delphi-shadow"]["deploy"]["resources"]["limits"]
    sized = {"DELPHI_SHADOW_CONTAINER_CPUS": "4", "DELPHI_SHADOW_CONTAINER_MEMORY": "6g"}
    assert _interpolate(str(limits["cpus"]), sized) == "4"
    assert _interpolate(str(limits["memory"]), sized) == "6g"
    # 0 removes the limit (Compose sets no CPU limit for 0); an empty line in
    # the document is the default 2-CPU limit, as unset is.
    assert _interpolate(str(limits["cpus"]), {"DELPHI_SHADOW_CONTAINER_CPUS": "0"}) == "0"
    assert _interpolate(str(limits["cpus"]), {"DELPHI_SHADOW_CONTAINER_CPUS": ""}) == "2"
    assert _interpolate(str(limits["cpus"]), {"DELPHI_SHADOW_CONTAINER_CPUS": "2"}) == "2"


# --- Derived topic maps: the worker's service and the scheduler's settings ---

DERIVED_KEYS = ("POLIS_JOBS_DERIVED_ADMISSION", "POLIS_JOBS_DERIVED_WORKER", "DELPHI_SHADOW_DERIVED_BACKFILL",
                "DELPHI_SHADOW_DERIVED_PER_CYCLE", "DELPHI_SHADOW_DERIVED_DAILY",
                "DELPHI_SHADOW_DERIVED_EVERY_SECONDS", "DELPHI_SHADOW_DERIVED_STORAGE_BYTES",
                "POLIS_API_DELPHI_TOPIC_MAP_DERIVED_READS")
WORKER = "delphi-derived-worker"


def _derived_overlay():
    return yaml.safe_load((CHECKOUT / "docker-compose.derived.yml").read_text())


@requires_checkout
def test_with_every_derived_key_absent_no_existing_service_names_one():
    # docker-compose.yml names the derived settings only in the worker's own
    # service, so with them absent every other service composes exactly as
    # it did before derived jobs. The scheduler's come from
    # docker-compose.derived.yml, which the deploy hook adds only on the
    # backfill's switch line; the report route's switch reaches polis-api
    # through its env file, as every polis-api route switch does.
    services, _ = _services()
    for name, service in services.items():
        if name == WORKER:
            continue
        text = yaml.safe_dump(service)
        assert not [key for key in DERIVED_KEYS if key in text], name


@requires_checkout
def test_the_schedulers_derived_settings_default_to_the_codes_own_and_reach_only_it():
    overlay = _derived_overlay()
    assert set(overlay) == {"services"}
    assert set(overlay["services"]) == {"delphi-shadow-scheduler"}
    assert set(overlay["services"]["delphi-shadow-scheduler"]) == {"environment"}
    composed = _environment(overlay["services"]["delphi-shadow-scheduler"], {})
    # queue-rs/src/shadow/config.rs and backfill.rs: off, 2, 100, 3600,
    # 1 GiB; admission off.
    assert composed == {"DELPHI_SHADOW_DERIVED_BACKFILL": "0", "DELPHI_SHADOW_DERIVED_PER_CYCLE": "2",
                        "DELPHI_SHADOW_DERIVED_DAILY": "100", "DELPHI_SHADOW_DERIVED_EVERY_SECONDS": "3600",
                        "DELPHI_SHADOW_DERIVED_STORAGE_BYTES": "1073741824",
                        "POLIS_JOBS_DERIVED_ADMISSION": "0"}
    document = {"DELPHI_SHADOW_DERIVED_BACKFILL": "1", "DELPHI_SHADOW_DERIVED_PER_CYCLE": "5",
                "DELPHI_SHADOW_DERIVED_DAILY": "50", "DELPHI_SHADOW_DERIVED_EVERY_SECONDS": "600",
                "DELPHI_SHADOW_DERIVED_STORAGE_BYTES": "2097152",
                "POLIS_JOBS_DERIVED_ADMISSION": "1"}
    assert _environment(overlay["services"]["delphi-shadow-scheduler"], document) == document


@requires_checkout
def test_the_derived_worker_is_off_by_default_and_logs_in_only_to_the_job_queue():
    services, _ = _services()
    worker = services[WORKER]
    assert worker["profiles"] == [WORKER]
    assert worker["command"] == ["polis-topic-map", "derived-worker"]
    assert worker["image"] == services["delphi-shadow"]["image"]
    assert worker["build"] == services["delphi-shadow"]["build"]
    off = _environment(worker, {})
    assert off["POLIS_JOBS_DERIVED_WORKER"] == "0"
    assert off["POLIS_JOBS_ENV"] == "shadow-delphi-1"
    on = _environment(worker, dict(PRODUCTION_LIKE, POLIS_JOBS_DERIVED_WORKER="1"))
    assert on["POLIS_JOBS_DERIVED_WORKER"] == "1"
    # The job daemon's own login and transport, and nothing else: never
    # DATABASE_URL (the input bundle's, and the web's), no provider or AWS key.
    assert set(on) == {"POLIS_JOBS_DERIVED_WORKER", "POLIS_JOBS_ENV", "QUEUE_DATABASE_URL", "POLIS_JOBS_TRANSPORT",
                       "POLIS_JOBS_CA_FILE", "POLIS_JOBS_HOST_ALLOWLIST"}
    assert on["QUEUE_DATABASE_URL"] == PRODUCTION_LIKE["QUEUE_DATABASE_URL"]
    assert on["POLIS_JOBS_TRANSPORT"] == "tls"
    assert "env_file" not in worker
    # Its jobs are in the shadow's env, where the scheduler asks for them.
    scheduler = _environment(services["delphi-shadow-scheduler"], {"DELPHI_SHADOW_ENV": "shadow-twin-1"})
    assert _environment(worker, {"DELPHI_SHADOW_ENV": "shadow-twin-1"})["POLIS_JOBS_ENV"] == scheduler["DELPHI_SHADOW_ENV"]


@requires_checkout
def test_the_derived_worker_keeps_nothing_on_the_box_and_is_bounded():
    services, volumes = _services()
    worker = services[WORKER]
    assert "volumes" not in worker
    assert not [name for name in volumes if "derived" in name]
    assert worker["read_only"] is True
    assert worker["tmpfs"] == ["/tmp:size=16m,mode=1777"]
    assert worker["cap_drop"] == ["ALL"]
    assert worker["security_opt"] == ["no-new-privileges:true"]
    assert "ports" not in worker
    # One job at a time on one thread: one CPU; a 1 GiB ceiling.
    assert worker["deploy"]["resources"]["limits"] == {"memory": "1g", "cpus": 1}
    assert worker["restart"] == "unless-stopped"


def _worker_program():
    (line,) = [line for line in (CHECKOUT / "scripts/after_install.sh").read_text().splitlines()
               if line.lstrip().startswith("DELPHI_DERIVED_WORKER_WRONG=$(")]
    assert line.count("'") == 2
    return line.split("'")[1]


def _worker_composed(env, worker_changes=None):
    services, _ = _services()
    worker = {"environment": _environment(services[WORKER], env), "command": services[WORKER]["command"]}
    worker.update(worker_changes or {})
    return {"services": {WORKER: worker, "delphi-shadow-scheduler": {
        "environment": _environment(services["delphi-shadow-scheduler"], env)}}}


@requires_checkout
@pytest.mark.skipif(shutil.which("jq") is None, reason="runs the hook's jq program with the real jq")
@pytest.mark.parametrize("extra,changes,named", [
    ({"POLIS_JOBS_CA_FILE": "/etc/polis/rds-ca.pem"}, None, ""),
    ({"POLIS_JOBS_CA_FILE": "/etc/polis/rds-ca.pem", "DELPHI_SHADOW_ENV": "shadow-twin-1"}, None, ""),
    ({"POLIS_JOBS_TRANSPORT": "local"}, None, ""),
    ({"POLIS_JOBS_CA_FILE": "/c", "POLIS_JOBS_HOST_ALLOWLIST": " , "}, None,
     f"{WORKER}.POLIS_JOBS_HOST_ALLOWLIST"),
    # The combinations that cannot work, each named, never its value.
    ({"POLIS_JOBS_CA_FILE": "/c", "QUEUE_DATABASE_URL": ""}, None, f"{WORKER}.QUEUE_DATABASE_URL"),
    ({}, None, f"{WORKER}.POLIS_JOBS_CA_FILE"),
    ({"POLIS_JOBS_TRANSPORT": "plain"}, None, f"{WORKER}.POLIS_JOBS_TRANSPORT"),
    ({"POLIS_JOBS_CA_FILE": "/c", "DELPHI_SHADOW_ENV": "prod"}, None, f"{WORKER}.POLIS_JOBS_ENV"),
    ({"POLIS_JOBS_CA_FILE": "/c", "POLIS_JOBS_DERIVED_WORKER": "0"}, None, f"{WORKER}.POLIS_JOBS_DERIVED_WORKER"),
    ({"POLIS_JOBS_CA_FILE": "/c"}, {"command": ["polis-jobs"]}, f"{WORKER}.command"),
    ({"POLIS_JOBS_CA_FILE": "/c"}, {"volumes": [{"type": "volume", "source": "x", "target": "/var/lib/x"}]},
     f"{WORKER}.volumes"),
])
def test_the_deploy_hooks_worker_read_back_passes_this_file_and_names_what_cannot_work(extra, changes, named):
    env = {**PRODUCTION_LIKE, "POLIS_JOBS_DERIVED_WORKER": "1", **extra}
    document = _worker_composed(env, changes)
    proc = subprocess.run(["jq", "-r", _worker_program()], input=json.dumps(document), text=True, capture_output=True)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == named + "\n"
    assert "db.internal" not in proc.stdout


@requires_checkout
@pytest.mark.skipif(shutil.which("jq") is None, reason="runs the hook's jq program with the real jq")
def test_the_worker_read_back_refuses_nodes_login_in_the_worker():
    env = dict(PRODUCTION_LIKE, POLIS_JOBS_DERIVED_WORKER="1", POLIS_JOBS_CA_FILE="/c")
    document = _worker_composed(env)
    document["services"][WORKER]["environment"]["DATABASE_URL"] = PRODUCTION_LIKE["DATABASE_URL"]
    proc = subprocess.run(["jq", "-r", _worker_program()], input=json.dumps(document), text=True, capture_output=True)
    assert (proc.returncode, proc.stdout) == (0, f"{WORKER}.DATABASE_URL\n")


@requires_checkout
def test_the_image_build_checks_both_derived_subcommands():
    dockerfile = (CHECKOUT / "delphi/Dockerfile").read_text()
    for sub in ("derived-worker", "shadow-scheduler"):
        assert f'/polis-topic-map 2>&1 | grep -q "polis-topic-map {sub}"' in dockerfile
    # The scheduler's exec finds polis-topic-map on PATH in the final image.
    assert "COPY --from=polis-jobs /polis-topic-map /usr/local/bin/polis-topic-map" in dockerfile
