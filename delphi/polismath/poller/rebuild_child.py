"""The large memory class as a queue child (P-073 r2): ``scripts/math_poller.py --job``.

The large box runs the ``polis-jobs`` daemon as a worker of class ``large``.
For each ``math_rebuild`` job it claims, the daemon starts this entry as a
child under its contract (``polismath.job_child``: the attempt's identity in
the environment, the frame at ``DELPHI_FRAME``, the output manifest at
``DELPHI_OUTPUT_MANIFEST``). The child:

* binds to the frame: the stage is ``math_rebuild``; the frame's zid is the
  one conversation it computes; the frame's ``config`` is the typed math
  config the daemon carried whole from the admission (``MathConfig``: exactly
  ``staged_label``, ``target_label``, ``need_bytes``, ``input_through_ms``,
  ``binding``, ``source_commit``, each of its type), and every key is checked
  before anything runs: ``staged_label`` and ``inputs.math_env`` must equal
  this process's ``MATH_ENV``; ``target_label`` is never written here; a
  ``source_commit`` that differs from this checkout's (or is missing) is
  refused (exit 2, the version-skew guard: the attempt fails and the job
  waits for the deploy); ``need_bytes`` above this worker's capacity is a
  failed attempt (exit 1);
* refuses (exit 2, before any connection) a label that is served (``prod``,
  ``python``), empty, or the small poller's target label; the small poller's
  settings (routing, promotion, the restage nonce, the backfill) in its
  environment; and a declared ``MATH_CAPACITY_LARGE_BUDGET_MB`` above its own
  memory budget (the class does not fit);
* takes the staged label's single-writer lock once (another writer holding
  it is a failed attempt, exit 1, retried by the daemon), then runs one cold
  full-history rebuild under an exclusive reservation against its own budget
  and publishes the ordinary three-table bundle under the staged label with
  the ordinary writer, exactly as the large-class worker did; it never
  writes the small poller's label;
* writes the output manifest as its last act: ``inputs.math_env`` the label,
  ``inputs.math_tick`` and ``inputs.vote_hwm`` the staged bundle's
  fingerprint (its tick and newest vote), no stores written outside
  Postgres (``outputs`` empty).

It starts no readiness reporter and prints no readiness line, so nothing it
logs can contain the heartbeat, discovery-stale or alert-test phrases the
P-072 filters match.

Exit codes (``polismath.job_child``): 0 success with a manifest; 1 the
rebuild failed (does not fit, another writer, an engine error); 2 the
environment, frame or label was refused before anything ran; 5 the bundle
published but the manifest could not be built.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Tuple

from polismath.job_child import (
    EXIT_JOB_ENV_INVALID,
    EXIT_MANIFEST_UNBUILDABLE,
    EXIT_OK,
    EXIT_STAGE_FAILED,
    JobContext,
    JobEnvError,
    ManifestError,
    build_manifest,
    write_manifest,
)
from polismath.poller.capacity import (
    LARGE_BUDGET_ENV,
    MB,
    PROMOTE_ENV,
    RESTAGE_ENV,
    ROUTING_ENV,
    CapacitySettings,
)
from polismath.poller.capacity_queue import STAGE_MATH_REBUILD

logger = logging.getLogger(__name__)

# The labels a deployment serves: the retired engine's frozen rows (`prod`)
# and the Python engine's (`python`). What the readers serve is their
# MATH_ENV, not a setting of this process, so both are refused by name: the
# child never writes a label anything reads directly.
SERVED_LABELS = frozenset({"prod", "python"})


class ChildRefused(ValueError):
    """The child must not run: a label, setting or frame it cannot accept."""


MATH_CONFIG_KEYS = ("staged_label", "target_label", "need_bytes", "input_through_ms", "binding",
                    "source_commit")
_LABEL = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_COMMIT = re.compile(r"[0-9a-f]{7,64}")


@dataclass(frozen=True)
class MathConfig:
    """The typed math config of a rebuild's frame (queue-rs ``child.rs``
    ``MathConfig``): what the small poller admitted the job with."""

    staged_label: str
    target_label: str
    need_bytes: int
    input_through_ms: Optional[int]
    binding: str
    source_commit: str


def check_math_config(frame_config: Any, *, label: str, input_label: Any) -> MathConfig:
    """Every key of the typed config, present and of its type; the staged
    label is this process's label and the frame's input label. Raises
    ChildRefused before anything runs."""
    if not isinstance(frame_config, dict) or set(frame_config) != set(MATH_CONFIG_KEYS):
        raise ChildRefused("frame config is not the typed math config "
                           f"(keys {sorted(MATH_CONFIG_KEYS)})")
    staged, target = frame_config["staged_label"], frame_config["target_label"]
    for name, value in (("staged_label", staged), ("target_label", target)):
        if not isinstance(value, str) or _LABEL.fullmatch(value) is None:
            raise ChildRefused(f"frame config {name} is not a label")
    if staged == target:
        raise ChildRefused("frame config staged_label equals target_label")
    if staged != label:
        raise ChildRefused(f"frame config staged_label {staged!r} is not this process's "
                           f"MATH_ENV {label!r}")
    if input_label != label:
        raise ChildRefused(f"frame inputs.math_env {input_label!r} is not this process's "
                           f"MATH_ENV {label!r}")
    need = frame_config["need_bytes"]
    if type(need) is not int or need <= 0:
        raise ChildRefused("frame config need_bytes is not a positive integer")
    through = frame_config["input_through_ms"]
    if through is not None and (type(through) is not int or through < 0):
        raise ChildRefused("frame config input_through_ms is not an integer or null")
    binding = frame_config["binding"]
    if not isinstance(binding, str) or not binding or len(binding) > 128:
        raise ChildRefused("frame config binding is not a non-empty string")
    commit = frame_config["source_commit"]
    if not isinstance(commit, str) or _COMMIT.fullmatch(commit) is None:
        raise ChildRefused("frame config source_commit is not a commit")
    return MathConfig(staged_label=staged, target_label=target, need_bytes=need,
                      input_through_ms=through, binding=binding, source_commit=commit)


def _say(message: str) -> None:
    print(f"polis-jobs child: {message}", file=sys.stderr, flush=True)


def check_child_label(label: str, *, served_env: str, target_label: Optional[str],
                      env: Mapping[str, str]) -> None:
    """The static refusals, before any connection. Raises ChildRefused."""
    label = (label or "").strip()
    if not label:
        raise ChildRefused("MATH_ENV is empty")
    if (label == served_env or label in SERVED_LABELS
            or (env.get("MATH_POLLER_ALLOW_SERVED_ENV") or "").strip() == "1"):
        raise ChildRefused("the large class never writes the served label")
    if target_label is not None and label == target_label:
        raise ChildRefused("MATH_ENV equals the job's target label: the large class never "
                           "writes the small poller's label")
    if (env.get("MATH_BACKFILL") or "").strip() == "1":
        raise ChildRefused("MATH_BACKFILL=1 is refused for the large class")
    for name in (ROUTING_ENV, PROMOTE_ENV, RESTAGE_ENV):
        if (env.get(name) or "").strip() not in ("", "0"):
            raise ChildRefused(f"{name} belongs to the small poller")


def check_large_budget(settings: CapacitySettings, admission: Any) -> None:
    """The class must fit: a declared large budget above this worker's own
    memory budget would let the small poller route conversations here that
    can never be computed. Raises ChildRefused."""
    if not admission.limited:
        raise ChildRefused("the large class needs a known memory limit")
    if (settings.large_budget_mb is not None
            and admission.budget_bytes < int(settings.large_budget_mb * MB)):
        raise ChildRefused(
            f"{LARGE_BUDGET_ENV}={settings.large_budget_mb:g} exceeds this worker's "
            f"memory budget ({admission.budget_bytes / MB:.0f} MiB): the class does not fit")


def check_skew(frame_config: Mapping[str, Any], source_commit: Optional[str]) -> None:
    """The version-skew guard: a frame admitted by a small poller on another
    source commit is refused, and so is one without a commit (the daemon
    carries the typed config whole, so a missing key is a broken frame, not
    an older daemon): a set and an unset commit are skew too."""
    theirs = frame_config.get("source_commit")
    if not isinstance(theirs, str) or not theirs:
        raise ChildRefused("the frame carries no source_commit; refusing to compute under an "
                           "unchecked version")
    if theirs != source_commit:
        raise ChildRefused(
            f"version skew: the job was admitted at {theirs[:12]}, this worker "
            f"runs {(source_commit or 'unknown')[:12]}; waiting for the deploy")


def _frame_zid(frame: Mapping[str, Any]) -> int:
    zid = frame.get("zid")
    if type(zid) is not int or zid <= 0:
        raise JobEnvError("frame zid is not a positive integer")
    return zid


def run(job_arg: Optional[str], *, label: str, environ: Optional[Mapping[str, str]] = None,
        source_commit: Optional[str], admission_fn: Callable[[], Any],
        build_fn: Callable[[Any], Tuple[Any, Any]], lock_fn: Callable[[], Any],
        served_env: str = "prod", settings: Optional[CapacitySettings] = None) -> int:
    """The child, start to finish. ``admission_fn`` gives the memory admission
    (it may exit 2 itself), ``build_fn(admission)`` the ``(service, pg)``
    pair under ``label`` and ``lock_fn()`` the held single-writer lock (it
    may exit 1). Returns the exit code."""
    environ = os.environ if environ is None else environ
    try:
        ctx = JobContext.from_env(expected_stage=STAGE_MATH_REBUILD, zid=None,
                                  allowed_phases={"run"}, default_phase="run", environ=environ)
        if job_arg and job_arg != ctx.job_id:
            raise JobEnvError("--job names a different job than DELPHI_JOB_ID")
        zid = _frame_zid(ctx.frame)
    except JobEnvError as exc:
        _say(f"refused: {exc}")
        return EXIT_JOB_ENV_INVALID
    inputs = ctx.frame.get("inputs")
    try:
        config = check_math_config(ctx.frame.get("config"), label=label,
                                   input_label=inputs.get("math_env")
                                   if isinstance(inputs, dict) else None)
        check_skew({"source_commit": config.source_commit}, source_commit)
        check_child_label(label, served_env=served_env, target_label=config.target_label,
                          env=environ)
        settings = settings if settings is not None else CapacitySettings.from_env(environ)
    except (ChildRefused, ValueError) as exc:
        _say(f"refused: {exc}")
        return EXIT_JOB_ENV_INVALID
    adm = admission_fn()
    try:
        check_large_budget(settings, adm)
    except ChildRefused as exc:
        _say(f"refused: {exc}")
        return EXIT_JOB_ENV_INVALID
    need = config.need_bytes
    capacity = adm.compute_capacity_bytes()
    if capacity is not None and need > capacity:
        _say(f"rebuild of zid={zid} does not fit: needs {need / MB:.0f} MiB above the base, "
             f"this worker can give {capacity / MB:.0f} MiB")
        return EXIT_STAGE_FAILED
    _say(f"frame checked: zid={zid} staged={config.staged_label} target={config.target_label} "
         f"need={need / MB:.0f}MiB input_through_ms={config.input_through_ms} "
         f"binding={config.binding} source_commit={config.source_commit[:12]}")
    lock = lock_fn()  # noqa: F841 - held (and referenced) until the process exits
    service, pg = build_fn(adm)
    _say(f"rebuilding zid={zid} under label={label} job={ctx.job_id[:8]}")
    try:
        service.rebuild_one(zid)
    except Exception as exc:  # noqa: BLE001 - the daemon records the attempt
        _say(f"rebuild of zid={zid} failed ({exc.__class__.__name__}): {exc}")
        return EXIT_STAGE_FAILED
    fp = pg.math_fingerprints([zid], [label]).get((zid, label))
    if fp is None or not fp.complete:
        _say(f"zid={zid} published but its bundle under {label} is not complete")
        return EXIT_MANIFEST_UNBUILDABLE
    try:
        manifest = build_manifest(
            ctx, outcome="succeeded",
            inputs={"math_env": label, "math_tick": fp.math_tick, "math_caching_tick": None,
                    "comment_set_sha256": None, "vote_hwm": fp.lvt},
            outputs=[], models={"embed": None, "topic": None, "narrative": None},
            cost={"llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": None})
        write_manifest(ctx, manifest)
    except (ManifestError, OSError) as exc:
        _say(f"manifest not written ({exc.__class__.__name__}): {exc}")
        return EXIT_MANIFEST_UNBUILDABLE
    _say(f"staged zid={zid} under {label}: tick={fp.math_tick} newest_vote={fp.lvt} "
         f"modified={fp.modified}")
    return EXIT_OK


__all__ = ["MATH_CONFIG_KEYS", "SERVED_LABELS", "ChildRefused", "MathConfig",
           "check_child_label", "check_large_budget", "check_math_config", "check_skew", "run"]
