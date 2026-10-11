# Rebuild one conversation through the queue

The capacity poller already admits oversized conversations as `math_rebuild`
jobs. The operator command admits a conversation of any size through the same
Postgres RPC and large worker. It reads conversation counts and timestamps,
estimates memory with the configured poller model, and submits a typed frame.

Set `DATABASE_URL` to the conversation database, `MATH_CAPACITY_QUEUE_DSN` to
a restricted executor-member login, and `MATH_CAPACITY_QUEUE_ENV` to the worker's
queue namespace. Do not place database credentials in arguments or reports.

From `delphi/`:

```sh
PYTHONPATH=. python scripts/enqueue_math_rebuild.py \
  --zid "$DEMO_ZID" --staged-label demo-staged --target-label demo-math \
  --source-commit "$MATH_POLLER_SOURCE_COMMIT" --dry-run
```

Remove `--dry-run` to enqueue. Repeating admission while the job is active
returns the existing job. A poisoned scope or an active scope with conflicting
configuration returns exit 1 without creating a job; malformed configuration
or a failed database operation returns exit 2. The JSON outcome and job ID
identify the conflict for the operator.

The daemon must have `POLIS_JOBS_WORKER_CLASS=large`,
`POLIS_JOBS_STAGES=math_rebuild`, the matching `QUEUE_ENV`, a conversation
`DATABASE_URL`, and a known `MATH_POLLER_MEMORY_LIMIT_MB` (or cgroup limit).
Its `MATH_POLLER_SOURCE_COMMIT` must equal the admission's commit. Do not set
the retired resident worker's `MATH_CAPACITY_CLASS=large`; the daemon starts
`math_poller.py --job` for each claimed job. The child rechecks capacity,
obtains the existing single-writer lock, and rebuilds the one conversation.

Results land in `math_main`, `math_bidtopid`, and `math_ptptstats` under the
staged label. The child does not publish the target label. The existing
capacity promotion loop requires the queue's successful finalization and a
manifest matching the staged fingerprint before promotion. An operator
admission alone does not register a conversation in a resident capacity router;
use the staged label for local inspection, or let ordinary capacity routing
track and promote its own admission. `prod`, `python`, and identical staged and
target labels are refused for staged writes.
