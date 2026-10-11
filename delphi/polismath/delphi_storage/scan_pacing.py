"""Paced, throttle-tolerant DynamoDB Scan pages for the one-shot census.

Most source tables are provisioned at 5 read capacity units (RCU) and the box
role cannot call DescribeTable, so the read rate is never discovered: it is a
configured ceiling. Each Scan is eventually consistent (half the RCU of a
strongly consistent read), asks for a modest page, and returns its
ConsumedCapacity; the next request waits until the units already spent fit the
ceiling. Throttling backs off exponentially with jitter for a bounded number of
consecutive attempts, then raises ScanPaused so the caller can stop with its
checkpoint intact and a rerun continues from the last committed page.
"""
from __future__ import annotations

import random
import time

DEFAULT_MAX_READ_UNITS_PER_SECOND = 2.0
DEFAULT_PAGE_LIMIT = 25
DEFAULT_MAX_THROTTLE_RETRIES = 8
# An eventually consistent Scan page costs at least half a unit. Charge that
# when a response carries no ConsumedCapacity (DynamoDB returns it whenever
# ReturnConsumedCapacity is requested, so this covers test doubles only).
FALLBACK_PAGE_UNITS = 0.5
THROTTLE_CODES = frozenset({'ProvisionedThroughputExceededException', 'ThrottlingException',
                            'RequestLimitExceeded'})

# Resolved at call time so tests can replace them without touching `time`.
_monotonic = time.monotonic
_sleep = time.sleep


class ScanPaused(Exception):
    """Throttling outlasted the retry bound; every committed page is kept."""


def is_throttle(exc):
    response = getattr(exc, 'response', None)
    if not isinstance(response, dict):
        return False
    return response.get('Error', {}).get('Code') in THROTTLE_CODES


class ScanPacer:
    def __init__(self, max_read_units_per_second=DEFAULT_MAX_READ_UNITS_PER_SECOND, *,
                 page_limit=DEFAULT_PAGE_LIMIT, max_throttle_retries=DEFAULT_MAX_THROTTLE_RETRIES,
                 base_delay=0.5, max_delay=30.0, clock=None, sleep=None, rng=None):
        if not max_read_units_per_second > 0:
            raise ValueError('positive read rate required')
        if not 1 <= int(page_limit) <= 1000:
            raise ValueError('page limit must be 1..1000')
        if max_throttle_retries < 0 or base_delay <= 0 or max_delay < base_delay:
            raise ValueError('invalid backoff bounds')
        self.rate = float(max_read_units_per_second)
        self.page_limit = int(page_limit)
        self.max_throttle_retries = int(max_throttle_retries)
        self.base_delay = float(base_delay)
        self.max_delay = float(max_delay)
        self._clock = clock
        self._sleep_fn = sleep
        self._rng = rng or random.random
        self._ready_at = None
        self.pages = 0
        self.units = 0.0
        self.throttles = 0
        self.unmetered_pages = 0
        self.waited = 0.0

    def _now(self):
        return (self._clock or _monotonic)()

    def _sleep(self, seconds):
        if seconds > 0:
            self.waited += seconds
            (self._sleep_fn or _sleep)(seconds)

    def backoff(self, attempt):
        """Exponential delay with equal jitter: half fixed, half uniform."""
        ceiling = min(self.max_delay, self.base_delay * (2 ** attempt))
        return ceiling / 2 + self._rng() * ceiling / 2

    def scan(self, client, **arguments):
        """One page: eventually consistent, limited, metered and paced."""
        arguments = dict(arguments, ConsistentRead=False, Limit=self.page_limit,
                         ReturnConsumedCapacity='TOTAL')
        attempt = 0
        while True:
            if self._ready_at is not None:
                self._sleep(self._ready_at - self._now())
            started = self._now()
            try:
                response = client.scan(**arguments)
            except Exception as exc:
                if not is_throttle(exc):
                    raise
                self.throttles += 1
                if attempt >= self.max_throttle_retries:
                    raise ScanPaused('scan throttled beyond the retry bound') from None
                delay = self.backoff(attempt)
                attempt += 1
                # The next request of any kind waits out the backoff too.
                self._ready_at = self._now() + delay
                continue
            consumed = response.get('ConsumedCapacity') or {}
            units = consumed.get('CapacityUnits')
            if not isinstance(units, (int, float)) or units < 0:
                units = FALLBACK_PAGE_UNITS
                self.unmetered_pages += 1
            self.pages += 1
            self.units += units
            self._ready_at = max(self._ready_at or started, started) + units / self.rate
            return response

    def summary(self):
        return dict(pages=self.pages, read_units=round(self.units, 3), throttles=self.throttles,
                    unmetered_pages=self.unmetered_pages, waited_seconds=round(self.waited, 3),
                    max_read_units_per_second=self.rate, page_limit=self.page_limit)
