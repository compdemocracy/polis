"""Clojure PersistentHashMap iteration order for integer keys.

Some Clojure-parity semantics depend on the ITERATION ORDER of a Clojure
hash-map — e.g. the in-conv greedy floor (conversation.clj:259-268) stable-
sorts the user-vote-counts map by count descending, so equal-count ties keep
the map's own order. That order is deterministic, not arbitrary:

- Clojure's ``hasheq`` for a Long is ``Murmur3.hashLong`` (clojure.lang.Murmur3):
  murmur3-32 finalization over the two 32-bit halves, seed 0, length 8.
- ``PersistentHashMap`` is a HAMT consuming the 32-bit hash in 5-bit chunks,
  LOW bits first; each node iterates its entries in ascending chunk value.
  Iteration order is therefore a sort by the tuple of successive chunks.

Validated (2026-07-22) against three recorded-blob oracles — the raw JSON key
order of ``user-vote-counts`` written by Clojure's cheshire (which walks the
map in iteration order): n=18, n=30 and n=98 integer-pid maps, all exact.

Caveats, deliberate and documented:
- Integer keys, or numeric-string keys that normalize to one (`_as_long`) —
  both hash as the equivalent Clojure Long. Other key types (e.g. plain
  strings, whose Clojure hasheq is Murmur3 over ``String.hashCode``, not
  ``hashLong``) hash differently; :func:`clojure_hash_map_key_order` falls
  back to the given order for them.
- Full-hash collisions land in a HashCollisionNode (insertion order). For
  distinct realistic pid ranges Murmur3-32 collisions are vanishingly rare;
  the sort is stable, so colliding keys keep their given relative order —
  matching insertion order when the caller passes keys in insertion order.
- Clojure uses a PersistentArrayMap (insertion order) up to 8 entries. Callers
  whose semantics only engage above 8 entries (the greedy floor needs ≥16
  participants before a tie can matter) never see that regime.
"""

from __future__ import annotations

from typing import Any, Iterable, List

_MASK32 = 0xFFFFFFFF
_C1 = 0xCC9E2D51
_C2 = 0x1B873593


def _rotl32(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & _MASK32


def _mix_k1(k1: int) -> int:
    k1 = (k1 * _C1) & _MASK32
    k1 = _rotl32(k1, 15)
    return (k1 * _C2) & _MASK32


def _mix_h1(h1: int, k1: int) -> int:
    h1 ^= k1
    h1 = _rotl32(h1, 13)
    return (h1 * 5 + 0xE6546B64) & _MASK32


def _fmix(h1: int, length: int) -> int:
    h1 ^= length
    h1 ^= h1 >> 16
    h1 = (h1 * 0x85EBCA6B) & _MASK32
    h1 ^= h1 >> 13
    h1 = (h1 * 0xC2B2AE35) & _MASK32
    h1 ^= h1 >> 16
    return h1


def clojure_long_hash(value: int) -> int:
    """Clojure ``hasheq`` for a Long: ``Murmur3.hashLong`` (32-bit)."""
    if value == 0:
        return 0
    v = value & 0xFFFFFFFFFFFFFFFF  # two's-complement view of the long
    low = v & _MASK32
    high = (v >> 32) & _MASK32
    h1 = _mix_h1(0, _mix_k1(low))
    h1 = _mix_h1(h1, _mix_k1(high))
    return _fmix(h1, 8)


def _hamt_path(h: int) -> tuple:
    # 7 chunks cover all 32 hash bits (5×7 = 35 ≥ 32).
    return tuple((h >> shift) & 0x1F for shift in range(0, 35, 5))


def _as_long(k: Any) -> Any:
    """Numeric-string keys hash as their Long value: pids can arrive
    Python-side as either numeric strings OR native ints, depending on the
    pipeline — the legacy DynamoDB job pipeline (run_math_pipeline.py) still
    produces string pids in places, while the LIVE poller
    (``PostgresClient.poll_votes``/``poll_votes_since``) emits native ints as
    of 2026-07-24 (previously it also cast ``str(pid)``; fixed as part of the
    poller-equivalence harness's live-debugging session — see
    ``polismath/poller/__init__.py``'s bidToPid-shape note for the full
    rationale). Either way Clojure holds the DB's integer pid, so parity
    requires ordering by the integer's hash regardless of which Python
    pipeline produced the key — this function normalizes BOTH forms
    uniformly (an int key already IS its own Long value; a numeric-string
    key gets converted). Mirrors the ``int(tid) if tid.isdigit()`` idiom used
    for tids in conversation.py. Non-numeric keys pass through unchanged."""
    if isinstance(k, str) and k.lstrip('-').isdigit():
        return int(k)
    return k


def clojure_hash_map_key_order(keys: Iterable[Any]) -> List[Any]:
    """Return ``keys`` in Clojure PersistentHashMap iteration order.

    Keys that are ints — or numeric STRINGS, normalized via :func:`_as_long`
    for hashing only (the returned list keeps the original key objects) —
    are ordered by their HAMT path (5-bit chunks of hasheq, low first). If
    ANY key normalizes to something other than an int (bools excluded — they
    are ints in Python but not Longs in Clojure), the given order is
    returned unchanged: a wrong deterministic guess would be worse than the
    caller's documented fallback order.
    """
    key_list = list(keys)
    normalized = [_as_long(k) for k in key_list]
    if not all(isinstance(k, int) and not isinstance(k, bool) for k in normalized):
        return key_list
    return sorted(key_list, key=lambda k: _hamt_path(clojure_long_hash(_as_long(k))))
