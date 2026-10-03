"""The narrative report on a local Ollama model (LLM_PROVIDER=ollama).

Every model call goes to a fake Ollama HTTP server started in-process; the
conversation data are generated fixtures built here. No live model, no
DynamoDB and no Postgres: the queue and report tables are recording fakes.
"""

import importlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from umap_narrative.llm_factory_constructor.model_provider import (
    OllamaProvider,
    OllamaRequestError,
    ollama_base_url,
)
from umap_narrative.narrative_local import (
    LocalRunSettings,
    MalformedNarrativeOutput,
    parse_narrative_json,
)

NARRATIVE_DIR = Path(__file__).resolve().parents[1] / "umap_narrative"
JOB_ID = "batch_report_r123_1700000000_abcdef12"
PIPELINE_JOB = "0f0e0d0c-1111-2222-3333-444455556666"
MODEL = "llama3.2:3b"


def section_json(title):
    return json.dumps({
        "id": "generated",
        "title": title,
        "paragraphs": [{"id": "p1", "title": title, "sentences": [
            {"clauses": [{"text": f"Generated fixture text for {title}.", "citations": [1]}]}
        ]}],
    })


# --- fake Ollama server -------------------------------------------------------

class FakeOllama:
    """Answers POST /api/chat. ``reply(body)`` returns (status, payload, delay)."""

    def __init__(self, reply):
        self.reply = reply
        self.bodies = []
        self.in_flight = 0
        self.max_in_flight = 0
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with fake._lock:
                    fake.bodies.append(body)
                    fake.in_flight += 1
                    fake.max_in_flight = max(fake.max_in_flight, fake.in_flight)
                try:
                    status, payload, delay = fake.reply(body)
                    time.sleep(delay)
                    data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with fake._lock:
                        fake.in_flight -= 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake_ollama():
    servers = []

    def start(reply):
        server = FakeOllama(reply)
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.close()


def ok(content, delay=0.0):
    return 200, {"model": MODEL, "message": {"role": "assistant", "content": content}, "done": True}, delay


def title_of(body):
    # The generated fixture prompts start with "SECTION:<name>".
    return body["messages"][1]["content"].split("\n", 1)[0].split(":", 1)[1]


# --- the provider's strict call -------------------------------------------------

def test_base_url_accepts_ollama_host_forms():
    assert ollama_base_url("ollama:11434") == "http://ollama:11434"
    assert ollama_base_url("http://host.docker.internal:11434/") == "http://host.docker.internal:11434"
    assert ollama_base_url(None) == "http://localhost:11434"


def test_chat_strict_sends_one_bounded_json_request(fake_ollama):
    server = fake_ollama(lambda body: ok(section_json("t")))
    provider = OllamaProvider(model_name=MODEL, endpoint=server.endpoint)
    text = provider.chat_strict("sys", "user", max_tokens=8000, timeout=5, json_format=True, num_ctx=16384)
    assert json.loads(text)["title"] == "t"
    (body,) = server.bodies
    assert body["model"] == MODEL and body["stream"] is False and body["format"] == "json"
    assert body["options"] == {"num_predict": 8000, "num_ctx": 16384}
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def test_chat_strict_raises_on_timeout(fake_ollama):
    server = fake_ollama(lambda body: ok("{}", delay=2.0))
    provider = OllamaProvider(model_name=MODEL, endpoint=server.endpoint)
    with pytest.raises(OllamaRequestError, match="timed out"):
        provider.chat_strict("s", "u", timeout=0.3)


@pytest.mark.parametrize("reply,match", [
    ((500, {"error": "model not found"}, 0), "HTTP 500"),
    ((200, b"not json", 0), "no message content"),
    ((200, {"message": {"content": "  "}}, 0), "empty"),
])
def test_chat_strict_raises_on_unusable_reply(fake_ollama, reply, match):
    server = fake_ollama(lambda body: reply)
    provider = OllamaProvider(model_name=MODEL, endpoint=server.endpoint)
    with pytest.raises(OllamaRequestError, match=match):
        provider.chat_strict("s", "u", timeout=5)


# --- output parsing --------------------------------------------------------------

def test_parse_accepts_fences_and_stray_text():
    body = section_json("x")
    assert parse_narrative_json(f"```json\n{body}\n```")["title"] == "x"
    assert parse_narrative_json(f"Here is the JSON:\n{body}\nDone.")["title"] == "x"


@pytest.mark.parametrize("text", ["", "no json here", '{"title": "x"}', '{"paragraphs": [}', "[1, 2]"])
def test_parse_rejects_malformed(text):
    with pytest.raises(MalformedNarrativeOutput):
        parse_narrative_json(text)


def test_settings_from_env_defaults_and_knobs(monkeypatch):
    for key in ("OLLAMA_NARRATIVE_CONCURRENCY", "OLLAMA_REQUEST_TIMEOUT_SECONDS",
                "OLLAMA_NARRATIVE_JOB_TIMEOUT_SECONDS", "OLLAMA_NUM_CTX"):
        monkeypatch.setenv(key, "")
    assert LocalRunSettings.from_env() == LocalRunSettings(1, 600.0, 3000.0, 16384)
    monkeypatch.setenv("OLLAMA_NARRATIVE_CONCURRENCY", "3")
    monkeypatch.setenv("OLLAMA_REQUEST_TIMEOUT_SECONDS", "90")
    monkeypatch.setenv("OLLAMA_NUM_CTX", "not-a-number")
    settings = LocalRunSettings.from_env()
    assert (settings.concurrency, settings.request_timeout, settings.num_ctx) == (3, 90.0, 16384)


# --- 801 end to end, with recording fakes for the tables --------------------------

class RecordingTable:
    def __init__(self):
        self.puts, self.updates = [], []

    def put_item(self, Item, **_):
        self.puts.append(Item)
        return {}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)
        return {}


class RecordingDynamo:
    def __init__(self):
        self.tables = {}

    def Table(self, name):
        return self.tables.setdefault(name, RecordingTable())


@pytest.fixture
def batch_module(monkeypatch):
    monkeypatch.syspath_prepend(str(NARRATIVE_DIR))
    return importlib.import_module("umap_narrative.801_narrative_report_batch")


def generated_requests():
    """Three global sections then one topic, the order prepare_batch_requests
    produces, with the section names 801 builds."""
    names = [f"{JOB_ID}_global_groups", f"{JOB_ID}_global_group_informed_consensus",
             f"{JOB_ID}_global_uncertainty", f"{PIPELINE_JOB}_0_3"]
    return [{
        "system": "generated fixture system lore",
        "messages": [{"role": "user", "content": f"SECTION:{name}\n<polis-comments/>"}],
        "max_tokens": 8000,
        "metadata": {"topic_name": name, "section_name": name, "cluster_id": 3 if i == 3 else None,
                     "topic_key": name, "conversation_id": "42"},
    } for i, name in enumerate(names)]


def make_generator(batch_module, monkeypatch, provider="ollama"):
    monkeypatch.setenv("LLM_PROVIDER", provider)
    gen = batch_module.BatchReportGenerator.__new__(batch_module.BatchReportGenerator)
    gen.conversation_id = "42"
    gen.provider = "ollama" if provider == "ollama" else "anthropic"
    gen.model = MODEL
    gen.job_id = JOB_ID
    gen.report_id = "r123"
    gen.dynamodb = RecordingDynamo()
    gen.report_storage = batch_module.NarrativeReportService(dynamodb_resource=gen.dynamodb)

    async def prepare():
        return generated_requests()

    gen.prepare_batch_requests = prepare
    return gen


def run_local(gen, endpoint, **settings):
    import asyncio
    provider = OllamaProvider(model_name=MODEL, endpoint=endpoint)
    return asyncio.run(gen.run_local(ollama_provider=provider, settings=LocalRunSettings(**settings)))


def test_happy_path_stores_every_section_with_provenance(batch_module, monkeypatch, fake_ollama):
    server = fake_ollama(lambda body: ok(section_json(title_of(body))))
    gen = make_generator(batch_module, monkeypatch)
    assert run_local(gen, server.endpoint) is True

    reports = gen.dynamodb.Table("Delphi_NarrativeReports").puts
    # Section names are the ones 803 would store and the report looks up.
    assert [r["section"] for r in reports] == [
        "batch_re_global_groups", "batch_re_global_group_informed_consensus",
        "batch_re_global_uncertainty", f"{PIPELINE_JOB}_0_3"]
    for r in reports:
        assert r["rid_section_model"] == f"r123#{r['section']}#{MODEL}"
        assert r["model"] == MODEL and r["job_id"] == JOB_ID and r["provider"] == "ollama"
        assert r["metadata"]["provider"] == "ollama" and r["metadata"]["model"] == MODEL
        assert json.loads(r["report_data"])["paragraphs"]

    queue = gen.dynamodb.Table("Delphi_JobQueue")
    # Provider and model recorded on the job; no batch id, no checker row.
    assert queue.puts == []
    (update,) = queue.updates
    assert update["ExpressionAttributeValues"] == {":provider": "ollama", ":model": MODEL}
    assert "batch_id" not in update["UpdateExpression"]
    # Same prompts, same order, one at a time by default.
    assert [title_of(b) for b in server.bodies] == [m["metadata"]["section_name"] for m in generated_requests()]
    assert server.max_in_flight == 1


def test_concurrency_knob_allows_parallel_requests(batch_module, monkeypatch, fake_ollama):
    server = fake_ollama(lambda body: ok(section_json(title_of(body)), delay=0.3))
    gen = make_generator(batch_module, monkeypatch)
    assert run_local(gen, server.endpoint, concurrency=2) is True
    assert server.max_in_flight == 2


def _failed_job_message(gen):
    updates = gen.dynamodb.Table("Delphi_JobQueue").updates
    errors = [u["ExpressionAttributeValues"][":error"] for u in updates if ":error" in u["ExpressionAttributeValues"]]
    assert len(errors) == 1
    return errors[0]


def test_malformed_output_fails_the_job_and_marks_the_section(batch_module, monkeypatch, fake_ollama):
    def reply(body):
        name = title_of(body)
        return ok("I think the groups mostly agree." if name.endswith("_uncertainty") else section_json(name))

    server = fake_ollama(reply)
    gen = make_generator(batch_module, monkeypatch)
    assert run_local(gen, server.endpoint) is False

    message = _failed_job_message(gen)
    assert message.startswith("1 of 4 sections failed") and "batch_re_global_uncertainty" in message
    by_section = {r["section"]: r for r in gen.dynamodb.Table("Delphi_NarrativeReports").puts}
    placeholder = json.loads(by_section["batch_re_global_uncertainty"]["report_data"])
    assert placeholder["id"] == "polis_narrative_error_message"
    assert by_section["batch_re_global_uncertainty"]["provider"] == "ollama"
    assert len(by_section) == 4


def test_request_timeout_fails_the_job(batch_module, monkeypatch, fake_ollama):
    server = fake_ollama(lambda body: ok(section_json(title_of(body)), delay=1.5))
    gen = make_generator(batch_module, monkeypatch)
    assert run_local(gen, server.endpoint, request_timeout=0.2) is False
    assert "timed out" in _failed_job_message(gen)


def test_job_budget_stops_sending(batch_module, monkeypatch, fake_ollama):
    server = fake_ollama(lambda body: ok(section_json(title_of(body)), delay=0.4))
    gen = make_generator(batch_module, monkeypatch)
    assert run_local(gen, server.endpoint, job_timeout=0.5, request_timeout=5) is False
    assert len(server.bodies) < 4
    assert _failed_job_message(gen).split(" ", 3)[:3] != ["0", "of", "4"]
    last = gen.dynamodb.Table("Delphi_NarrativeReports").puts[-1]
    assert last["section"] == f"{PIPELINE_JOB}_0_3"
    assert "time budget" in last["report_data"]


def test_all_sections_failing_writes_nothing(batch_module, monkeypatch, fake_ollama):
    # The report shows the newest job that has rows; a run with no good
    # section must not replace an earlier good run with error placeholders.
    server = fake_ollama(lambda body: (500, {"error": "model not found"}, 0))
    gen = make_generator(batch_module, monkeypatch)
    assert run_local(gen, server.endpoint) is False
    assert gen.dynamodb.Table("Delphi_NarrativeReports").puts == []
    assert _failed_job_message(gen).startswith("4 of 4 sections failed")
    assert "HTTP 500" in _failed_job_message(gen)


def test_failed_store_is_not_counted_as_success(batch_module, monkeypatch, fake_ollama):
    server = fake_ollama(lambda body: ok(section_json(title_of(body))))
    gen = make_generator(batch_module, monkeypatch)
    gen.report_storage.store_report = lambda **kwargs: None  # the service's "write failed" value
    assert run_local(gen, server.endpoint) is False
    assert "could not be written" in _failed_job_message(gen)


# --- provider selection -----------------------------------------------------------

def test_main_dispatches_on_llm_provider(batch_module, monkeypatch):
    import asyncio
    calls = []

    class Stub:
        def __init__(self, **kwargs):
            self.provider = "ollama" if batch_module.resolve_provider_type() == "ollama" else "anthropic"

        async def run_local(self):
            calls.append("local")
            return True

        async def submit_batch(self):
            calls.append("batch")
            return "msgbatch_1"

    monkeypatch.setattr(batch_module, "BatchReportGenerator", Stub)
    monkeypatch.setattr("sys.argv", ["801", "--conversation_id=42"])
    for provider, expected in (("ollama", "local"), ("anthropic", "batch"), ("", "batch")):
        monkeypatch.setenv("LLM_PROVIDER", provider)
        asyncio.run(batch_module.main())
        assert calls.pop() == expected


def test_local_failure_exits_nonzero(batch_module, monkeypatch):
    import asyncio

    class Stub:
        provider = "ollama"

        def __init__(self, **kwargs):
            pass

        async def run_local(self):
            return False

    monkeypatch.setattr(batch_module, "BatchReportGenerator", Stub)
    monkeypatch.setattr("sys.argv", ["801", "--conversation_id=42"])
    with pytest.raises(SystemExit) as exit_info:
        asyncio.run(batch_module.main())
    assert exit_info.value.code == 1


def test_poller_model_follows_the_provider():
    from scripts.job_poller import narrative_model_for_provider

    assert narrative_model_for_provider({"LLM_PROVIDER": "ollama", "OLLAMA_MODEL": MODEL}) == MODEL
    assert narrative_model_for_provider({"LLM_PROVIDER": "OLLAMA"}) == "llama3.1:8b"
    assert narrative_model_for_provider({"ANTHROPIC_MODEL": "claude-x"}) == "claude-x"
    assert narrative_model_for_provider({"LLM_PROVIDER": "anthropic", "ANTHROPIC_MODEL": "claude-x",
                                         "OLLAMA_MODEL": MODEL}) == "claude-x"
    with pytest.raises(ValueError, match="ANTHROPIC_MODEL"):
        narrative_model_for_provider({"LLM_PROVIDER": "anthropic"})


def test_batch_custom_id_unchanged_for_the_hosted_path(batch_module, monkeypatch):
    gen = make_generator(batch_module, monkeypatch, provider="anthropic")
    assert gen._batch_custom_id(f"{JOB_ID}_global_groups") == "42_batch_re_global_groups"
    assert gen._batch_custom_id(f"{PIPELINE_JOB}_0_3") == f"42_{PIPELINE_JOB}_0_3"
    long_name = "x" * 80
    assert gen._batch_custom_id(long_name) == ("42_" + long_name)[:64]


def test_topic_naming_client_reaches_a_non_default_endpoint(fake_ollama):
    # get_response (the topic-naming call) goes through the ollama package's
    # client, which must be bound to OLLAMA_HOST rather than localhost.
    server = fake_ollama(lambda body: ok('"Generated Label"'))
    provider = OllamaProvider(model_name=MODEL, endpoint=f"http://{server.endpoint}")
    assert provider.get_response("", "name this") == '"Generated Label"'
    assert len(server.bodies) == 1
