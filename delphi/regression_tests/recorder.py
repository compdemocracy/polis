#!/usr/bin/env python3
"""
Recorder module for capturing golden snapshots of Conversation computation outputs.
"""

import json
import hashlib
from pathlib import Path
from datetime import datetime
import pandas as pd
import sys
import os

# Add parent directory to path to import polismath modules
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from polismath.conversation.conversation import Conversation
from tests.dataset_config import get_dataset_files
from tests.common_utils import create_test_conversation


class ConversationRecorder:
    """Records golden snapshots of Conversation computations for regression testing."""

    def __init__(self):
        self.golden_dir = Path(__file__).parent / "golden"
        self.golden_dir.mkdir(exist_ok=True)

    def record_golden(self, dataset_name: str, force: bool = False):
        """
        Record golden snapshot for a dataset.

        Args:
            dataset_name: Name of the dataset ('biodiversity' or 'vw')
            force: If True, overwrite existing golden snapshot

        Returns:
            Path to the saved golden snapshot file
        """
        golden_path = self.golden_dir / f"{dataset_name}_golden.json"

        if golden_path.exists() and not force:
            print(f"Golden snapshot already exists for {dataset_name}.")
            print(f"Use force=True to overwrite.")
            return golden_path

        print(f"Recording golden snapshot for {dataset_name}...")

        # Get dataset files using existing infrastructure
        dataset_files = get_dataset_files(dataset_name)

        # Compute MD5 checksums of source data files
        votes_md5 = self._compute_file_md5(dataset_files['votes'])
        comments_md5 = self._compute_file_md5(dataset_files['comments'])

        # Count rows in CSV files for metadata
        votes_df = pd.read_csv(dataset_files['votes'])
        comments_df = pd.read_csv(dataset_files['comments'])
        n_votes = len(votes_df)
        n_comments = len(comments_df)
        n_participants = votes_df['voter-id'].nunique()

        # Initialize snapshot structure
        snapshot = {
            "metadata": {
                "dataset_name": dataset_name,
                "report_id": dataset_files['report_id'],
                "recorded_at": datetime.now().isoformat(),
                "votes_csv_md5": votes_md5,
                "comments_csv_md5": comments_md5,
                "n_votes_in_csv": n_votes,
                "n_comments_in_csv": n_comments,
                "n_participants_in_csv": n_participants
            },
            "stages": {}
        }

        # Convert votes DataFrame to the format expected by update_votes
        votes_list = []
        for _, row in votes_df.iterrows():
            votes_list.append({
                'pid': row['voter-id'],
                'tid': row['comment-id'],
                'vote': row['vote']
            })

        # Use a fixed timestamp for reproducibility in testing
        # This avoids None comparison issues while keeping results deterministic
        fixed_timestamp = 1700000000000  # Fixed timestamp in milliseconds

        votes_dict = {
            'votes': votes_list,
            'lastVoteTimestamp': fixed_timestamp
        }

        # Stage 1: Empty conversation (with fixed timestamp)
        conv_empty = Conversation(dataset_name, last_updated=fixed_timestamp)
        snapshot["stages"]["empty"] = conv_empty.to_dict()

        # Stage 2: After loading votes (no recompute)
        print("  Loading votes without recompute...")
        conv = Conversation(dataset_name, last_updated=fixed_timestamp)
        conv.update_votes(votes_dict, recompute=False)
        snapshot["stages"]["after_load_no_compute"] = conv.to_dict()

        # Stage 3: After PCA computation only
        print("  Computing PCA...")
        conv._compute_pca()
        snapshot["stages"]["after_pca"] = conv.to_dict()

        # Stage 4: After PCA + clustering
        print("  Computing clustering...")
        conv._compute_pca()
        conv._compute_clusters()
        snapshot["stages"]["after_clustering"] = conv.to_dict()

        # Stage 5: Full recompute (includes repness and participant_info)
        print("  Running full recompute...")
        conv_full = Conversation(dataset_name, last_updated=fixed_timestamp)
        conv_full.update_votes(votes_dict, recompute=True)
        snapshot["stages"]["after_full_recompute"] = conv_full.to_dict()

        # Stage 6: Also capture get_full_data() output if available
        if hasattr(conv_full, 'get_full_data'):
            print("  Capturing full data export...")
            snapshot["stages"]["full_data_export"] = conv_full.get_full_data()

        # Save golden snapshot
        print(f"  Saving golden snapshot to {golden_path}")
        with open(golden_path, 'w') as f:
            json.dump(snapshot, f, indent=2, default=str)

        # Print summary
        print(f"Successfully recorded golden snapshot for {dataset_name}")
        print(f"  - Votes: {n_votes}")
        print(f"  - Comments: {n_comments}")
        print(f"  - Participants: {n_participants}")
        print(f"  - Stages captured: {len(snapshot['stages'])}")

        return golden_path

    def _compute_file_md5(self, filepath: str) -> str:
        """
        Compute MD5 hash of a file.

        Args:
            filepath: Path to the file

        Returns:
            MD5 hash as hex string
        """
        hash_md5 = hashlib.md5()
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()


if __name__ == "__main__":
    # Quick test
    recorder = ConversationRecorder()
    recorder.record_golden("biodiversity", force=True)