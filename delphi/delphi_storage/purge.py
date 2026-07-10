"""Per-job purge (design §9): input snapshots copy votes/comments outside the
source PG, so GDPR deletion needs a path that removes them. Deletes every
generic-entity partition for a job (run_inputs, artifacts, topic_moderation,
collective_statements).

SCOPE (P6a): per-JOB only — the caller must know the job ids. The per-zid
purge tool §9 calls for (enumerate all runs of a conversation, purge each)
requires the run manifests, which land in P7; it follows there via
list_runs(zid=...) + purge_job. Run-manifest rows themselves are removed by
the retention machinery (P7+)."""

from delphi_storage.interface import DelphiStore
from delphi_storage.keys import GENERIC_ENTITIES


def purge_job(store: DelphiStore, job_id: str) -> int:
    """Delete every stored item for a job across all generic entities;
    returns the number of logical items removed."""
    return sum(store.delete_partition(entity, job_id) for entity in GENERIC_ENTITIES)


def purge_zid(store: DelphiStore, zid: int) -> dict:
    """Per-conversation purge (the §9 GDPR path): remove the snapshot and
    artifact partitions of EVERY run of a conversation, enumerated via the
    run manifests (P7a). Manifests and latest pointers are retained — they
    carry only config, counts and hashes, never vote/comment content; their
    removal belongs to the retention machinery (P14)."""
    runs = store.list_runs(zid=zid, limit=100000)
    items = sum(purge_job(store, run.job_id) for run in runs)
    return {"runs": len(runs), "items": items}
