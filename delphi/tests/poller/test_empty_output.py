"""Pin every emission path to the committed schedule, not a copied fixture."""
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from polismath.conversation.conversation import Conversation
from polismath.empty_output import apply_empty_contract, empty_contract
from polismath.engine_adapter import emit_payloads
from polismath.poller.math_writer import MathWriter, empty_contract_payloads

SCHEDULE = Path(__file__).resolve().parents[2] / "scripts/schedules/pc-zerovote-01-empty.json"


def assert_contract(main):
    for path, expected in json.loads(SCHEDULE.read_text())["empty_output"].items():
        value = main
        for key in path.split("."):
            value = value[key]
        # JSON spelling catches bool/number substitutions and signed zero.
        assert json.dumps(value, sort_keys=True) == json.dumps(expected, sort_keys=True), path


@pytest.mark.parametrize("moderated", [False, True])
@pytest.mark.parametrize("path", ["conversation", "plain-writer", "publisher", "helper", "adapter", "adapter-old-false"])
def test_all_empty_emission_paths(path, moderated):
    conv = Conversation(42, last_updated=999)
    if moderated:
        conv = conv.update_moderation({"mod_out_tids": [17, 7], "mod_in_tids": [18, 8],
                                      "meta_tids": [9], "lastModTimestamp": 1234}, recompute=False)
    before = (conv.last_updated, conv.pca, set(conv.mod_out_tids))
    if path == "conversation":
        main = conv.to_dict()
    elif path == "helper":
        main, bid, stats = empty_contract_payloads(conv, 42, {})
        assert bid["lastVoteTimestamp"] == stats["lastVoteTimestamp"] == 0
    elif path.startswith("adapter"):
        bundle = emit_payloads(conv, 42, path != "adapter-old-false")
        main = bundle["main"]
        assert bundle["bidtopid"]["lastVoteTimestamp"] == bundle["ptptstats"]["lastVoteTimestamp"] == 0
    else:
        pg = MagicMock()
        publisher = MagicMock() if path == "publisher" else None
        MathWriter(pg, publisher).write_conv_updates(42, conv)
        if publisher is None:
            args = pg.write_math_main.call_args
            main = json.loads(args.args[1])
            assert args.kwargs["last_vote_timestamp"] == 0
            assert json.loads(pg.write_math_bidtopid.call_args.kwargs["data"])["lastVoteTimestamp"] == 0
            assert json.loads(pg.write_participant_stats.call_args.kwargs["data"])["lastVoteTimestamp"] == 0
            pg.transaction.assert_called_once()
        else:
            _, main_raw, bid_raw, stats_raw = publisher.publish.call_args.args
            main = json.loads(main_raw)
            assert json.loads(bid_raw)["lastVoteTimestamp"] == json.loads(stats_raw)["lastVoteTimestamp"] == 0
            pg.transaction.assert_not_called()
    assert_contract(main)
    assert main["mod-in"] == ([8, 18] if moderated else [])
    assert main["mod-out"] == ([7, 17] if moderated else [])
    assert (conv.last_updated, conv.pca, conv.mod_out_tids) == before


def test_contract_values_are_isolated():
    a = apply_empty_contract({})
    a["pca"]["center"].append(99)
    a["consensus"]["agree"].append(99)
    assert_contract(apply_empty_contract({}))
    assert empty_contract() == json.loads(SCHEDULE.read_text())["empty_output"]


def test_first_vote_is_not_classified_empty():
    conv = Conversation(42, last_updated=1)
    conv.to_dict()
    conv = conv.update_votes({"votes": [{"pid": 1, "tid": 2, "vote": 1, "created": 123}],
                              "lastVoteTimestamp": 123}, recompute=True)
    bundle = emit_payloads(conv, 42)
    assert bundle["main"]["n"] == 1
    assert bundle["main"]["tids"] == [2]
    assert all(row["lastVoteTimestamp"] == 123 for row in bundle.values())
