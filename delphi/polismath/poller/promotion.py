"""The small poller's side of the large memory class (P-073 §4.4, §4.5, §7.3).

``SmallCapacityLoop.tick()`` runs on the parked-zid reconciler's cadence
(``MATH_POLLER_RECONCILE_INTERVAL_MS``, 60 s) in the small poller's primary,
and only with ``MATH_CAPACITY_ROUTING=1``. Each step is isolated: a failure is
logged by class and the next step still runs.

1. Restore (once, retried until the manifest store answers): routed records
   the state file does not hold are read back from the manifest, so a restart
   never forgets a routed conversation and never computes one.
2. Restage (``MATH_CAPACITY_RESTAGE=<nonce>``, once per nonce value): every
   ``large`` record gets an input mark of now, so the large worker rebuilds it
   and this loop promotes the result. The applied nonce is kept in the state
   file and the manifest.
3. Re-size on a binding change (a resized box, a recalibrated model, changed
   fractions or large budget): each routed record classified under another
   binding is sized again now, without waiting for new input. One that now
   fits the small class is un-routed and submitted as a REBUILD, so the small
   poller computes it at once.
4. The promotion pass: for every ``large`` record, the staged label's bundle
   and this poller's label's bundle are fingerprinted (no payload read). A
   complete staged bundle newer than the target is promoted when
   ``MATH_CAPACITY_PROMOTE=1`` (``PostgresClient.promote_bundle``: one
   transaction, compare-and-set, payloads stay in Postgres). A staged bundle
   that covers the record's newest input is ``pending_promotion`` while it is
   newer than the target, and resolves the record once the target carries it.
5. The manifest: written (conditional put) when its content changed.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, Optional

from polismath.poller.capacity import LARGE, MB, SMALL, CapacityRouter, CapacitySettings
from polismath.poller.capacity_manifest import (
    Entry,
    Manifest,
    ManifestConflict,
    ManifestError,
    ManifestStore,
    Writer,
    parse,
)

logger = logging.getLogger(__name__)

# Routed records re-sized per tick on a binding change (each is one size
# query); the rest wait for the next tick.
MAX_RESIZE_PER_TICK = 20


def _now_ms() -> int:
    return int(time.time() * 1000)


class SmallCapacityLoop:
    def __init__(self, service: Any, router: CapacityRouter, settings: CapacitySettings, *,
                 store: Optional[ManifestStore] = None, source_commit: Optional[str] = None,
                 run: Optional[str] = None, clock_ms: Callable[[], int] = _now_ms,
                 sizes_fn: Optional[Callable[[Any, int], Any]] = None) -> None:
        from polismath.poller.admission import read_conversation_sizes

        self._svc = service
        self._router = router
        self.settings = settings
        self._store = store
        self._source_commit = source_commit
        self._run = run
        self._clock = clock_ms
        self._sizes = sizes_fn or read_conversation_sizes
        self.label = service.config.math_env
        # Manifest state: whether it has been read since start (writing before
        # that could lose another process's view), its ETag, generation and
        # the content last written.
        self._restored = store is None
        self._foreign = False
        self._etag: Optional[str] = None
        self._generation = 0
        self._written: Optional[str] = None

    # -- the tick ---------------------------------------------------------- #
    def tick(self) -> None:
        for step in (self._restore, self._restage, self._resize_stale_bindings,
                     self._promotion_pass, self._flush_manifest):
            try:
                step()
            except Exception as exc:  # noqa: BLE001 - one step never stops the others
                logger.error("capacity: %s failed (%s)", step.__name__.lstrip("_"),
                             exc.__class__.__name__)

    # -- 1. restore ---------------------------------------------------------- #
    def _restore(self) -> None:
        if self._restored:
            return
        assert self._store is not None
        raw, etag = self._store.read()
        self._etag = etag
        self._restored = True
        if raw is None:
            logger.info("capacity: no manifest yet; this primary creates it")
            return
        try:
            manifest = parse(raw)
        except ManifestError as exc:
            # Overwritten by the next write (its ETag is known): the records
            # this process holds are the truth.
            logger.error("capacity: manifest unreadable (%s); it will be replaced", exc)
            return
        self._generation = manifest.generation
        if manifest.writer.label != self.label:
            self._foreign = True
            logger.error("capacity: the manifest belongs to label %r, not %r; this primary "
                         "will not write it (check MATH_CAPACITY_MANIFEST_URI)",
                         manifest.writer.label, self.label)
            return
        added = self._router.restore([e.as_dict() for e in manifest.entries],
                                     binding=manifest.writer.binding,
                                     sized_ms=manifest.written_ms)
        if manifest.restage is not None and self._router.restage_applied is None:
            # A nonce applied before a restart that lost the state file.
            self._router.restage_applied = manifest.restage
        # The next write happens only when this process's view differs.
        self._written = manifest.content_key()
        logger.info("capacity: manifest generation %d read; %d routed records restored",
                    manifest.generation, added)

    # -- 2. restage ---------------------------------------------------------- #
    def _restage(self) -> None:
        nonce = self.settings.restage
        if nonce is None or not self._restored or self._router.restage_applied == nonce:
            return
        # The mark is on the database clock: the staged bundle's write time
        # (math_main.modified, now_as_millis()) is compared with it.
        rows = self._svc._pg.query("SELECT now_as_millis() AS now")
        marked = self._router.apply_restage(nonce, mark_ms=int(rows[0]["now"]))
        if marked:
            logger.warning("capacity: restage nonce applied; %d large conversations marked "
                           "for a fresh large-class build and promotion", marked)

    # -- 3. re-size on a binding change --------------------------------------- #
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

    # -- 4. promotion ---------------------------------------------------------- #
    def _promotion_pass(self) -> None:
        from polismath.database.postgres import PromotionRefused, staged_newer

        records = [r for r in self._router.routed_records() if r.disposition == LARGE]
        if not records:
            return
        staged_label, own = self.settings.staged_label, self.label
        pg = self._svc._pg
        fps = pg.math_fingerprints([r.zid for r in records], [staged_label, own])
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

    # -- 5. the manifest --------------------------------------------------------- #
    def manifest(self) -> Manifest:
        s = self.settings
        writer = Writer(
            label=self.label, binding=self._router.binding(), run=self._run,
            source_commit=self._source_commit,
            small_capacity_bytes=self._router.small_capacity(),
            large_budget_bytes=None if s.large_budget_mb is None else int(s.large_budget_mb * MB))
        entries = tuple(
            Entry(zid=r.zid, need_bytes=r.need_bytes, votes=r.votes, voters=r.voters,
                  comments=r.comments, input_through_ms=r.input_through_ms,
                  first_unresolved_ms=r.first_unresolved_ms,
                  exceeds_largest=r.disposition != LARGE)
            for r in self._router.routed_records())
        return Manifest(generation=self._generation + 1, written_ms=self._clock(),
                        writer=writer, staged_label=s.staged_label, entries=entries,
                        restage=self._router.restage_applied)

    def _flush_manifest(self) -> None:
        if self._store is None or not self._restored or self._foreign:
            return
        manifest = self.manifest()
        content = manifest.content_key()
        if content == self._written:
            return
        try:
            self._etag = self._store.write(manifest.encode(), self._etag)
        except ManifestConflict:
            # Only this primary writes the manifest; a conflict means another
            # writer touched it. Re-read before the next write.
            logger.error("capacity: the manifest changed under this primary; re-reading it")
            self._restored = False
            return
        self._generation = manifest.generation
        self._written = content
        logger.info("capacity: manifest generation %d written (%d entries)",
                    manifest.generation, len(manifest.entries))

    def state(self) -> Dict[str, Any]:
        """For tests and debugging: never logged (no zids, no location)."""
        return {"restored": self._restored, "foreign": self._foreign,
                "generation": self._generation, "etag": self._etag}


__all__ = ["MAX_RESIZE_PER_TICK", "SmallCapacityLoop"]
