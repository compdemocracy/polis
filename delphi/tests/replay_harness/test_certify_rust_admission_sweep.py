"""P-045 round 8: property-style admission sweep.

Feeds randomly-generated malformed JSON shapes into EVERY public bridge entry
point that returns a failure list, and asserts no exception escapes — the whole
value is graded. hypothesis is not installed in this venv, so this uses a seeded
recursive generator (deterministic). It also mutates valid factory evidence with
random values (including out-of-f64-range integers that exercise the digest
refusal path) so the sweep reaches the deep custody/digest code, not only the
outer guards.
"""

from __future__ import annotations

import importlib.util
import random
from pathlib import Path

from polismath.replay import coordinator_driver as cd


def _load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_manifest = _load("test_certify_rust_identity")._manifest
_bundle = _load("test_certify_rust_publication")._bundle

# Strings that are NOT UTF-8-encodable (lone surrogates) or are valid non-BMP,
# used in every string position (keys and values). Lone surrogates must be graded
# (serde cannot hold them); valid astral scalars must encode/hash.
_SURROGATES = ["\ud800", "\udfff", "\udc00", "a\ud800b", "🐀pair",
               chr(0x1F600), "astral \U0001d538 key"]
_ATOMS = [
    None, True, False, 0, 1, -1, 7,
    2 ** 63, 2 ** 64, 2 ** 64 + 1, -(2 ** 63) - 1, 10 ** 25, 10 ** 400, -(10 ** 400),
    0.0, -0.0, 1.5, 1e-7, 1e21, float("inf"), float("nan"),
    "", "x", "é", "a\nb\t\"c\\", "\x00\x1f", "sha", "a" * 64,
    [], {}, [1], {"x": 1}, {"slot": 0}, {"sha256": []},
] + _SURROGATES

_KEYS = ["a", "b", "x", "slot", "sha256", "data", "id", "members", "count",
         "bidToPid", "zid", "schema", "cursors", "votes", "operation_id",
         "publisher_epoch", "original_digests", "payload_digests",
         "base-clusters", "group-clusters"] + _SURROGATES


def _rand_json(rng, depth=0):
    if depth >= 4 or rng.random() < 0.45:
        return rng.choice(_ATOMS)
    if rng.random() < 0.5:
        return [_rand_json(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    return {rng.choice(_KEYS): _rand_json(rng, depth + 1) for _ in range(rng.randint(0, 4))}


def _graded(result):
    return isinstance(result, list) and all(isinstance(f, str) for f in result)


def _call_all(value, rng):
    """Every public failure-list entry point, on `value` as the outer container
    and (for readback/observer) as a substituted row inside a valid skeleton."""
    calls = 0
    assert _graded(cd.validate_s1_identity(value)); calls += 1
    assert _graded(cd.validate_s1_identity(
        value, expected_admission=value if isinstance(value, dict) else {},
        expected_identity=value if isinstance(value, dict) else {},
        expected_cursors=value, expected_files=value)); calls += 1
    assert _graded(cd.validate_readback(
        value, expected_prior_tick=rng.choice([None, 0, 3, True]),
        operation_id=rng.choice(["op-1", 7, None]),
        publisher_epoch=rng.choice([5, True, "x"]),
        expected_input_checkpoint=value if isinstance(value, dict) else None)); calls += 1
    assert _graded(cd.observe_bundle_coherence(value)); calls += 1
    # substitute the random value into each slot of a valid bundle/manifest
    for slot in ("main", "bidtopid", "ptptstats", "ticks", "zid", "math_env"):
        b = _bundle()
        b[slot] = value
        assert _graded(cd.validate_readback(b, expected_prior_tick=None,
                                            operation_id="op-1", publisher_epoch=5)); calls += 1
        assert _graded(cd.observe_bundle_coherence(b)); calls += 1
    # mutate the store checkpoint and a payload's data (reaches digest/custody)
    b = _bundle()
    b["ticks"]["input_checkpoint"] = value
    assert _graded(cd.validate_readback(b, expected_prior_tick=None,
                                        operation_id="op-1", publisher_epoch=5)); calls += 1
    b = _bundle()
    b["main"]["data"] = value
    assert _graded(cd.validate_readback(b, expected_prior_tick=None,
                                        operation_id="op-1", publisher_epoch=5)); calls += 1
    m = _manifest()
    for slot in ("files", "math_input_cursors", "observed_state_cursors", "admission"):
        mm = dict(m)
        mm[slot] = value
        assert _graded(cd.validate_s1_identity(mm)); calls += 1
    # a string value carried in the digested payload and the original bytes,
    # plus a string custody field (reaches the serde encoder and str encode)
    if isinstance(value, str):
        b = _bundle()
        b["main"]["data"] = {"k": value}
        b["main"]["original_bytes"] = value
        assert _graded(cd.validate_readback(b, expected_prior_tick=None,
                                            operation_id="op-1", publisher_epoch=5)); calls += 1
        b = _bundle()
        b["main"]["data"] = {value: 1}   # the string as a payload KEY
        assert _graded(cd.validate_readback(b, expected_prior_tick=None,
                                            operation_id="op-1", publisher_epoch=5)); calls += 1
        for field in ("operation_id", "schema"):
            b = _bundle()
            b["ticks"]["input_checkpoint"][field] = value
            assert _graded(cd.validate_readback(b, expected_prior_tick=None,
                                                operation_id="op-1", publisher_epoch=5)); calls += 1
    return calls


def test_admission_sweep_no_exception_escapes():
    rng = random.Random(459)
    total = 0
    for _ in range(1500):
        total += _call_all(_rand_json(rng), rng)
    # A fixed corpus of adversarial atoms as the outer value too, and every
    # surrogate/valid-astral string injected into every string position.
    for atom in _ATOMS:
        total += _call_all(atom, rng)
    for s in _SURROGATES:
        total += _call_all(s, rng)
    assert total > 20000
    # expose the count for the notes
    print(f"\nADMISSION SWEEP: {total} public-entry calls, no exception escaped")
