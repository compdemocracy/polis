"""T3: the three Postgres math writers must serialize numpy scalar types.

`write_math_main` / `write_math_bidtopid` / `write_participant_stats`
(postgres.py) serialize their blob with `json.dumps`. A real math blob can carry
numpy scalars — the repness `gid` is `astype(int)` => numpy `int64`
(repness.py:847), and the na/nd/ns counts are `astype(int)` sums (:672-675).
`json.dumps` handles `np.float64` (a subclass of `float`) but NOT `np.int64`, so
any such blob raised `TypeError: Object of type int64 is not JSON serializable`
and rolled the WHOLE write cycle back. The writers now pass
`default=convert_numpy_types`.

Note: pandas 2.x's `DataFrame.to_dict('records')` down-converts numpy scalars to
Python natives, which masks the raw reproduction on the committed test datasets.
But numpy scalars DO reach the serialization boundary in production — see the
boto3 "Float types are not supported" note at repness.py:843. So this test takes
a REAL, computed, 2-group `to_dict()` blob (not a toy dict, which is what the
earlier writer unit tests used) and faithfully reintroduces the numpy integer
type at every integral leaf, which is environment-independent.
"""

import json

import numpy as np
import pytest

from polismath.conversation.conversation import Conversation
from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.poller.math_writer import derive_bidtopid, derive_ptptstats


def _two_group_conv():
    """A synthetic conversation with two opposing camps -> 2 groups + repness."""
    votes = []
    n_per, n_cmts = 8, 8
    for p in range(n_per * 2):
        camp = 0 if p < n_per else 1
        for t in range(n_cmts):
            v = (1.0 if t % 2 == 0 else -1.0) if camp == 0 else (-1.0 if t % 2 == 0 else 1.0)
            votes.append({"pid": f"p{p}", "tid": f"c{t}", "vote": v})
    return Conversation("t3").update_votes({"votes": votes})


def _numpy_ints(o):
    """Deep-copy a JSON-ish structure, casting every integral leaf to np.int64
    (leaving bools/floats/strings alone). Faithfully simulates the numpy scalars
    that repness.py:847/:672-675 emit and that older pandas / boto3 paths keep."""
    if isinstance(o, bool):
        return o
    if isinstance(o, (int, np.integer)):
        return np.int64(o)
    if isinstance(o, dict):
        return {k: _numpy_ints(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_numpy_ints(v) for v in o]
    return o


def _client_capturing():
    """A PostgresClient whose _write_returning is stubbed to capture the params
    (so we exercise the real json.dumps in the writer without a live DB)."""
    client = PostgresClient(PostgresConfig(url="postgresql://ignored/db", math_env="t3"))
    captured = {}

    def _fake_write_returning(sql, params=None, *, connection=None):
        captured["params"] = params
        return []

    client._write_returning = _fake_write_returning
    return client, captured


class TestWritersSerializeNumpy:
    def test_math_main_round_trips_real_blob_with_numpy(self):
        conv = _two_group_conv()
        blob = conv.to_dict()
        # Legacy blob shape (the only shape since the mode collapse): repness
        # is {gid: [kebab-key entries]} — the writer's fidelity-critical input.
        gid0 = sorted(blob["repness"].keys())[0]
        recs = blob["repness"][gid0]
        assert recs and "repful-for" in recs[0]

        blob_np = _numpy_ints(blob)
        assert any(isinstance(r["n-success"], np.integer)
                   for r in blob_np["repness"][gid0])

        # RED precondition (environment-independent): bare json.dumps rejects it.
        with pytest.raises(TypeError, match="int64 is not JSON serializable"):
            json.dumps(blob_np)

        # The writer serializes and the blob round-trips (values back as ints).
        client, cap = _client_capturing()
        client.write_math_main(1, blob_np, last_vote_timestamp=123, math_tick=0)
        restored = json.loads(cap["params"]["data"])
        first_gid_key = sorted(restored["repness"].keys())[0]
        got = restored["repness"][first_gid_key][0]["n-success"]
        assert isinstance(got, int) and not isinstance(got, bool)

    def test_bidtopid_round_trips_real_blob_with_numpy(self):
        conv = _two_group_conv()
        blob = _numpy_ints(derive_bidtopid(conv, 1))
        with pytest.raises(TypeError, match="int64 is not JSON serializable"):
            json.dumps(blob)
        client, cap = _client_capturing()
        client.write_math_bidtopid(1, blob, math_tick=0)
        assert json.loads(cap["params"]["data"])["zid"] == 1

    def test_ptptstats_round_trips_real_blob_with_numpy(self):
        conv = _two_group_conv()
        blob = _numpy_ints(derive_ptptstats(conv, 1))
        with pytest.raises(TypeError, match="int64 is not JSON serializable"):
            json.dumps(blob)
        client, cap = _client_capturing()
        client.write_participant_stats(1, blob, math_tick=0)
        assert json.loads(cap["params"]["data"])["zid"] == 1
