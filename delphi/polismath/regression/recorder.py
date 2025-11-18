#!/usr/bin/env python3
"""
Recorder for capturing golden snapshots of Conversation computation outputs.
"""

import logging
from pathlib import Path
from datetime import datetime

from .utils import (
    prepare_votes_data,
    load_golden_snapshot,
    save_golden_snapshot,
    compute_all_stages,
    compute_all_stages_with_benchmark
)

# Set up logger
logger = logging.getLogger(__name__)


class ConversationRecorder:
    """Records golden snapshots of Conversation computations for regression testing."""

    def __init__(self):
        # Golden snapshots are now stored in dataset-specific directories in real_data
        pass

    def record_golden(self, dataset_name: str, force: bool = False, benchmark: bool = True) -> Path:
        """
        Record golden snapshot for a dataset.

        Args:
            dataset_name: Name of the dataset ('biodiversity' or 'vw')
            force: If True, overwrite existing golden snapshot
            benchmark: If True, record timing information (default: True)

        Returns:
            Path to the saved golden snapshot file
        """
        # Check if golden snapshot exists
        golden, golden_path = load_golden_snapshot(dataset_name)

        if golden is not None and not force:
            logger.warning(f"Golden snapshot already exists for {dataset_name}.")
            logger.warning(f"Use force=True to overwrite.")
            return golden_path

        logger.info(f"Recording golden snapshot for {dataset_name}...")

        # Prepare votes data and metadata using shared function
        votes_dict, metadata = prepare_votes_data(dataset_name)
        metadata["recorded_at"] = datetime.now().isoformat()

        # Initialize snapshot structure
        snapshot = {
            "metadata": metadata,
            "stages": {},
            "timing_stats": {} if benchmark else None
        }

        # Compute all stages using shared function
        if benchmark:
            logger.info("Computing all stages with benchmarking...")
            results = compute_all_stages_with_benchmark(
                dataset_name, votes_dict, metadata["fixed_timestamp"]
            )
            snapshot["stages"] = results["stages"]
            snapshot["timing_stats"] = results["timing_stats"]
        else:
            logger.info("Computing all stages...")
            results = compute_all_stages(dataset_name, votes_dict, metadata["fixed_timestamp"])
            snapshot["stages"] = results["stages"]

        # Save golden snapshot using shared function
        logger.info(f"Saving golden snapshot to {golden_path}")
        save_golden_snapshot(snapshot, golden_path)

        # Print summary
        logger.info(f"Successfully recorded golden snapshot for {dataset_name}")
        logger.info(f"  - Votes: {metadata['n_votes_in_csv']}")
        logger.info(f"  - Comments: {metadata['n_comments_in_csv']}")
        logger.info(f"  - Participants: {metadata['n_participants_in_csv']}")
        logger.info(f"  - Stages captured: {len(snapshot['stages'])}")
        if benchmark:
            logger.info(f"  - Timing enabled: Yes")

        return golden_path