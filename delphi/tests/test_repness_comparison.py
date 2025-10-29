#!/usr/bin/env python3
"""
Test script to compare representativeness calculation between Python and Clojure.
"""

import json
import os
import sys
import traceback
from typing import Any

import numpy as np
import pandas as pd

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from polismath.conversation.conversation import Conversation
from polismath.pca_kmeans_rep.named_matrix import NamedMatrix
from polismath.pca_kmeans_rep.repness import conv_repness


def load_clojure_results(dataset_name: str) -> dict[str, Any]:
    """
    Load Clojure results from file.

    Args:
        dataset_name: 'biodiversity' or 'vw'

    Returns:
        Dictionary with Clojure results
    """
    if dataset_name == "biodiversity":
        json_path = os.path.join("real_data/biodiversity", "biodiveristy_clojure_output.json")
    elif dataset_name == "vw":
        json_path = os.path.join("real_data/vw", "vw_clojure_output.json")
    else:
        raise ValueError(f"Unknown dataset: {dataset_name}")

    if not os.path.exists(json_path):
        print(f"Warning: Clojure output file {json_path} not found!")
        return {}

    with open(json_path) as f:
        return json.load(f)


def create_test_conversation(dataset_name: str) -> Conversation:
    """
    Create a test conversation with real data.

    Args:
        dataset_name: 'biodiversity' or 'vw'

    Returns:
        Conversation with the dataset loaded
    """
    # Set paths based on dataset
    if dataset_name == "biodiversity":
        votes_path = os.path.join("real_data/biodiversity", "2025-03-18-2000-3atycmhmer-votes.csv")
    elif dataset_name == "vw":
        votes_path = os.path.join("real_data/vw", "2025-03-18-1954-4anfsauat2-votes.csv")
    else:
        raise ValueError(f"Unknown dataset: {dataset_name}")

    # Read votes from CSV
    df = pd.read_csv(votes_path)

    # Get unique participant and comment IDs
    ptpt_ids = sorted(df["voter-id"].unique())
    cmt_ids = sorted(df["comment-id"].unique())

    # Create a matrix of NaNs
    vote_matrix = np.full((len(ptpt_ids), len(cmt_ids)), np.nan)

    # Create row and column maps
    ptpt_map = {pid: i for i, pid in enumerate(ptpt_ids)}
    cmt_map = {cid: i for i, cid in enumerate(cmt_ids)}

    # Fill the matrix with votes
    for _, row in df.iterrows():
        pid = row["voter-id"]
        cid = row["comment-id"]

        # Convert vote to numeric value
        try:
            vote_val = float(row["vote"])
            # Normalize to ensure only -1, 0, or 1
            if vote_val > 0:
                vote_val = 1.0
            elif vote_val < 0:
                vote_val = -1.0
            else:
                vote_val = 0.0
        except ValueError:
            # Handle text values
            vote_text = str(row["vote"]).lower()
            if vote_text == "agree":
                vote_val = 1.0
            elif vote_text == "disagree":
                vote_val = -1.0
            else:
                vote_val = 0.0  # Pass or unknown

        # Add vote to matrix
        r_idx = ptpt_map[pid]
        c_idx = cmt_map[cid]
        vote_matrix[r_idx, c_idx] = vote_val

    # Convert to DataFrame
    df_matrix = pd.DataFrame(vote_matrix, index=[str(pid) for pid in ptpt_ids], columns=[str(cid) for cid in cmt_ids])

    # Create a NamedMatrix
    named_matrix = NamedMatrix(df_matrix, enforce_numeric=True)

    # Create a Conversation object
    conv = Conversation(dataset_name)

    # Set the raw_rating_mat and update stats
    conv.raw_rating_mat = named_matrix
    conv.rating_mat = named_matrix  # No moderation
    conv.participant_count = len(ptpt_ids)
    conv.comment_count = len(cmt_ids)

    return conv


def compare_repness_results(py_results: dict[str, Any], clj_results: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    """
    Compare Python and Clojure representativeness results.

    Args:
        py_results: Python representativeness results
        clj_results: Clojure representativeness results

    Returns:
        Tuple of (match_rate, stats_dict)
    """
    if not clj_results:
        print("No Clojure results to compare with.")
        return 0.0, {}

    # Initialize comparison stats
    stats = {
        "total_comments": 0,
        "comment_matches": 0,
        "group_match_rates": {},
        "consensus_match_rate": 0.0,
        "top_matching_comments": [],
    }

    # Extract Clojure group repness data
    if "group-clusters" in clj_results and "repness" in clj_results:
        clj_repness = clj_results["repness"]
        clj_group_clusters = clj_results["group-clusters"]

        # Map Clojure group IDs to Python group IDs (assuming same order)
        group_id_map = {}
        for i, clj_group in enumerate(clj_group_clusters):
            clj_group_id = clj_group.get("id", i)
            group_id_map[clj_group_id] = i

        # Compare group repness results
        for clj_group_id, clj_group_repness in clj_repness.items():
            # Handle different formats of group ID
            str_group_id = str(clj_group_id)
            py_group_id = str_group_id

            # Get Python repness for this group
            try:
                py_group_id_int = int(py_group_id)
            except (ValueError, TypeError):
                py_group_id_int = py_group_id
            py_group_repness = py_results.get("group_repness", {}).get(py_group_id_int, [])

            if not isinstance(clj_group_repness, list):
                # Skip non-list items
                continue

            # Extract comment IDs from both results
            clj_comment_ids = [str(c.get("tid", c.get("comment_id", ""))) for c in clj_group_repness]
            py_comment_ids = [str(c.get("comment_id", "")) for c in py_group_repness]

            # Count matches
            matches = set(clj_comment_ids) & set(py_comment_ids)
            total = len(set(clj_comment_ids) | set(py_comment_ids))

            if total > 0:
                match_rate = len(matches) / total
            else:
                match_rate = 0.0

            stats["group_match_rates"][py_group_id] = match_rate
            stats["total_comments"] += total
            stats["comment_matches"] += len(matches)

            # Find top matching comments
            for cid in matches:
                # Get comment data from both results
                clj_comment = next(
                    (c for c in clj_group_repness if str(c.get("tid", c.get("comment_id", ""))) == cid), {}
                )
                py_comment = next((c for c in py_group_repness if str(c.get("comment_id", "")) == cid), {})

                # Extract values from Clojure comment (handle different key formats)
                if "p-success" in clj_comment:
                    clj_agree = clj_comment.get("p-success", 0)
                    clj_disagree = 1 - clj_agree
                else:
                    clj_agree = clj_comment.get("pa", 0)
                    clj_disagree = clj_comment.get("pd", 0)

                # Extract repness values
                clj_repness_val = clj_comment.get("repness", 0)
                clj_repness_test = clj_comment.get("repness-test", 0)

                stats["top_matching_comments"].append(
                    {
                        "comment_id": cid,
                        "group_id": py_group_id,
                        "clojure": {
                            "agree": clj_agree,
                            "disagree": clj_disagree,
                            "repness": clj_repness_val,
                            "repness_test": clj_repness_test,
                        },
                        "python": {
                            "agree": py_comment.get("pa", 0),
                            "disagree": py_comment.get("pd", 0),
                            "agree_metric": py_comment.get("agree_metric", 0),
                            "disagree_metric": py_comment.get("disagree_metric", 0),
                        },
                    }
                )

        # Look for consensus comments if they exist
        if "consensus-comments" in clj_repness:
            clj_consensus = clj_repness.get("consensus-comments", [])
            py_consensus = py_results.get("consensus_comments", [])

            # Extract comment IDs
            clj_consensus_ids = [str(c.get("comment-id", c.get("tid", c.get("comment_id", "")))) for c in clj_consensus]
            py_consensus_ids = [str(c.get("comment_id", "")) for c in py_consensus]

            consensus_matches = set(clj_consensus_ids) & set(py_consensus_ids)
            consensus_total = len(set(clj_consensus_ids) | set(py_consensus_ids))

            if consensus_total > 0:
                stats["consensus_match_rate"] = len(consensus_matches) / consensus_total
            else:
                stats["consensus_match_rate"] = 0.0

            stats["total_comments"] += consensus_total
            stats["comment_matches"] += len(consensus_matches)

    # Calculate overall match rate
    overall_match_rate = stats["comment_matches"] / stats["total_comments"] if stats["total_comments"] > 0 else 0.0

    return overall_match_rate, stats


def test_comparison(dataset_name: str) -> None:
    """
    Run representativeness comparison test with a dataset.

    Args:
        dataset_name: 'biodiversity' or 'vw'
    """
    print(f"\nComparing representativeness calculations for {dataset_name} dataset")

    try:
        # Load Clojure results
        clj_results = load_clojure_results(dataset_name)

        if not clj_results:
            print("No Clojure results available for comparison. Skipping test.")
            return

        # Create a conversation with the dataset
        print("Creating conversation...")
        conv = create_test_conversation(dataset_name)

        print("Conversation created successfully")
        print(f"Participants: {conv.participant_count}")
        print(f"Comments: {conv.comment_count}")

        # Run PCA and clustering first (needed for repness)
        print("Running PCA and clustering...")
        conv._compute_pca()
        conv._compute_clusters()

        # Run representativeness calculation
        print("Running representativeness calculation...")
        repness_results = conv_repness(conv.rating_mat, conv.group_clusters)

        # Compare with Clojure results
        match_rate, stats = compare_repness_results(repness_results, clj_results)

        print("\nComparison Results:")
        print(
            f"  - Overall match rate: {match_rate:.2f} ({stats['comment_matches']} / {stats['total_comments']} comments)"
        )

        print("\n  Group match rates:")
        for group_id, rate in stats["group_match_rates"].items():
            print(f"    - Group {group_id}: {rate:.2f}")

        print(f"\n  Consensus comments match rate: {stats['consensus_match_rate']:.2f}")

        print("\n  Top matching comments:")
        for _i, comment in enumerate(stats["top_matching_comments"][:5]):  # Show top 5
            cid = comment["comment_id"]
            gid = comment["group_id"]
            print(f"    - Comment {cid} (Group {gid}):")
            print(
                f"      Clojure: Agree={comment['clojure']['agree']:.2f}, Disagree={comment['clojure']['disagree']:.2f}"
            )
            print(
                f"                Repness={comment['clojure']['repness']:.2f}, Repness Test={comment['clojure']['repness_test']:.2f}"
            )
            print(
                f"      Python:  Agree={comment['python']['agree']:.2f}, Disagree={comment['python']['disagree']:.2f}"
            )
            print(
                f"                Agree Metric={comment['python']['agree_metric']:.2f}, Disagree Metric={comment['python']['disagree_metric']:.2f}"
            )

        # Print Python representativeness summary
        print("\n  Python Representativeness Summary:")
        for group_id, comments in repness_results.get("group_repness", {}).items():
            if comments:
                print(f"    - Group {group_id}: {len(comments)} comments")
                for i, cmt in enumerate(comments[:3]):  # Show top 3
                    print(f"      Comment {i + 1}: ID {cmt.get('comment_id')}, Type: {cmt.get('repful')}")
                    print(f"        Agree: {cmt.get('pa', 0):.2f}, Disagree: {cmt.get('pd', 0):.2f}")
                    print(f"        Metrics: A={cmt.get('agree_metric', 0):.2f}, D={cmt.get('disagree_metric', 0):.2f}")

        print("\nComparison completed successfully!")

    except Exception as e:
        print(f"Error during representativeness comparison: {e}")
        traceback.print_exc()
        print("Comparison FAILED!")


if __name__ == "__main__":
    # Test on both datasets
    test_comparison("biodiversity")
    print("\n" + "=" * 50)
    test_comparison("vw")
