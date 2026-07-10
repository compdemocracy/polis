#!/usr/bin/env python3
"""Purge Storage V2 data (design §9 GDPR path).

Per job:   python scripts/delphi_purge.py --job-id <job_id>
Per zid:   python scripts/delphi_purge.py --zid <zid>

Removes snapshot (run_inputs) and artifact partitions — the payloads that
copy votes/comments outside the source PG. Run manifests and latest pointers
carry only config/counts/hashes and are retained (retention machinery, P14).
Backend/config via the usual DELPHI_STORAGE_* environment variables.
"""

import argparse
import logging

from delphi_storage import get_store
from delphi_storage.purge import purge_job, purge_zid

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="Purge Delphi Storage V2 data")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--job-id", dest="job_id", help="Purge one run's stored items")
    group.add_argument("--zid", type=int, help="Purge every run of a conversation")
    args = parser.parse_args()

    store = get_store()
    if args.job_id:
        deleted = purge_job(store, args.job_id)
        logger.info(f"Purged {deleted} items for job {args.job_id}")
    else:
        result = purge_zid(store, args.zid)
        logger.info(
            f"Purged {result['items']} items across {result['runs']} runs for zid {args.zid}"
        )


if __name__ == "__main__":
    main()
