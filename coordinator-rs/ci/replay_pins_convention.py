"""The replay pins at either storage convention (P-078 §1d, PR-G).

    python3 coordinator-rs/ci/replay_pins_convention.py --write   # regenerate
    python3 coordinator-rs/ci/replay_pins_convention.py --check   # CI: committed == generated

``replay-pins.json`` (and ``../evidence/polarity-public-fixture.json``) were
recorded against databases that store agree as -1; their companions
``replay-pins.sign.json`` and ``polarity-public-fixture.sign.json`` declare so.
They stay as history. This module generates the second pinned set, at
agree = +1, from the SAME semantic data, so a replay against a database at
either convention has a pin to be asserted against:
``pins_path(storage_agree_value)`` names the file and
``replay_pins.select_pin`` reads either (same schema).

How each +1 value is obtained (also written into the file, per pin):

* RECORDED AT +1. Every polarity witness already holds one run at each
  convention: ``a`` (rows stored at -1, engine at -1) and ``b`` (the same
  semantic rows stored at +1, engine at ``STORAGE_AGREE_VALUE=1``); the rebuild
  schedule's ``positive``/``paired`` likewise; the tie key's
  ``mirrored_digest`` is the ordering digest the +1 run declared. At +1 the
  run at the database's own convention is the old ``b``/``paired`` and the
  paired run is the old ``a``/``positive``. These are swaps of recorded values.
* CARRIED, ASSUMED SYMMETRIC. ``negative`` in the -1 set is +1 rows read at -1;
  its +1 counterpart (-1 rows read at +1) was never recorded. It is carried
  unchanged and labelled as such, not as recorded.
* CONVENTION-INVARIANT, RECORDED AT -1 ONLY. The live-equivalence checkpoint
  digests and the D4 served-byte witnesses hash semantic output and served
  bytes, which the polarity property (``a == b`` in every witness above, on
  every platform) says do not depend on the storage convention. They are
  carried unchanged and listed as such; the first campaign run at +1 records
  them, and any difference is a finding, never a repin of the -1 set.
* DECLARED. The tie key's declared ordering states ``storage_agree_value``;
  at +1 it states 1, with the ``algorithm_digest`` recorded at +1.

Standard library only. Nothing here learns a value from fresh output.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Dict

CI = Path(__file__).resolve().parent
EVIDENCE = CI.parent / "evidence"

#: The pin registry for each storage convention (agree's stored value).
PINS: Dict[int, Path] = {-1: CI / "replay-pins.json", 1: CI / "replay-pins.agree-plus-one.json"}
#: The public-fixture polarity witness for each convention.
PUBLIC_FIXTURE: Dict[int, Path] = {
    -1: EVIDENCE / "polarity-public-fixture.json",
    1: CI / "polarity-public-fixture.agree-plus-one.json",
}
COMPANIONS = {"replay-pins.json": CI / "replay-pins.sign.json",
              "polarity-public-fixture.json": CI / "polarity-public-fixture.sign.json"}

POLARITY = ("polarity-public-fixture.json", "polarity-vw.json", "polarity-biodiversity.json")
SCHEDULE = "polarity-rebuild-schedule.json"
TIE_KEY = "semantic-tie-key.json"
INVARIANT_WITNESSES = ("d4-node-reader.json", "d4-node-reader-empty.json")


def pins_path(storage_agree_value: int) -> Path:
    if type(storage_agree_value) is not int or storage_agree_value not in PINS:
        raise ValueError(f"storage_agree_value must be the integer -1 or +1, got {storage_agree_value!r}")
    return PINS[storage_agree_value]


def declared(companion: Path) -> int:
    """The convention a companion declares for its fixture, after checking the
    fixture's bytes against the declared hash."""
    meta = json.loads(companion.read_text())
    if meta.get("schema") != "declared-vote-sign/1":
        raise ValueError(f"{companion}: not a declared-vote-sign/1 companion")
    fixture = (companion.parent / meta["fixture"]).resolve()
    if hashlib.sha256(fixture.read_bytes()).hexdigest() != meta["fixture_sha256"]:
        raise ValueError(f"{companion}: {fixture.name} changed after its sign was declared")
    value = meta["storage_agree_value"]
    if type(value) is not int or value not in PINS:
        raise ValueError(f"{companion}: storage_agree_value must be -1 or +1")
    return value


def witness_sha256(witness) -> str:
    """The digest replay-pins.json records for a witness file (json.dumps, indent=2)."""
    return hashlib.sha256(json.dumps(witness, indent=2).encode()).hexdigest()


def polarity_plus_one(witness: dict) -> dict:
    """A polarity witness at +1: the run at the database's own convention is the
    recorded +1 run (old ``b``), the paired run the recorded -1 run (old ``a``)."""
    if set(witness) != {"fixture", "a", "b", "negative", "deltas"} or witness["deltas"] != []:
        raise ValueError("unexpected polarity witness shape")
    return {**witness, "a": witness["b"], "b": witness["a"]}


def schedule_plus_one(rows: list) -> list:
    out = []
    for row in rows:
        if set(row) != {"step", "positive", "paired", "negative"}:
            raise ValueError("unexpected rebuild-schedule witness shape")
        out.append({**row, "positive": row["paired"], "paired": row["positive"]})
    return out


def tie_key_plus_one(witness: dict) -> dict:
    declared_order = witness["declared"]
    if declared_order["storage_agree_value"] != -1:
        raise ValueError("the -1 tie key must declare storage_agree_value -1")
    at_plus_one = {**copy.deepcopy(declared_order), "storage_agree_value": 1,
                   "algorithm_digest": witness["mirrored_digest"]}
    return {**witness, "declared": at_plus_one, "mirrored_digest": declared_order["algorithm_digest"],
            "a": witness["b"], "b": witness["a"]}


PROVENANCE = {
    "recorded_at_plus_one": [
        "witnesses/polarity-*.json a (the -1 registry's b), b (its a)",
        "witnesses/polarity-rebuild-schedule.json positive (the -1 registry's paired), paired (its positive)",
        "witnesses/semantic-tie-key.json declared.algorithm_digest (the -1 registry's mirrored_digest), a, b",
    ],
    "declared": ["witnesses/semantic-tie-key.json declared.storage_agree_value = 1"],
    "carried_assumed_symmetric_not_recorded": [
        "witnesses/polarity-*.json, polarity-rebuild-schedule.json, semantic-tie-key.json negative: the -1 "
        "registry's negative is +1 rows read at -1; its +1 counterpart (-1 rows read at +1) was never "
        "recorded and is carried on the assumption that the two wrong-sign readings hash alike",
    ],
    "convention_invariant_recorded_at_minus_one_only": [
        "checkpoints[*].rust (semantic math output of the live-equivalence cuts)",
        "witnesses/d4-node-reader.json, witnesses/d4-node-reader-empty.json (served bytes)",
    ],
}


def pin_plus_one(pin: dict) -> dict:
    out = copy.deepcopy(pin)
    witnesses = out["witnesses"]
    for name in POLARITY:
        witnesses[name] = polarity_plus_one(witnesses[name])
    witnesses[SCHEDULE] = schedule_plus_one(witnesses[SCHEDULE])
    witnesses[TIE_KEY] = tie_key_plus_one(witnesses[TIE_KEY])
    out["witness_sha256"] = {name: witness_sha256(witnesses[name]) for name in sorted(witnesses)}
    if pin.get("label_remap"):
        # The rename record describes the -1 file's bytes; it is history there.
        out.pop("label_remap")
    out["convention_provenance"] = PROVENANCE
    return out


def plus_one(registry: dict) -> dict:
    if registry.get("schema") != "polis-replay-platform-pins/2":
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: schema")
    return {
        "schema": registry["schema"],
        "convention": {
            "storage_agree_value": 1,
            "generated_by": "coordinator-rs/ci/replay_pins_convention.py",
            "generated_from": {"replay-pins.json": hashlib.sha256(PINS[-1].read_bytes()).hexdigest()},
            "paired_with": "replay-pins.json (storage_agree_value -1, declared in replay-pins.sign.json)",
            "about": ("The replay pins at agree = +1, generated from the same semantic data as the -1 set: "
                      "recorded +1 values swapped into place, convention-invariant values carried, "
                      "per convention_provenance. Never edited by hand; regenerate with --write."),
        },
        "pins": [pin_plus_one(pin) for pin in registry["pins"]],
        "retired_pins": [],
    }


def render(value) -> str:
    return json.dumps(value, indent=2) + "\n"


def generated() -> Dict[Path, str]:
    for name, companion in COMPANIONS.items():
        if declared(companion) != -1:
            raise ValueError(f"{name}: the recorded set must declare storage_agree_value -1")
    registry = json.loads(PINS[-1].read_text())
    public = json.loads(PUBLIC_FIXTURE[-1].read_text())
    return {PINS[1]: render(plus_one(registry)), PUBLIC_FIXTURE[1]: json.dumps(polarity_plus_one(public), indent=2)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    stale = []
    for path, text in generated().items():
        if args.write:
            path.write_text(text)
        elif not path.exists() or path.read_text() != text:
            stale.append(str(path.relative_to(CI.parent.parent)))
    if stale:
        print("stale +1 pin set (regenerate with --write and review the diff): " + ", ".join(stale))
        return 1
    print("+1 pin set " + ("written" if args.write else "matches its generator"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
