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

Round 3 closes two more ways of concluding absence too readily (review R2-F6):

  * blank stdout from a "successful" describe was parsed as an empty inventory.
    Blank output is not an empty answer; it is a malformed one.
  * a lost launch acknowledgement accepted the FIRST empty tag query. EC2
    describes are eventually consistent, so an instance that exists may not be
    visible yet. Discovery now retries through a propagation window, and
    ``--launch-attempted`` says whether there is anything to look for at all:
    if a launch was attempted and discovery never resolves it, that is
    unresolved ownership and a failure, not proof of absence.

  usage: p022_teardown.py --run-tag <run_id>-<attempt> [--instance-id i-...]
                          [--launch-attempted 0|1]
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
    # Blank output is a malformed answer, not an empty one. A "successful"
    # command that printed nothing tells us nothing about what exists.
    if not raw.strip():
        raise DiscoveryError("describe-instances returned blank output")
    try:
        records = json.loads(raw)
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
    ap.add_argument("--launch-attempted", default="1",
                    help="whether RunInstances was reached at all; default assumes yes")
    ap.add_argument("--attempts", type=int, default=60)
    ap.add_argument("--interval", type=float, default=15.0)
    ap.add_argument("--discovery-attempts", type=int, default=12,
                    help="reads across the EC2 describe propagation window")
    args = ap.parse_args()

    launch_attempted = args.launch_attempted.strip().lower() not in {"0", "false", "no", ""}
    expected = [args.instance_id] if args.instance_id else []

    if not expected:
        if not launch_attempted:
            # The job never reached RunInstances (a missing repository variable,
            # a failed checkout). There is nothing to reconcile.
            print("launch was never attempted; nothing to terminate")
            return 0
        # A launch WAS attempted and its ID was lost. EC2 describes are
        # eventually consistent, so one empty answer is not absence: retry
        # across the propagation window before concluding anything.
        print(f"no instance id recorded; sweeping tag polis:ci-run={args.run_tag}")
        found: dict[str, str] = {}
        last_error = None
        for probe in range(1, args.discovery_attempts + 1):
            try:
                found = describe(None, args.run_tag)
            except DiscoveryError as exc:
                last_error = exc
                print(f"discovery attempt {probe} failed: {exc}")
                found = {}
            else:
                if found:
                    break
                print(f"discovery attempt {probe}: nothing visible yet")
            time.sleep(args.interval)
        if not found:
            # Unresolved, never "proven absent": a launch was attempted and we
            # cannot say what it produced. The expiry sweeper is now the only
            # thing standing between this and a running instance, and someone
            # should know that.
            print("::error::a launch was attempted but its instance never became "
                  f"visible under polis:ci-run={args.run_tag}"
                  + (f" (last error: {last_error})" if last_error else ""))
            print("::error::ownership unresolved; the expiry sweeper must reap it")
            return 1
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
