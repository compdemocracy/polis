"""Transitional polis-queue/1 executor for the P-024 Postgres queue substrate.

Separate from ``polismath.poller`` and from ``scripts/job_poller.py`` on purpose:
nothing in either of those imports this package, and nothing here imports them,
so rolling this back is stopping a process.

Note on the package name: this is ``polismath.queue``, not the standard library's
``queue``. Python 3 resolves ``import queue`` inside ``polismath`` to the standard
library, so ``polismath.poller.worker_pool`` is unaffected; refer to this package
by its full dotted path.
"""
