"""The large memory class worker (P-073 §4.3; role ``math-large``).

Same image and entrypoint as the small poller, run with
``MATH_CAPACITY_CLASS=large`` and its own label (``MATH_ENV=python-large``,
the staged label). It holds that label's single-writer lock (key
``polis-math-python:python-large``) and publishes ordinary three-table bundles
under it with the ordinary writer. It never writes the small poller's label:
the small poller promotes staged bundles itself (``polismath.poller.promotion``).

It computes only the conversations the small poller routed to it. Each
readiness interval ``LargeClassDriver.tick()`` reads the capacity manifest
(conditionally) and:

* refuses to compute anything (an empty allowlist, a closed ``refusal`` label
  on its capacity line) when the manifest is missing or unreadable, when it
  was written for another label pair (``label``), when the small poller runs
  another source commit (``skew``: the version-skew guard; a large box booted
  from a newer checkout than the small one waits for the deploy), or when the
  manifest declares a large budget this worker's own memory budget cannot
  hold (``budget``);
* otherwise sets the service's dynamic allowlist to the manifest's
  conversations that fit its own compute capacity (``exceeds_largest`` and
  oversized entries are never attempted; the latter count as ``unfit``), so
  the ordinary vote and moderation loops update them warm while the box is up;
* submits a REBUILD (cold first touch: full history) for an allowlisted
  conversation whose staged bundle is missing, incomplete or older than its
  newest input, when it is not cached, when the restage nonce changed, or
  when its input is older than the grace (a safety net for input the loops
  missed);
* drops cached conversations that left the manifest; a refusal drops the
  whole cache, because the loops drop the batches of every conversation the
  allowlist excludes (the next computation is a cold full-history rebuild).

Every large computation is an exclusive reservation against the worker's own
budget. Its readiness lines carry a class token before the line kind
(``math_poller class=large readiness/1 role=...``), so no large line contains
the P-072 heartbeat, discovery-stale or alert-test phrases.

Startup refusals (``check_large_startup``; ``scripts/math_poller.py`` exits 2
before touching the database): a manifest URI is required; the label must
differ from the promotion target and from every served label (``prod``,
``python``, and the caller's served label) and equal the staged
label; the backfill, routing, promotion and restage settings belong to the
small poller; sharding is refused; and a declared
``MATH_CAPACITY_LARGE_BUDGET_MB`` above this worker's own budget (the class
does not fit) is refused once the memory admission is known.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional

from polismath.poller.capacity import MB, CapacitySettings
from polismath.poller.capacity_manifest import (
    NOT_MODIFIED,
    Manifest,
    ManifestError,
    ManifestStore,
    parse,
)

logger = logging.getLogger(__name__)

# A staged bundle behind its input is rebuilt even while cached once the
# input is this old, in readiness intervals (the loops normally deliver it
# within a poll).
GRACE_INTERVALS = 2


# The labels a deployment serves: the retired engine's frozen rows (`prod`)
# and the Python engine's (`python`). What the readers serve is their MATH_ENV,
# not a setting of this process, so both are refused by name: the large class
# never writes a label anything reads directly.
SERVED_LABELS = frozenset({"prod", "python"})


class LargeStartupError(ValueError):
    """The large worker is misconfigured; it must not start."""


def check_large_startup(settings: CapacitySettings, math_env: str, *,
                        served_env: str, env: Mapping[str, str], shard_count: int = 1) -> None:
    """The static refusals, before any connection. Raises LargeStartupError."""
    label = (math_env or "").strip()
    if not settings.manifest_uri:
        raise LargeStartupError("MATH_CAPACITY_MANIFEST_URI is required for the large class")
    if not settings.promote_into:
        raise LargeStartupError("MATH_CAPACITY_PROMOTE_INTO (the small poller's label) is "
                                "required for the large class")
    if label == settings.promote_into:
        raise LargeStartupError("MATH_ENV equals MATH_CAPACITY_PROMOTE_INTO: the large class "
                                "never writes the small poller's label")
    if (label == served_env or label in SERVED_LABELS
            or (env.get("MATH_POLLER_ALLOW_SERVED_ENV") or "").strip() == "1"):
        raise LargeStartupError("the large class never writes the served label")
    if label != settings.staged_label:
        raise LargeStartupError("MATH_ENV must equal MATH_CAPACITY_STAGED_LABEL "
                                f"({settings.staged_label!r}) for the large class")
    if (env.get("MATH_BACKFILL") or "").strip() == "1":
        raise LargeStartupError("MATH_BACKFILL=1 is refused for the large class")
    if settings.routing or settings.promote or settings.restage:
        raise LargeStartupError("MATH_CAPACITY_ROUTING, MATH_CAPACITY_PROMOTE and "
                                "MATH_CAPACITY_RESTAGE belong to the small poller")
    if shard_count > 1:
        raise LargeStartupError("sharding is refused for the large class")


def check_large_budget(settings: CapacitySettings, admission: Any) -> None:
    """The class must fit: a declared large budget above this worker's own
    memory budget would let the small poller route conversations here that
    can never be computed. Raises LargeStartupError."""
    if not admission.limited:
        raise LargeStartupError("the large class needs a known memory limit")
    if (settings.large_budget_mb is not None
            and admission.budget_bytes < int(settings.large_budget_mb * MB)):
        raise LargeStartupError(
            f"MATH_CAPACITY_LARGE_BUDGET_MB={settings.large_budget_mb:g} exceeds this worker's "
            f"memory budget ({admission.budget_bytes / MB:.0f} MiB): the class does not fit")


def _now_ms() -> int:
    return int(time.time() * 1000)


class LargeClassDriver:
    """Feeds the manifest's conversations into the ordinary pool; nothing
    else is ever computed."""

    def __init__(self, service: Any, settings: CapacitySettings, store: ManifestStore, *,
                 source_commit: Optional[str], interval_s: float = 60.0,
                 clock_ms: Callable[[], int] = _now_ms) -> None:
        self._svc = service
        self.settings = settings
        self._store = store
        self._source_commit = source_commit
        self._interval_s = float(interval_s)
        self._grace_ms = int(GRACE_INTERVALS * interval_s * 1000)
        self._clock = clock_ms
        self.label = service.config.math_env
        self._etag: Optional[str] = None
        self._manifest: Optional[Manifest] = None
        self._last_restage: Optional[str] = None
        self._lock = threading.Lock()
        self._counts: Dict[str, Any] = {"busy": 0, "queued": 0, "skew": 0, "allowlisted": 0,
                                        "unfit": 0, "refusal": "manifest_missing"}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- the evidence ------------------------------------------------------- #
    def counts(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._counts)

    def _set_counts(self, **counts: Any) -> None:
        base = {"busy": 0, "queued": 0, "skew": 0, "allowlisted": 0, "unfit": 0,
                "refusal": None}
        base.update(counts)
        with self._lock:
            self._counts = base

    # -- the tick ------------------------------------------------------------ #
    def _read(self) -> Optional[Manifest]:
        """The current manifest, None when there is none. Raises on a store
        failure (the tick keeps the previous state) and ManifestError on a
        malformed object."""
        res = self._store.read(self._etag)
        if res is NOT_MODIFIED:
            return self._manifest
        raw, etag = res
        if raw is None:
            self._etag, self._manifest = None, None
            return None
        manifest = parse(raw)
        self._etag, self._manifest = etag, manifest
        return manifest

    def _refuse(self, reason: str, **extra: Any) -> None:
        """Compute nothing. The cache goes too: while the allowlist is empty
        the poll loops drop these conversations' batches (and advance past
        them), so a cached entry kept across the refusal would later take a
        warm update missing those votes. Every conversation's next
        computation after a refusal is a cold full-history rebuild."""
        self._svc.set_dynamic_allowlist(frozenset())
        self._drop_cache()
        self._set_counts(refusal=reason, skew=1 if reason == "skew" else 0, **extra)

    def _drop_cache(self, keep: frozenset = frozenset()) -> None:
        for zid in self._svc.cached_zids() - keep:
            self._svc.cache_drop(zid)
            logger.info("capacity: zid=%s dropped from the large-class cache", zid)

    def tick(self) -> None:
        try:
            manifest = self._read()
        except ManifestError as exc:
            self._etag, self._manifest = None, None
            logger.error("capacity: manifest unreadable (%s); computing nothing", exc)
            self._refuse("manifest_unreadable")
            return
        except Exception as exc:  # noqa: BLE001 - a store blip keeps the last state
            logger.error("capacity: manifest read failed (%s); keeping the last allowlist",
                         exc.__class__.__name__)
            return
        if manifest is None:
            self._refuse("manifest_missing")
            return
        w = manifest.writer
        if w.label != self.settings.promote_into or manifest.staged_label != self.label:
            logger.error("capacity: the manifest is for %r -> %r, not %r -> %r; computing nothing",
                         manifest.staged_label, w.label, self.label, self.settings.promote_into)
            self._refuse("label")
            return
        if w.source_commit != self._source_commit:
            logger.warning("capacity: version skew (small poller at %s, this worker at %s); "
                           "computing nothing until they match",
                           (w.source_commit or "unknown")[:12],
                           (self._source_commit or "unknown")[:12])
            self._refuse("skew")
            return
        adm = self._svc.admission
        if w.large_budget_bytes is not None and adm.budget_bytes < w.large_budget_bytes:
            logger.error("capacity: the small poller sizes the large class at %.0f MiB; this "
                         "worker's budget is %.0f MiB; computing nothing",
                         w.large_budget_bytes / MB, adm.budget_bytes / MB)
            self._refuse("budget")
            return
        self._drive(manifest)

    def _drive(self, manifest: Manifest) -> None:
        svc = self._svc
        capacity = svc.admission.compute_capacity_bytes()
        entries = [e for e in manifest.entries if not e.exceeds_largest]
        fit = [e for e in entries if capacity is None or e.need_bytes <= capacity]
        allow = frozenset(e.zid for e in fit)
        svc.set_dynamic_allowlist(allow)
        restage_changed = manifest.restage != self._last_restage
        self._last_restage = manifest.restage
        fps = svc._pg.math_fingerprints(sorted(allow), [self.label]) if allow else {}
        now = self._clock()
        stale: List[int] = []
        for e in fit:
            fp = fps.get((e.zid, self.label))
            behind = (fp is None or not fp.complete
                      or (e.input_through_ms is not None and fp.modified < e.input_through_ms))
            if not behind:
                continue
            stale.append(e.zid)
            if svc.is_pending(e.zid):
                continue
            old_input = e.input_through_ms is None or now - e.input_through_ms > self._grace_ms
            if not svc.is_cached(e.zid) or restage_changed or old_input:
                svc.submit_rebuild(e.zid)
        # Conversations that left the class: their batches are filtered out
        # from now on, so their cache entries must not survive.
        self._drop_cache(keep=allow)
        pending = svc.pending_zids() & allow
        self._set_counts(busy=len(pending | set(stale)), queued=len(stale),
                         allowlisted=len(allow), unfit=len(entries) - len(fit))

    # -- thread --------------------------------------------------------------- #
    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="large-class", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while True:
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001 - the driver never dies quietly
                logger.error("capacity: large-class tick failed (%s)", exc.__class__.__name__)
            if self._stop.wait(self._interval_s):
                return


__all__ = ["GRACE_INTERVALS", "LargeClassDriver", "LargeStartupError", "check_large_budget",
           "check_large_startup"]
