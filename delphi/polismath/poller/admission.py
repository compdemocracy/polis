"""Shared memory admission for the math poller (P-070 review R1; burndown 3'.c.3).

Every computation in the poller process reserves memory here BEFORE it loads
anything: a live first touch or rebuild, a live incremental update, and a
background backfill rebuild. The same accountant also carries the retained
size of every conversation in the live cache, so the cache is bounded in
bytes, not only in count.

Budget. The container's memory limit, read from the cgroup
(``/sys/fs/cgroup/memory.max``, then cgroup v1 ``memory.limit_in_bytes``),
else ``MATH_POLLER_MEMORY_LIMIT_MB``; the poller refuses to start when neither
is known (scripts/math_poller.py). The budget is that limit minus a headroom
fraction (``MATH_POLLER_MEMORY_HEADROOM``, default 0.15). A reservation fits
when (P-073 §2.2)

    max(accounted resident, measured RSS) + every granted reservation
        + this one <= budget,

where accounted resident = process base + retained cache, and measured RSS
is read at each decision (one /proc read) when the accountant has an RSS
reader (``from_config`` gives it one). A low sample never lowers anything:
the measured figure only ever adds to the accounted one. The process base is
the measured quiescent baseline: max(model base, RSS minus the retained
cache charge), sampled at startup and again by ``refresh_baseline`` whenever
nothing is granted or held (the readiness tick calls it). The impossible-fit
test and ``compute_capacity_bytes`` use that baseline.

Estimates (02-findings/python-engine-memory-scaling.md, local measurement,
recalibrated by P-073 §2.1 against every recorded production attempt):
  * compute peak above the process base = max(job floor, safety x (133 MiB
    per million voter x comment cells + 1,000 B per fetched vote row)), job
    floor 64 MiB. The previous model was 116 MiB/Mcell (the local 30k x 1000
    measurement at 5.5% density) and 413 B/row (the measured ~650 MiB for
    the fetched rows and reformatted vote list of 1.65M votes). Against the
    21 recorded production attempts of the two backfill gate windows:
    a vote-dense conversation (33,422 voters x 791 comments, 2,014,024 rows)
    used 1.22x its reservation, which needs >= 958 B/row; a cell-dense one
    (3,137 x 1,797, 123,506 rows) used 1.06x even at 1,000 B/row, and the
    dense temporaries scale with cells, so the per-cell term is the one
    raised: 133 is the smallest whole MiB leaving every attempt at <= 0.95
    of its reservation. The floor covers small-job jitter (a 1,071 x 182
    conversation used 34.8 MiB against 30.0 reserved) without inflating
    large jobs.
  * retained by a cached conversation = safety x (40 MiB + max(30 MiB per
    million cells, 27 KiB per voter)), an upper bound on every measured
    retained point (33 MiB at 1k x 300 up to 1,320 MiB at 60k x 1000).

Waiting rule. Live work waits (first in, first out) until its reservation
fits; background work never waits (the backfill defers and records it). A
reservation that cannot fit even with every other reservation released and
the evictable cache empty is refused (``OverBudget``) rather than left to
wait forever. Cold cache entries (least recently used, not held by a running
computation) are evicted to make room. An exclusive reservation (a large
backfill job) runs with nothing else granted beside it, and nothing else is
granted while it runs.

Reservations are only ever taken on the thread that then computes, never at
queue time, so a waiter only ever waits for running work to finish.

Held objects (review [1447] A). A worker that takes a cached conversation for
an incremental update HOLDS it (``hold``) from the cache lookup, atomically
under the service's cache lock, until its computation ends (``unhold``), and
through any wait for admission in between. The cache policy may still evict a
held entry, but its charge is kept (``drop_retained`` detaches it) until the
last holder releases, and admission never evicts a held entry (that would
free nothing). Memory a worker still references is therefore always counted.
"""

from __future__ import annotations

import itertools
import logging
import os
import resource
import sys
import threading
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

MB = 1024 * 1024
KB = 1024
# A re-measured baseline is logged when it moves at least this much.
BASELINE_LOG_STEP = 16 * MB

# Uses votes_zid_pid_idx and comments_zid_idx (by zid, never by created).
SIZES_SQL = """
    SELECT
        (SELECT count(*) FROM votes WHERE zid = :zid) AS votes,
        (SELECT count(DISTINCT pid) FROM votes WHERE zid = :zid) AS voters,
        (SELECT count(*) FROM comments WHERE zid = :zid) AS comments
"""


class OverBudget(RuntimeError):
    """This computation cannot fit under the process memory budget. Carries
    the bytes it asked for and the most a computation could have had."""

    def __init__(self, message: str, *, need_bytes: Optional[int] = None,
                 capacity_bytes: Optional[int] = None) -> None:
        super().__init__(message)
        self.need_bytes = need_bytes
        self.capacity_bytes = capacity_bytes


class AdmissionStopped(RuntimeError):
    """The poller is stopping; a waiting reservation gives up."""


# --------------------------------------------------------------------------- #
# Process and container readings
# --------------------------------------------------------------------------- #
def read_rss_bytes() -> int:
    """Current resident set size of this process. Linux reads /proc; elsewhere
    the lifetime peak from getrusage is the best available stand-in."""
    try:
        with open("/proc/self/statm") as fh:
            return int(fh.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(peak if sys.platform == "darwin" else peak * 1024)


CGROUP_PATHS = ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes")


def read_cgroup_limit_bytes(paths: Tuple[str, ...] = CGROUP_PATHS) -> Optional[int]:
    """The container's memory limit (cgroup v2, then v1), or None when there
    is no limit file or it says unlimited."""
    for path in paths:
        try:
            with open(path) as fh:
                raw = fh.read().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            value = int(raw)
        except ValueError:
            continue
        if 0 < value < (1 << 60):
            return value
    return None


def conversation_dims(conv: Any) -> Tuple[int, int]:
    """(voters, comments) of a computed conversation, from its rating matrix."""
    try:
        shape = conv.raw_rating_mat.shape
        if len(shape) == 2:
            return int(shape[0]), int(shape[1])
    except Exception:  # noqa: BLE001 - any stand-in without a matrix
        pass
    try:
        return int(conv.participant_count or 0), int(conv.comment_count or 0)
    except Exception:  # noqa: BLE001
        return 0, 0


def read_conversation_sizes(pg: Any, zid: int, timeout_ms: int = 30000) -> Tuple[int, int, int]:
    """(vote rows, distinct voters, comments) for one conversation, by zid."""
    from sqlalchemy import text

    with pg.transaction() as conn:
        conn.execute(text(f"SET LOCAL statement_timeout = {int(timeout_ms)}"))
        row = conn.execute(text(SIZES_SQL), {"zid": zid}).mappings().first()
    if row is None:
        raise RuntimeError("size query returned no row")
    return int(row["votes"]), int(row["voters"]), int(row["comments"])


# --------------------------------------------------------------------------- #
# The model
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class MemoryModel:
    """Size -> bytes. Defaults are the local measurement; every coefficient
    has a MATH_POLLER_MEM_* variable (see PollerConfig)."""

    base_mb: float = 209.0
    per_mcell_mb: float = 133.0
    per_vote_row_bytes: float = 1000.0
    safety: float = 1.15
    job_floor_mb: float = 64.0
    retained_base_mb: float = 40.0
    retained_per_mcell_mb: float = 30.0
    retained_per_voter_kb: float = 27.0

    def validate(self) -> None:
        for name, value in asdict(self).items():
            if not (isinstance(value, (int, float)) and value == value
                    and value not in (float("inf"), float("-inf")) and value >= 0):
                raise ValueError(f"memory model {name} must be a finite number >= 0, got {value}")
        if self.safety < 1:
            raise ValueError(f"memory model safety must be >= 1, got {self.safety}")

    def above_base_bytes(self, votes: int, voters: int, comments: int) -> int:
        """What one computation adds to a process that already has its base:
        the sized estimate, never less than the per-job floor."""
        cells = max(0, voters) * max(0, comments)
        raw = self.per_mcell_mb * MB * cells / 1e6 + self.per_vote_row_bytes * max(0, votes)
        return max(int(self.job_floor_mb * MB), int(self.safety * raw))

    def peak_bytes(self, votes: int, voters: int, comments: int) -> int:
        """Estimated peak RSS of a process doing only this computation."""
        return self.base_bytes() + self.above_base_bytes(votes, voters, comments)

    def base_bytes(self) -> int:
        return int(self.safety * self.base_mb * MB)

    def retained_bytes(self, voters: int, comments: int) -> int:
        """Upper bound on what a cached conversation keeps after its compute."""
        cells = max(0, voters) * max(0, comments)
        raw = self.retained_base_mb * MB + max(
            self.retained_per_mcell_mb * MB * cells / 1e6,
            self.retained_per_voter_kb * KB * max(0, voters),
        )
        return int(self.safety * raw)

    def describe(self) -> Dict[str, float]:
        return asdict(self)


# --------------------------------------------------------------------------- #
# The accountant
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Reservation:
    token: int
    zid: int
    kind: str
    nbytes: int
    exclusive: bool


# evictor(shortfall_bytes, protected_zids) -> bytes freed. Called WITHOUT the
# admission lock held; it takes the cache lock and calls drop_retained.
Evictor = Callable[[int, Set[int]], int]


class MemoryAdmission:
    """One per poller process. Thread-safe. Lock order: the service's cache
    lock may be held when calling set_retained/drop_retained; this class never
    takes the cache lock itself (the evictor is called with no lock held)."""

    def __init__(
        self,
        limit_bytes: Optional[int],
        model: Optional[MemoryModel] = None,
        *,
        headroom: float = 0.15,
        cache_bytes: Optional[int] = None,
        cache_fraction: float = 0.3,
        base_bytes: Optional[int] = None,
        source: str = "unset",
        rss_fn: Optional[Callable[[], int]] = None,
    ) -> None:
        self.model = model or MemoryModel()
        self.model.validate()
        if not (0 <= headroom < 1):
            raise ValueError(f"memory headroom must be in [0, 1), got {headroom}")
        self.limit_bytes = int(limit_bytes) if limit_bytes else None
        self.source = source
        self.headroom = float(headroom)
        self.budget_bytes = (
            int(self.limit_bytes * (1 - self.headroom)) if self.limit_bytes else None
        )
        self.base_bytes = int(base_bytes) if base_bytes is not None else self.model.base_bytes()
        # The measured side of the fit rule (P-073 §2.2). None: accounted
        # bytes only (a directly constructed accountant, as most tests use).
        self._rss_fn = rss_fn
        self.measured_rss_bytes: Optional[int] = None
        if self.budget_bytes is not None:
            if self.base_bytes >= self.budget_bytes:
                raise ValueError(
                    f"process base {self.base_bytes / MB:.0f} MiB does not fit the budget "
                    f"{self.budget_bytes / MB:.0f} MiB"
                )
            self.cache_budget_bytes = int(
                cache_bytes if cache_bytes is not None else cache_fraction * self.budget_bytes
            )
        else:
            self.cache_budget_bytes = int(cache_bytes) if cache_bytes is not None else None
        self._cond = threading.Condition(threading.Lock())
        self._retained: Dict[int, int] = {}
        self._granted: Dict[int, Reservation] = {}
        self._waiters: List[int] = []
        # zid -> number of workers holding its cached object; zids dropped from
        # the cache while held keep their charge until the last unhold.
        self._holds: Dict[int, int] = {}
        self._detached: Set[int] = set()
        self._tokens = itertools.count(1)
        self._evictor: Optional[Evictor] = None
        # Cumulative counters. ``admitted`` is every reservation ever granted;
        # the snapshot's ``granted`` is the reservations held right now.
        self.stats = {"admitted": 0, "waited": 0, "refused": 0, "deferred": 0,
                      "evicted_bytes": 0}

    # -- construction ----------------------------------------------------- #
    @classmethod
    def from_config(cls, config: Any, *, cgroup_fn: Optional[Callable[[], Optional[int]]] = None,
                    rss_fn: Optional[Callable[[], int]] = None) -> "MemoryAdmission":
        """The budget for a PollerConfig: the cgroup limit, else the configured
        MATH_POLLER_MEMORY_LIMIT_MB, else None (unlimited; the CLI refuses to
        start in that case)."""
        model = MemoryModel(
            base_mb=config.mem_base_mb, per_mcell_mb=config.mem_per_mcell_mb,
            per_vote_row_bytes=config.mem_per_vote_row_bytes, safety=config.mem_safety,
            job_floor_mb=config.mem_job_floor_mb,
            retained_base_mb=config.mem_retained_base_mb,
            retained_per_mcell_mb=config.mem_retained_per_mcell_mb,
            retained_per_voter_kb=config.mem_retained_per_voter_kb,
        )
        cgroup_fn = cgroup_fn or (lambda: read_cgroup_limit_bytes())
        rss_fn = rss_fn or read_rss_bytes
        limit, source = cgroup_fn(), "cgroup"
        if limit is None and config.memory_limit_mb:
            limit, source = int(config.memory_limit_mb * MB), "env"
        if limit is None:
            source = "unknown"
        base = max(model.base_bytes(), int(rss_fn())) if limit is not None else None
        cache = int(config.conv_cache_mb * MB) if config.conv_cache_mb else None
        return cls(limit, model, headroom=config.memory_headroom, cache_bytes=cache,
                   base_bytes=base, source=source,
                   rss_fn=rss_fn if limit is not None else None)

    @property
    def limited(self) -> bool:
        return self.budget_bytes is not None

    def set_evictor(self, evictor: Optional[Evictor]) -> None:
        self._evictor = evictor

    def describe(self) -> Dict[str, Any]:
        """The settings that bind a calibration (no live counters)."""
        return {
            "limit_bytes": self.limit_bytes, "source": self.source, "headroom": self.headroom,
            "budget_bytes": self.budget_bytes, "cache_budget_bytes": self.cache_budget_bytes,
            "model": self.model.describe(),
        }

    def snapshot(self) -> Dict[str, Any]:
        with self._cond:
            return {
                "budget_mb": None if self.budget_bytes is None else round(self.budget_bytes / MB),
                "base_mb": round(self.base_bytes / MB),
                "rss_mb": (None if self.measured_rss_bytes is None
                           else round(self.measured_rss_bytes / MB)),
                "retained_mb": round(sum(self._retained.values()) / MB),
                "cached": len(self._retained),
                "reserved_mb": round(sum(r.nbytes for r in self._granted.values()) / MB),
                **self.stats,
                "granted": len(self._granted), "waiting": len(self._waiters),
                "held": len(self._holds),
            }

    # -- retained cache accounting (service calls these under its cache lock)
    def set_retained(self, zid: int, nbytes: int) -> None:
        with self._cond:
            self._retained[zid] = int(nbytes)
            self._detached.discard(zid)

    def drop_retained(self, zid: int) -> int:
        """The cache no longer holds zid. Returns the bytes freed: 0 while a
        worker still holds the object, whose charge then stays until the last
        ``unhold``."""
        with self._cond:
            if self._holds.get(zid):
                if zid in self._retained:
                    self._detached.add(zid)
                return 0
            freed = self._retained.pop(zid, 0)
            if freed:
                self._cond.notify_all()
            return freed

    # -- held objects (a worker's reference to a cached conversation) ------ #
    def hold(self, zid: int) -> None:
        """Call under the service's cache lock, atomically with the lookup."""
        with self._cond:
            self._holds[zid] = self._holds.get(zid, 0) + 1

    def unhold(self, zid: int) -> None:
        with self._cond:
            count = self._holds.get(zid, 0) - 1
            if count > 0:
                self._holds[zid] = count
                return
            self._holds.pop(zid, None)
            if zid in self._detached:
                self._detached.discard(zid)
                if self._retained.pop(zid, 0):
                    self._cond.notify_all()

    def is_held(self, zid: int) -> bool:
        with self._cond:
            return bool(self._holds.get(zid))

    def held(self) -> Set[int]:
        with self._cond:
            return set(self._holds)

    def retained_total(self) -> int:
        with self._cond:
            return sum(self._retained.values())

    def over_cache_budget(self) -> bool:
        if self.cache_budget_bytes is None:
            return False
        return self.retained_total() > self.cache_budget_bytes

    def retained_of(self, zid: int) -> int:
        with self._cond:
            return self._retained.get(zid, 0)

    # -- reservations ------------------------------------------------------ #
    def compute_capacity_bytes(self) -> Optional[int]:
        """The most any single computation may use: budget minus the base."""
        return None if self.budget_bytes is None else self.budget_bytes - self.base_bytes

    def fits_alone(self, nbytes: int) -> bool:
        cap = self.compute_capacity_bytes()
        return cap is None or nbytes <= cap

    def _read_rss_locked(self) -> Optional[int]:
        """One RSS sample, or None without a reader or when the read fails
        (the rule then falls back to the accounted bytes alone)."""
        if self._rss_fn is None:
            return None
        try:
            rss = int(self._rss_fn())
        except Exception as exc:  # noqa: BLE001 - a failed read must not stop admission
            logger.warning("memory admission: RSS read failed (%s)", exc.__class__.__name__)
            return None
        self.measured_rss_bytes = rss
        return rss

    def _used_locked(self) -> int:
        """max(accounted resident, measured RSS) + every granted reservation.
        The measured figure can only raise the charge, never lower it."""
        resident = self.base_bytes + sum(self._retained.values())
        rss = self._read_rss_locked()
        if rss is not None and rss > resident:
            resident = rss
        return resident + sum(r.nbytes for r in self._granted.values())

    def _fits_locked(self, nbytes: int) -> bool:
        if self.budget_bytes is None:
            return True
        return self._used_locked() + nbytes <= self.budget_bytes

    def _shortfall_locked(self, nbytes: int) -> int:
        if self.budget_bytes is None:
            return 0
        return self._used_locked() + nbytes - self.budget_bytes

    def refresh_baseline(self) -> Optional[int]:
        """Re-measure the process baseline when the poller is quiet: nothing
        granted and nothing held. The baseline is max(model base, RSS minus
        the retained cache charge), the latest quiet sample. Returns the new
        baseline, or None when not quiet, unlimited or without a reader.

        Lowering the baseline here never lowers a reservation: reservations
        are sized by the model alone, and every fit decision still charges
        the live RSS when it is higher than the accounted bytes."""
        if self.budget_bytes is None or self._rss_fn is None:
            return None
        with self._cond:
            if self._granted or self._holds:
                return None
            rss = self._read_rss_locked()
            if rss is None:
                return None
            retained = sum(self._retained.values())
            before = self.base_bytes
            self.base_bytes = max(self.model.base_bytes(), rss - retained)
            if self.base_bytes < before:
                self._cond.notify_all()
            after = self.base_bytes
        if abs(after - before) >= BASELINE_LOG_STEP:
            logger.info(
                "memory admission: measured baseline base_mb=%.0f (was %.0f) rss_mb=%.0f "
                "retained_mb=%.0f budget_mb=%.0f", after / MB, before / MB, rss / MB,
                retained / MB, self.budget_bytes / MB)
        if after >= self.budget_bytes:
            logger.warning("memory admission: measured baseline %.0f MiB is at or above the "
                           "budget %.0f MiB; every computation is refused until it falls",
                           after / MB, self.budget_bytes / MB)
        return after

    def _grantable_locked(self, ticket: int, nbytes: int, exclusive: bool) -> bool:
        if self._waiters and self._waiters[0] != ticket:
            return False  # first in, first out
        if any(r.exclusive for r in self._granted.values()):
            return False
        if exclusive and self._granted:
            return False
        return self._fits_locked(nbytes)

    def _impossible_locked(self, zid: int, nbytes: int) -> bool:
        """Cannot fit even with every other reservation released and every
        evictable cache entry gone (the zid's own entry stays), on top of the
        measured quiescent baseline."""
        if self.budget_bytes is None:
            return False
        own = self._retained.get(zid, 0)
        return self.base_bytes + own + nbytes > self.budget_bytes

    def reserve(
        self,
        zid: int,
        nbytes: int,
        *,
        kind: str,
        exclusive: bool = False,
        wait: bool = True,
        stop: Optional[threading.Event] = None,
        poll_s: float = 0.25,
    ) -> Optional[Reservation]:
        """Grant a reservation, waiting (``wait=True``) or not. Returns None
        only when ``wait=False`` and it does not fit now. Raises OverBudget
        when it can never fit, AdmissionStopped when ``stop`` is set while
        waiting."""
        nbytes = max(0, int(nbytes))
        with self._cond:
            if self._impossible_locked(zid, nbytes):
                self.stats["refused"] += 1
                own = self._retained.get(zid, 0)
                raise OverBudget(
                    f"zid={zid} {kind} needs {nbytes / MB:.0f} MiB; the budget holds "
                    f"{self.budget_bytes / MB:.0f} MiB with base {self.base_bytes / MB:.0f} MiB "
                    f"and its own cached state {own / MB:.0f} MiB",
                    need_bytes=nbytes,
                    capacity_bytes=max(0, self.budget_bytes - self.base_bytes - own),
                )
            ticket = next(self._tokens)
            self._waiters.append(ticket)
        waited = False
        try:
            while True:
                with self._cond:
                    if self._grantable_locked(ticket, nbytes, exclusive):
                        res = Reservation(ticket, zid, kind, nbytes, exclusive)
                        self._granted[ticket] = res
                        self.stats["admitted"] += 1
                        if waited:
                            self.stats["waited"] += 1
                        return res
                    head = self._waiters[0] == ticket
                    blocked_by_exclusive = any(r.exclusive for r in self._granted.values()) or (
                        exclusive and bool(self._granted))
                    shortfall = self._shortfall_locked(nbytes)
                    # Running and held objects are never evicted; the
                    # evictor re-checks holds under the cache lock.
                    protect = ({r.zid for r in self._granted.values()} | {zid}
                               | set(self._holds))
                    evictable = sum(b for z, b in self._retained.items() if z not in protect)
                if (head and not blocked_by_exclusive and shortfall > 0 and evictable > 0
                        and self._evictor is not None):
                    freed = self._evictor(shortfall, protect)
                    if freed > 0:
                        with self._cond:
                            self.stats["evicted_bytes"] += freed
                        continue
                with self._cond:
                    if self._grantable_locked(ticket, nbytes, exclusive):
                        continue
                    if not wait:
                        self.stats["deferred"] += 1
                        return None
                    protect |= set(self._holds)
                    if (not self._granted and head and self._shortfall_locked(nbytes) > 0
                            and not any(z not in protect for z in self._retained)):
                        # Nothing left to release or evict: it can never fit
                        # now. Objects held by other waiters count as held,
                        # so two waiters cannot wait on each other forever.
                        self.stats["refused"] += 1
                        raise OverBudget(
                            f"zid={zid} {kind} needs {nbytes / MB:.0f} MiB beside the "
                            f"protected cache; nothing else holds memory",
                            need_bytes=nbytes,
                            capacity_bytes=max(0, nbytes - self._shortfall_locked(nbytes)),
                        )
                    if stop is not None and stop.is_set():
                        raise AdmissionStopped(f"zid={zid} {kind}: poller stopping")
                    if not waited:
                        waited = True
                        logger.info(
                            "memory admission: zid=%s %s waits for %.0f MiB (%s)", zid, kind,
                            nbytes / MB, "exclusive job running" if blocked_by_exclusive
                            else "budget full")
                    self._cond.wait(poll_s)
        finally:
            with self._cond:
                if ticket in self._waiters:
                    self._waiters.remove(ticket)
                self._cond.notify_all()

    def release(self, res: Optional[Reservation]) -> None:
        if res is None:
            return
        with self._cond:
            self._granted.pop(res.token, None)
            self._cond.notify_all()

    def granted(self) -> List[Reservation]:
        with self._cond:
            return list(self._granted.values())


__all__ = [
    "AdmissionStopped", "MemoryAdmission", "MemoryModel", "OverBudget", "Reservation",
    "SIZES_SQL", "conversation_dims", "read_cgroup_limit_bytes", "read_conversation_sizes",
    "read_rss_bytes",
]
