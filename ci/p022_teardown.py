#!/usr/bin/env python3
"""P-022 §E — terminate the disposable CI worker and PROVE it.

Astra's #2715 review (E7) broke the round-1 shell version two ways, and both
were the same mistake: treating the absence of evidence as evidence.

  * a failed ``describe-instances`` produced empty output, which the lost-ID
    branch read as "nothing was launched" and exited 0;
  * a known ID whose describe returned the literal text ``None`` matched none
    of the four active-state substrings, which the confirm loop read as
    "terminated".

So this is Python, it parses actual records rather than grepping text, and it
distinguishes three outcomes that shell string-matching cannot:

  * discovery succeeded and found nothing  -> nothing to do,
  * discovery FAILED                       -> unresolved ownership, exit 1,
  * discovery found instances              -> terminate and confirm each one.

Confirmation means every expected instance ID is observed in state
``terminated``. ``shutting-down`` is progress and keeps the loop running;
``InvalidInstanceID.NotFound`` inside the polling window means the ID was never
real, which is a failure, not a success. Nothing here ever concludes from a
missing identity.

  usage: p022_teardown.py --run-tag <run_id>-<attempt> [--instance-id i-...]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

ACTIVE = {"pending", "running", "stopping", "stopped"}
IN_PROGRESS = {"shutting-down"}
DONE = {"terminated"}


class DiscoveryError(RuntimeError):
    """describe-instances did not answer. Never conflate with an empty answer."""


def aws(*args: str) -> str:
    proc = subprocess.run(
        ["aws", *args], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise DiscoveryError(
            f"aws {' '.join(args[:2])} failed rc={proc.returncode}: "
            f"{proc.stderr.strip()[:300]}")
    return proc.stdout


def describe(instance_ids: list[str] | None, run_tag: str | None) -> dict[str, str]:
    """Return {instance_id: state}. Raises DiscoveryError if the API did not answer."""
    args = ["ec2", "describe-instances", "--output", "json",
            "--query", "Reservations[].Instances[].{Id:InstanceId,State:State.Name}"]
    if instance_ids:
        args += ["--instance-ids", *instance_ids]
    else:
        args += ["--filters", f"Name=tag:polis:ci-run,Values={run_tag}"]
    raw = aws(*args)
    try:
        records = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        raise DiscoveryError(f"unparseable describe-instances response: {exc}") from exc
    if not isinstance(records, list):
        raise DiscoveryError("describe-instances did not return a list")
    out: dict[str, str] = {}
    for rec in records:
        if not isinstance(rec, dict) or not rec.get("Id") or not rec.get("State"):
            raise DiscoveryError(f"malformed instance record: {rec!r}")
        out[rec["Id"]] = rec["State"]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-tag", required=True)
    ap.add_argument("--instance-id", default="")
    ap.add_argument("--attempts", type=int, default=60)
    ap.add_argument("--interval", type=float, default=15.0)
    args = ap.parse_args()

    expected = [args.instance_id] if args.instance_id else []

    if not expected:
        # The launch step may have created an instance whose ID we lost. A
        # discovery ERROR here is unresolved ownership and must fail the job:
        # the expiry sweeper is then the only thing left, and someone should
        # know that.
        print(f"no instance id recorded; sweeping tag polis:ci-run={args.run_tag}")
        try:
            found = describe(None, args.run_tag)
        except DiscoveryError as exc:
            print(f"::error::could not determine whether an instance was launched: {exc}")
            print("::error::ownership unresolved; the expiry sweeper must reap it")
            return 1
        if not found:
            print("discovery succeeded and found no instance for this run")
            return 0
        expected = sorted(found)
        print(f"discovered {expected}")

    print(f"terminating: {expected}")
    last_seen: dict[str, str] = {}
    for attempt in range(1, args.attempts + 1):
        try:
            aws("ec2", "terminate-instances", "--instance-ids", *expected)
        except DiscoveryError as exc:
            # Terminate can legitimately fail once the instance is already gone;
            # the confirmation below is the authority, not this call.
            print(f"terminate attempt {attempt} did not succeed: {exc}")

        try:
            last_seen = describe(expected, None)
        except DiscoveryError as exc:
            print(f"confirmation attempt {attempt} could not read state: {exc}")
            time.sleep(args.interval)
            continue

        missing = [i for i in expected if i not in last_seen]
        if missing:
            # Inside a ~15 minute window a real terminated instance is still
            # visible; a missing ID means it was never valid.
            print(f"::error::instance id(s) not present in describe output: {missing}")
            return 1

        states = {i: last_seen[i] for i in expected}
        print(f"attempt {attempt}: {states}")
        if all(s in DONE for s in states.values()):
            print("termination confirmed: every instance is `terminated`")
            return 0
        unexpected = {i: s for i, s in states.items()
                      if s not in DONE | IN_PROGRESS | ACTIVE}
        if unexpected:
            print(f"::error::unrecognised instance state(s): {unexpected}")
            return 1
        time.sleep(args.interval)

    print(f"::error::could not confirm termination of {expected}; last seen {last_seen}")
    print("::error::kill it by hand -- see docs/ci-ec2.md")
    return 1


if __name__ == "__main__":
    sys.exit(main())
