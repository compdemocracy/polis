"""The provider a namer names (``config.naming.provider``): absent, the
naming is exactly today's; ``bedrock`` reaches the program and is recorded
beside the model; without the Amazon Bedrock price settings the run keeps
its keyword names with reason ``no_price`` and completes."""
import json
import os
import shutil

import pytest

from tests.test_topic_namer import (CHARACTERISTICS, HAIKU, HAIKU_ARG, Names, pipeline, run_naming,
                                    small_hierarchy, stub, stub_argv, topic_namer)

BEDROCK = {"provider": "bedrock", **HAIKU}
BEDROCK_ARG = '{"provider":"bedrock","model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"default"}'
PRICE = ("DELPHI_NAMING_BEDROCK_INPUT_USD_PER_MTOK", "DELPHI_NAMING_BEDROCK_OUTPUT_USD_PER_MTOK",
         "DELPHI_NAMING_BEDROCK_PRICE_SOURCE")
TODAYS_FACTS = {"provider", "model", "namer", "prompt", "thinking", "outcome", "reason"}


def test_an_absent_or_default_provider_is_todays_namer_and_bedrock_is_kept():
    assert topic_namer.parse_namer(HAIKU_ARG) == HAIKU
    anthropic = json.dumps({"provider": "anthropic", **HAIKU})
    assert topic_namer.parse_namer(anthropic) == HAIKU
    assert topic_namer.namer_argument(topic_namer.parse_namer(anthropic)) == HAIKU_ARG
    assert topic_namer.parse_namer(BEDROCK_ARG) == BEDROCK
    # The job child's argument is passed on byte for byte, whatever the order given.
    reordered = json.dumps(dict(reversed(list(BEDROCK.items()))))
    assert topic_namer.namer_argument(topic_namer.parse_namer(reordered)) == BEDROCK_ARG
    for bad in ["vertex", "Bedrock", None, 1, ["bedrock"]]:
        with pytest.raises(topic_namer.NamerRefused):
            topic_namer.parse_namer(json.dumps({"provider": bad, **HAIKU}))


def test_the_step_facts_of_a_default_namer_are_todays_and_bedrock_adds_its_provider():
    today = topic_namer.step_facts(topic_namer._result(HAIKU, "named", names={}))
    assert set(today) == TODAYS_FACTS and today["namer"] == HAIKU_ARG
    assert today["provider"] == "polis-topic-names"
    bedrock = topic_namer.step_facts(topic_namer._result(BEDROCK, "no_price", "stand-in"))
    assert set(bedrock) == TODAYS_FACTS | {"namer_provider"}
    assert (bedrock["namer_provider"], bedrock["namer"], bedrock["provider"]) == (
        "bedrock", BEDROCK_ARG, "polis-topic-names")


def test_bedrock_reaches_the_programs_arguments_and_its_record(stub, monkeypatch):
    for key, value in zip(PRICE, ("2.2", "11", "made-up figures for a test")):
        monkeypatch.setenv(key, value)
    work = stub / "work"
    result = topic_namer.run_namer(BEDROCK, small_hierarchy(), str(work))
    assert result["outcome"] == "named" and result["namer"] == BEDROCK
    [argv] = stub_argv(stub)
    assert argv[-2:] == ["--namer", BEDROCK_ARG]


def test_without_a_price_a_bedrock_run_keeps_its_keyword_names_and_completes(pipeline, stub, monkeypatch, tmp_path):
    import run_delphi
    from polismath.job_child import full_pipeline_models
    from umap_narrative.topic_naming import _conventional_labels

    for key in PRICE:
        monkeypatch.delenv(key, raising=False)
    storage = Names()
    labels, notes, naming = run_naming(pipeline, monkeypatch, tmp_path, BEDROCK, storage)
    for layer in (0, 1):
        assert labels[layer] == {str(k): v for k, v in _conventional_labels(CHARACTERISTICS[layer]).items()}
    assert naming["outcome"] == "no_price" and naming["reason"] == "stand-in no_price"
    assert naming["namer"] == BEDROCK and naming["tokens_in"] is None
    for n in notes:
        assert (n["model"], n["outcome"], n["namer_provider"], n["namer"]) == (
            "keywords", "no_price", "bedrock", BEDROCK_ARG)
    assert {r.model_name for r in storage.rows} == {"keywords"}
    assert full_pipeline_models(naming)["topic"] == "keywords"
    # A completed pipeline with this record is a completed run, never a failed one.
    assert run_delphi.recorded_naming(0, naming, None, BEDROCK) == (0, naming)


REAL = os.environ.get("DELPHI_TOPIC_NAMES_REAL_BIN") or shutil.which("polis-topic-names")


@pytest.mark.skipif(not REAL, reason="polis-topic-names is not built")
def test_the_real_program_without_a_price_makes_no_call_and_says_no_price(tmp_path, monkeypatch):
    monkeypatch.setenv(topic_namer.BINARY, REAL)
    for key in PRICE + ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    result = topic_namer.run_namer(BEDROCK, small_hierarchy(), str(tmp_path / "work"))
    assert result["outcome"] == "no_price" and result["names"] == {}
    assert result["tokens_in"] is None and result["tokens_out"] is None and result["dollars"] is None
    assert os.listdir(tmp_path / "work") == []


def test_the_map_records_the_namer_provider_in_algorithm_facts(monkeypatch):
    from polismath import step_log
    from polismath.delphi_storage.topic_map import execution_record

    monkeypatch.setattr(step_log, "_record", None)
    for namer, provider in ((HAIKU, None), (BEDROCK, "bedrock")):
        step_log.record()
        result = topic_namer._result(namer, "no_price")
        step_log.note("topic_names", **topic_namer.step_facts(result))
        execution = execution_record(step_log.recorded(), "participant_visible/1")
        assert execution["steps"] == []
        [facts] = execution["algorithms"]["topic_names"]
        assert facts["namer"] == topic_namer.namer_argument(namer)
        assert facts.get("namer_provider") == provider
        if provider is None:
            assert "namer_provider" not in facts
