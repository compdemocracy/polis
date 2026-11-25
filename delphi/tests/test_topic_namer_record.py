"""What a named run stores and what it records agree: the record is sent
before any label is written, and when it cannot be, the keyword labels are
published under a keyword record that keeps the call's token counts."""
import os

from tests.test_topic_namer import HAIKU, Names, pipeline, run_naming, stub, topic_namer


def _failing_first(monkeypatch, failures):
    real = topic_namer.send_record
    calls = []

    def send(fd, result):
        calls.append(result["outcome"])
        if len(calls) <= failures:
            raise OSError("the record pipe is refused for this test")
        real(fd, result)

    monkeypatch.setattr(topic_namer, "send_record", send)
    return calls


def _received(exchange):
    record, _ = exchange.finish()
    topic_namer.set_acknowledged(True)
    return record


def test_a_record_that_cannot_be_sent_publishes_keywords_under_a_keyword_record_with_the_cost(
        pipeline, stub, monkeypatch, tmp_path):
    from polismath.job_child import full_pipeline_models, naming_cost

    calls = _failing_first(monkeypatch, 1)
    exchange = topic_namer.RecordExchange()
    storage = Names()
    labels, notes, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    assert calls == ["named", "namer_failed"]
    assert {row.model_name for row in storage.rows} == {"keywords"}
    assert not any("Generated name" in label for layer in labels.values() for label in layer.values())
    assert [(n["model"], n["outcome"], n["model_clusters"]) for n in notes] == [
        ("keywords", "namer_failed", [])] * 2
    assert naming["reason"] == "record_unsent (OSError)" and naming["tokens_in"] == 25445
    record = _received(exchange)
    assert record == naming
    # The map (from the in-memory record) and the manifest (from the pipe) agree.
    assert full_pipeline_models(record) == full_pipeline_models(naming)
    assert full_pipeline_models(record)["topic"] == "keywords"
    assert naming_cost(record)["llm_tokens_in"] == 25445


def test_a_record_that_is_never_sent_never_publishes_the_models_names(pipeline, stub, monkeypatch, tmp_path):
    _failing_first(monkeypatch, 2)
    exchange = topic_namer.RecordExchange()
    storage = Names()
    _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    assert {row.model_name for row in storage.rows} == {"keywords"}
    assert naming["outcome"] == "namer_failed"
    assert _received(exchange) is None


def test_the_record_is_read_without_waiting_on_a_process_that_still_holds_the_pipe():
    read_end, write_end = os.pipe()
    result = topic_namer._result(HAIKU, "http_429", "busy", record={"tokens_in": 7, "tokens_out": 1})
    os.write(write_end, b'{"partial')
    topic_namer.send_record(write_end, result)
    try:
        # write_end stays open, as in a forked process that outlived the pipeline.
        assert topic_namer.receive_record(read_end) == topic_namer.record_of(result)
    finally:
        os.close(read_end)
        os.close(write_end)


def test_a_record_without_its_final_newline_is_not_complete():
    import json
    read_end, write_end = os.pipe()
    try:
        record = topic_namer.record_of(topic_namer._result(HAIKU, "named"))
        os.write(write_end, ("\n" + json.dumps(record)).encode())
        assert topic_namer.receive_record(read_end) is None
    finally:
        os.close(read_end)
        os.close(write_end)
