"""The small poller's side of the large memory class (P-073 §4.4, §4.5, §7.3; r2).

``SmallCapacityLoop.tick()`` runs on the parked-zid reconciler's cadence
(``MATH_POLLER_RECONCILE_INTERVAL_MS``, 60 s) in the small poller's primary,
and only with ``MATH_CAPACITY_ROUTING=1``. Each step is isolated: a failure is
logged by class and the next step still runs.

1. Restage (``MATH_CAPACITY_RESTAGE=<nonce>``, once per nonce value): every
   ``large`` record gets an input mark of now (the database clock), so the
   promotion pass below sees its staged bundle behind its input, enqueues a
   fresh rebuild and promotes the result. The applied nonce is kept in the
   state file.
2. Re-size on a binding change (a resized box, a recalibrated model, changed
   fractions or large budget): each routed record classified under another
   binding is sized again now, without waiting for new input. One that now
   fits the small class is un-routed and submitted as a REBUILD, so the small
   poller computes it at once.
3. The promotion pass: for every ``large`` record, the staged label's bundle
   and this poller's label's bundle are fingerprinted (no payload read). A
   complete staged bundle newer than the target is promoted when
   ``MATH_CAPACITY_PROMOTE=1`` (``PostgresClient.promote_bundle``: one
   transaction, compare-and-set, payloads stay in Postgres). A staged bundle
   that covers the record's newest input is ``pending_promotion`` while it is
   newer than the target, and resolves the record once the target carries it.
   A record whose staged bundle is missing, incomplete or behind its input
   is enqueued as a ``math_rebuild`` job of class ``large``
   (``polismath.poller.capacity_queue``; idempotent under the queue's
   one-active-job-per-scope guard, so an active job is simply found again).

The queue rows are the truth of the hand-off; the records here are a cache
of sizes and marks. Nothing is restored from the queue at start: a routed
conversation this process has no record of is sized again on its next cold
touch and enqueued again, which the guard makes idempotent.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, Optional

from polismath.poller.capacity import LARGE, SMALL, CapacityRouter, CapacitySettings
from polismath.poller.capacity_queue import enqueue_routed

logger = logging.getLogger(__name__)

# Routed records re-sized per tick on a binding change (each is one size
# query); the rest wait for the next tick.
MAX_RESIZE_PER_TICK = 20
# Jobs asked for per tick (each is one short queue transaction).
MAX_ENQUEUE_PER_TICK = 20


def _now_ms() -> int:
    return int(time.time() * 1000)


class SmallCapacityLoop:
    def __init__(self, service: Any, router: CapacityRouter, settings: CapacitySettings, *,
                 queue: Any = None, source_commit: Optional[str] = None,
                 run: Optional[str] = None, clock_ms: Callable[[], int] = _now_ms,
                 sizes_fn: Optional[Callable[[Any, int], Any]] = None) -> None:
        from polismath.poller.admission import read_conversation_sizes

        self._svc = service
        self._router = router
        self.settings = settings
        self._queue = queue
        self._source_commit = source_commit
        self._run = run
        self._clock = clock_ms
        self._sizes = sizes_fn or read_conversation_sizes
        self.label = service.config.math_env
        self.enqueued_total = 0

    # -- the tick ---------------------------------------------------------- #
    def tick(self) -> None:
        for step in (self._restage, self._resize_stale_bindings, self._promotion_pass):
            try:
                step()
            except Exception as exc:  # noqa: BLE001 - one step never stops the others
                logger.error("capacity: %s failed (%s)", step.__name__.lstrip("_"),
                             exc.__class__.__name__)

    # -- 1. restage ---------------------------------------------------------- #
    def _restage(self) -> None:
        nonce = self.settings.restage
        if nonce is None or self._router.restage_applied == nonce:
            return
        # The mark is on the database clock: the staged bundle's write time
        # (math_main.modified, now_as_millis()) is compared with it.
        rows = self._svc._pg.query("SELECT now_as_millis() AS now")
        marked = self._router.apply_restage(nonce, mark_ms=int(rows[0]["now"]))
        if marked:
            logger.warning("capacity: restage nonce applied; %d large conversations marked "
                           "for a fresh large-class build and promotion", marked)

    # -- 2. re-size on a binding change --------------------------------------- #
    def _resize_stale_bindings(self) -> None:
        pool = getattr(self._svc, "_pool", None)
        for zid in self._router.stale_binding_zids()[:MAX_RESIZE_PER_TICK]:
            if pool is not None and pool.is_pending(zid):
                continue
            sizes = self._sizes(self._svc._pg, zid)
            disposition = self._router.observe(zid, sizes=sizes, advance=False)
            if disposition == SMALL:
                logger.info("capacity: zid=%s fits the small class under the new binding; "
                            "rebuilding it here", zid)
                self._svc.submit_rebuild(zid)

    # -- 3. promotion, and the jobs ------------------------------------------- #
    def _promotion_pass(self) -> None:
        from polismath.database.postgres import PromotionRefused, staged_newer

        records = [r for r in self._router.routed_records() if r.disposition == LARGE]
        if not records:
            return
        # Records that have never been given a job first, so a page of
        # re-asks for active jobs never starves new demand.
        records.sort(key=lambda r: (r.job_id is not None, r.zid))
        staged_label, own = self.settings.staged_label, self.label
        pg = self._svc._pg
        fps = pg.math_fingerprints([r.zid for r in records], [staged_label, own])
        asked = 0
        for rec in records:
            staged = fps.get((rec.zid, staged_label))
            target = fps.get((rec.zid, own))
            usable = staged is not None and staged.complete
            if self._router.disposition(rec.zid) != LARGE:
                # Un-routed (or re-classified) by a pool thread since this
                # pass took its snapshot: the small poller owns the
                # conversation again, so its staged bundle is left alone.
                logger.info("capacity: zid=%s no longer routed; staged bundle not promoted",
                            rec.zid)
                continue
            if usable and self.settings.promote and staged_newer(staged, target):
                try:
                    pg.promote_bundle(rec.zid, from_env=staged_label, to_env=own,
                                      expected_target=target, expected_staged=staged)
                except PromotionRefused as exc:
                    logger.info("capacity: promotion of zid=%s refused (%s); retried next "
                                "pass", rec.zid, exc.reason)
                except Exception as exc:  # noqa: BLE001 - the next pass retries
                    logger.error("capacity: promotion of zid=%s failed (%s)", rec.zid,
                                 exc.__class__.__name__)
                else:
                    self._router.note_promoted()
                    target = pg.math_fingerprints([rec.zid], [own]).get((rec.zid, own))
            covers = usable and (rec.input_through_ms is None
                                 or staged.modified >= rec.input_through_ms)
            newer = usable and staged_newer(staged, target)
            self._router.settle(rec.zid, waiting=bool(covers and newer),
                                resolved=bool(covers and not newer and target is not None),
                                through_ms=rec.input_through_ms)
            if not covers and asked < MAX_ENQUEUE_PER_TICK:
                # Nothing staged for its newest input: ask the queue (an
                # active job for the scope is found, not duplicated).
                asked += 1
                self._enqueue(rec.zid)

    def _enqueue(self, zid: int) -> Optional[str]:
        """Contained: a queue failure never stops the pass."""
        if self._queue is None:
            return None
        try:
            job_id = enqueue_routed(self._queue, self._router, zid,
                                    staged_label=self.settings.staged_label,
                                    target_label=self.label, source_commit=self._source_commit)
        except Exception as exc:  # noqa: BLE001 - retried next pass
            logger.error("capacity: enqueue of zid=%s failed (%s)", zid, exc.__class__.__name__)
            return None
        if job_id is not None:
            self.enqueued_total += 1
        return job_id

    def state(self) -> Dict[str, Any]:
        """For tests and debugging: never logged (no zids)."""
        return {"queue": self._queue is not None, "enqueued_total": self.enqueued_total}


__all__ = ["MAX_ENQUEUE_PER_TICK", "MAX_RESIZE_PER_TICK", "SmallCapacityLoop"]
