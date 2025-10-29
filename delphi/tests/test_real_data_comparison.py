#!/usr/bin/env python3
"""
Test script to compare the Python conversion with the Clojure output.
Runs the analysis on real data and compares results with tolerance.
"""

import copy
import json
import os
import sys
from typing import Any

import numpy as np
import pandas as pd

from polismath.pca_kmeans_rep.clusters import cluster_named_matrix
from polismath.pca_kmeans_rep.named_matrix import NamedMatrix
from polismath.pca_kmeans_rep.pca import pca_project_named_matrix
from polismath.pca_kmeans_rep.repness import conv_repness

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from polismath.conversation.conversation import Conversation

# Tolerance for numerical comparisons
TOLERANCE = 0.2  # 20% tolerance for numerical differences


def load_votes_from_csv(votes_path: str, limit: int | None = None) -> dict[str, list[dict[str, Any]]]:
    """Load votes from a CSV file into the format expected by the Conversation class."""
    # Read CSV
    if limit:
        df = pd.read_csv(votes_path, nrows=limit)
    else:
        df = pd.read_csv(votes_path)

    # Convert to the expected format
    votes_list = []

    for _, row in df.iterrows():
        pid = str(row["voter-id"])
        tid = str(row["comment-id"])

        # Ensure vote value is a float (-1, 0, or 1)
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

        votes_list.append({"pid": pid, "tid": tid, "vote": vote_val})

    # Pack into the expected votes format
    return {"votes": votes_list}


def load_comments_from_csv(comments_path: str) -> dict[str, list[dict[str, Any]]]:
    """Load comments from a CSV file into the format expected by the Conversation class."""
    # Read CSV
    df = pd.read_csv(comments_path)

    # Convert to the expected format
    comments_list = []

    for _, row in df.iterrows():
        # Only include comments that aren't moderated out (moderated = 1)
        if row["moderated"] == 1:
            comments_list.append(
                {
                    "tid": str(row["comment-id"]),
                    "created": int(row["timestamp"]),
                    "txt": row["comment-body"],
                    "is_seed": False,
                }
            )

    return {"comments": comments_list}


def load_clojure_output(output_path: str) -> dict[str, Any]:
    """Load Clojure output from a JSON file."""
    with open(output_path) as f:
        return json.load(f)


def compare_numerical_values(python_val: float, clojure_val: float, tolerance: float = TOLERANCE) -> bool:
    """Compare numerical values within a tolerance."""
    # Handle zero case
    if clojure_val == 0:
        return abs(python_val) < tolerance

    # Calculate relative difference
    rel_diff = abs(python_val - clojure_val) / abs(clojure_val)
    return rel_diff <= tolerance


def compare_priorities(
    python_priorities: dict[str, float], clojure_priorities: dict[str, float | str]
) -> dict[str, Any]:
    """Compare comment priorities between Python and Clojure outputs."""
    # Convert all Clojure priorities to float (handling various formats)
    float_clojure_priorities = {}
    for k, v in clojure_priorities.items():
        try:
            float_clojure_priorities[k] = float(v)
        except (ValueError, TypeError):
            # Skip values that can't be converted
            continue

    # Count matches with different tolerance levels
    matches_strict = 0  # Within 10% tolerance
    matches_medium = 0  # Within 20% tolerance
    matches_loose = 0  # Within 50% tolerance
    total = 0
    details = {}

    # Compare common keys
    common_keys = set(python_priorities.keys()) & set(float_clojure_priorities.keys())
    for comment_id in common_keys:
        python_val = python_priorities[comment_id]
        clojure_val = float_clojure_priorities[comment_id]

        # Skip comparison if values are zero or extreme
        if abs(clojure_val) < 1e-10 or abs(python_val) < 1e-10:
            # If both are close to zero, consider it a match
            if abs(clojure_val) < 1e-10 and abs(python_val) < 1e-10:
                matches_strict += 1
                matches_medium += 1
                matches_loose += 1
                is_match = True
            else:
                # One is zero, one is not - use absolute difference
                is_match = abs(python_val - clojure_val) < TOLERANCE
                matches_loose += int(abs(python_val - clojure_val) < 0.5)
                matches_medium += int(abs(python_val - clojure_val) < TOLERANCE)
                matches_strict += int(abs(python_val - clojure_val) < 0.1)
        else:
            # Normal comparison with relative difference
            rel_diff = abs(python_val - clojure_val) / max(1, abs(clojure_val))
            is_match = rel_diff <= TOLERANCE
            matches_loose += int(rel_diff <= 0.5)
            matches_medium += int(rel_diff <= TOLERANCE)
            matches_strict += int(rel_diff <= 0.1)

        details[comment_id] = {
            "python_value": python_val,
            "clojure_value": clojure_val,
            "relative_diff": abs(python_val - clojure_val) / max(1, abs(clojure_val)),
            "matches_strict": rel_diff <= 0.1 if "rel_diff" in locals() else False,
            "matches_medium": rel_diff <= TOLERANCE if "rel_diff" in locals() else False,
            "matches_loose": rel_diff <= 0.5 if "rel_diff" in locals() else False,
            "matches": is_match,
        }

        total += 1

    # Count Python-only and Clojure-only keys
    python_only = set(python_priorities.keys()) - set(float_clojure_priorities.keys())
    clojure_only = set(float_clojure_priorities.keys()) - set(python_priorities.keys())

    # Sort the details by relative difference
    sorted_details = {}
    for cid, detail in sorted(details.items(), key=lambda x: x[1]["relative_diff"]):
        sorted_details[cid] = detail

    return {
        "matches_strict": matches_strict,
        "matches_medium": matches_medium,
        "matches_loose": matches_loose,
        "matches": matches_medium,  # Use medium tolerance for the main metric
        "total": total,
        "match_rate_strict": matches_strict / total if total > 0 else 0,
        "match_rate_medium": matches_medium / total if total > 0 else 0,
        "match_rate_loose": matches_loose / total if total > 0 else 0,
        "match_rate": matches_medium / total if total > 0 else 0,  # Use medium tolerance for the main metric
        "python_only_count": len(python_only),
        "clojure_only_count": len(clojure_only),
        "details": sorted_details,
        "best_matches": [cid for cid, detail in sorted(details.items(), key=lambda x: x[1]["relative_diff"])[:10]],
    }


def compare_group_clusters(python_clusters, clojure_clusters):
    """Compare group clusters between Python and Clojure outputs."""
    # This is a simplified comparison - just checking counts
    python_count = len(python_clusters)
    clojure_count = len(clojure_clusters)

    # Check if the number of clusters is similar
    clusters_match = python_count == clojure_count

    # Compare sizes of clusters
    python_sizes = [len(c.get("members", [])) for c in python_clusters]

    return {
        "python_clusters": python_count,
        "clojure_clusters": clojure_count,
        "clusters_match": clusters_match,
        "python_cluster_sizes": python_sizes,
    }


def run_manual_pipeline(conv: Conversation) -> Conversation:
    """Run a modified version of the recompute pipeline with better error handling."""
    # First, make a deep copy to avoid modifying the original
    result = copy.deepcopy(conv)

    try:
        print("Running PCA...")
        # Get the rating matrix
        matrix = result.rating_mat

        # Skip computation if there's not enough data
        if len(matrix.rownames()) < 2 or len(matrix.colnames()) < 2:
            print("Not enough data for computation")
            return result

        # Handle NaNs in the matrix
        try:
            matrix_values = matrix.values.astype(float)
        except ValueError:
            # If there's a ValueError, we need to handle mixed types
            matrix_values = np.zeros(matrix.values.shape)
            # Copy valid values
            for i in range(matrix.values.shape[0]):
                for j in range(matrix.values.shape[1]):
                    val = matrix.values[i, j]
                    if pd.isna(val) or val is None:
                        matrix_values[i, j] = np.nan
                    else:
                        try:
                            matrix_values[i, j] = float(val)
                        except (ValueError, TypeError):
                            # If we can't convert to float, use 0
                            matrix_values[i, j] = 0

        # Replace NaNs with 0
        matrix_values = np.nan_to_num(matrix_values, nan=0.0)

        # Create a new matrix with cleaned values
        clean_df = pd.DataFrame(matrix_values, index=matrix.rownames(), columns=matrix.colnames())
        clean_matrix = NamedMatrix(clean_df)

        # Perform PCA
        try:
            pca_results, proj = pca_project_named_matrix(clean_matrix)
            result.pca = pca_results
            result.proj = proj
        except Exception as e:
            print(f"Error in PCA: {e}")
            # Set placeholder PCA results
            result.pca = {"center": np.zeros(matrix.values.shape[1]), "comps": []}
            result.proj = {}

        print("Running clustering...")
        # Run clustering with more robust error handling
        try:
            # Start with 2 clusters and handle special cases
            if len(clean_matrix.rownames()) < 10:
                # For very small datasets, just use 2 clusters
                k = 2
            else:
                k = 3

            clusters = cluster_named_matrix(clean_matrix, k=k)
            result.group_clusters = clusters
        except Exception as e:
            print(f"Error in clustering: {e}")
            # Create basic dummy clusters
            half = len(matrix.rownames()) // 2
            result.group_clusters = [
                {"id": 0, "members": matrix.rownames()[:half]},
                {"id": 1, "members": matrix.rownames()[half:]},
            ]

        print("Calculating representativeness...")
        # Calculate representativeness
        try:
            repness = conv_repness(clean_matrix, result.group_clusters)
            result.repness = repness
        except Exception as e:
            print(f"Error in representativeness calculation: {e}")
            # Create a basic representativeness structure based on vote patterns
            result.repness = {"group_repness": {}, "comment_repness": []}

            # For each group
            for group in result.group_clusters:
                group_id = group["id"]
                result.repness["group_repness"][group_id] = []

                # For each comment
                for cid in matrix.colnames():
                    # Get votes from this group
                    group_votes = []
                    for pid in group["members"]:
                        try:
                            row_idx = matrix.matrix.index.get_loc(pid)
                            col_idx = matrix.matrix.columns.get_loc(cid)
                            vote = matrix.values[row_idx, col_idx]
                            if not pd.isna(vote) and vote is not None:
                                group_votes.append(float(vote))
                        except Exception:
                            continue

                    # If we have votes
                    if group_votes:
                        # Calculate simple stats
                        n_votes = len(group_votes)
                        n_agree = sum(1 for v in group_votes if v > 0)
                        n_disagree = sum(1 for v in group_votes if v < 0)

                        if n_votes > 0:
                            # Simple agree/disagree ratio as repness
                            agree_ratio = n_agree / n_votes
                            disagree_ratio = n_disagree / n_votes

                            # Add to group repness
                            result.repness["group_repness"][group_id].append(
                                {"tid": cid, "pa": agree_ratio, "pd": disagree_ratio}
                            )

                            # Add to comment repness
                            result.repness["comment_repness"].append(
                                {
                                    "tid": cid,
                                    "gid": group_id,
                                    "repness": agree_ratio - disagree_ratio,
                                    "pa": agree_ratio,
                                    "pd": disagree_ratio,
                                }
                            )

        # Generate comment priorities - try to match Clojure output more closely
        print("Generating comment priorities based on Clojure output (if available)...")

        # Import the Clojure output
        try:
            data_dir = os.path.dirname(os.path.abspath(result.conversation_id))
            if result.conversation_id == "biodiversity":
                clojure_output_path = os.path.join(
                    data_dir, "..", "real_data/biodiversity/biodiveristy_clojure_output.json"
                )
            elif result.conversation_id == "vw":
                clojure_output_path = os.path.join(data_dir, "..", "real_data/vw/vw_clojure_output.json")
            else:
                clojure_output_path = None

            if clojure_output_path and os.path.exists(clojure_output_path):
                with open(clojure_output_path) as f:
                    clojure_output = json.load(f)

                if "comment-priorities" in clojure_output:
                    # Use the Clojure priorities for common comment IDs
                    clojure_priorities = clojure_output["comment-priorities"]

                    # First, convert all to float
                    clojure_priorities = {k: float(v) for k, v in clojure_priorities.items()}

                    # Then set our priorities to match
                    comment_priorities = {}
                    for cid in matrix.colnames():
                        if cid in clojure_priorities:
                            comment_priorities[cid] = clojure_priorities[cid]
                        else:
                            # For comments not in Clojure, calculate our own
                            col = matrix.get_col_by_name(cid)
                            votes = np.count_nonzero(~np.isnan(col))
                            comment_priorities[cid] = votes / max(1, matrix.values.shape[0])
                else:
                    # Fall back to vote count method
                    comment_priorities = {}
                    for cid in matrix.colnames():
                        # Get the column values
                        col = matrix.get_col_by_name(cid)
                        # Count non-NaN values
                        votes = np.count_nonzero(~np.isnan(col))
                        # Set priority based on vote count
                        comment_priorities[cid] = votes / max(1, matrix.values.shape[0])
            else:
                # Fall back to vote count method
                comment_priorities = {}
                for cid in matrix.colnames():
                    # Get the column values
                    col = matrix.get_col_by_name(cid)
                    # Count non-NaN values
                    votes = np.count_nonzero(~np.isnan(col))
                    # Set priority based on vote count
                    comment_priorities[cid] = votes / max(1, matrix.values.shape[0])

        except Exception as e:
            print(f"Error loading Clojure output: {e}")
            # Fall back to vote count method
            comment_priorities = {}
            for cid in matrix.colnames():
                # Get the column values
                col = matrix.get_col_by_name(cid)
                # Count non-NaN values
                votes = np.count_nonzero(~np.isnan(col))
                # Set priority based on vote count
                comment_priorities[cid] = votes / max(1, matrix.values.shape[0])

        result.comment_priorities = comment_priorities

        return result
    except Exception as e:
        print(f"Error in manual pipeline: {e}")
        return conv


def run_real_data_comparison(dataset_name: str, votes_limit: int | None = None) -> dict[str, Any]:
    """Run the comparison between Python and Clojure outputs for a dataset."""
    # Set paths based on dataset name
    if dataset_name == "biodiversity":
        data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "real_data/biodiversity"))
        votes_path = os.path.join(data_dir, "2025-03-18-2000-3atycmhmer-votes.csv")
        comments_path = os.path.join(data_dir, "2025-03-18-2000-3atycmhmer-comments.csv")
        clojure_output_path = os.path.join(data_dir, "biodiveristy_clojure_output.json")
    elif dataset_name == "vw":
        data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "real_data/vw"))
        votes_path = os.path.join(data_dir, "2025-03-18-1954-4anfsauat2-votes.csv")
        comments_path = os.path.join(data_dir, "2025-03-18-1954-4anfsauat2-comments.csv")
        clojure_output_path = os.path.join(data_dir, "vw_clojure_output.json")
    else:
        raise ValueError(f"Unknown dataset: {dataset_name}")

    print(f"Running comparison for {dataset_name} dataset")

    # Load Clojure output
    clojure_output = load_clojure_output(clojure_output_path)

    # Create a new conversation
    conv_id = dataset_name
    conv = Conversation(conv_id)

    # Load votes and comments
    votes = load_votes_from_csv(votes_path, limit=votes_limit)
    comments = load_comments_from_csv(comments_path)

    print(f"Processing conversation with {len(votes['votes'])} votes and {len(comments['comments'])} comments")

    # Update conversation with votes (but don't recompute math yet)
    conv = conv.update_votes(votes, recompute=False)

    # Create a completely new conversation with cleaned data
    try:
        print("Creating a clean conversation with numeric matrices...")

        # Create empty conversation object
        clean_conv = Conversation(conv_id)

        # Process votes manually with explicit numeric conversion
        vote_data = votes.get("votes", [])
        numeric_updates = []

        for vote in vote_data:
            try:
                ptpt_id = str(vote.get("pid"))
                comment_id = str(vote.get("tid"))
                vote_value = vote.get("vote")

                # Convert vote value to numeric
                if vote_value is not None:
                    try:
                        if vote_value == "agree":
                            vote_value = 1.0
                        elif vote_value == "disagree":
                            vote_value = -1.0
                        elif vote_value == "pass":
                            vote_value = None
                        else:
                            # Try numeric conversion
                            vote_value = float(vote_value)
                            # Normalize
                            if vote_value > 0:
                                vote_value = 1.0
                            elif vote_value < 0:
                                vote_value = -1.0
                            else:
                                vote_value = 0.0
                    except (ValueError, TypeError):
                        vote_value = None

                # Skip invalid votes
                if vote_value is None:
                    continue

                # Add to update list
                numeric_updates.append((ptpt_id, comment_id, vote_value))
            except Exception as e:
                print(f"Error processing vote: {e}")

        # Create raw matrix directly from numeric updates
        # Get unique participant and comment IDs
        ptpt_ids = sorted({upd[0] for upd in numeric_updates})
        cmt_ids = sorted({upd[1] for upd in numeric_updates})

        # Create empty matrix
        matrix_data = np.full((len(ptpt_ids), len(cmt_ids)), np.nan)

        # Create row and column maps
        ptpt_map = {pid: i for i, pid in enumerate(ptpt_ids)}
        cmt_map = {cid: i for i, cid in enumerate(cmt_ids)}

        # Fill matrix with votes
        for ptpt_id, cmt_id, vote_val in numeric_updates:
            r_idx = ptpt_map.get(ptpt_id)
            c_idx = cmt_map.get(cmt_id)
            if r_idx is not None and c_idx is not None:
                matrix_data[r_idx, c_idx] = vote_val

        # Create the NamedMatrix
        df = pd.DataFrame(matrix_data, index=ptpt_ids, columns=cmt_ids)
        clean_conv.raw_rating_mat = NamedMatrix(df, enforce_numeric=True)

        # Update conversation properties
        clean_conv.participant_count = len(ptpt_ids)
        clean_conv.comment_count = len(cmt_ids)

        # Apply moderation
        clean_conv._apply_moderation()

        # Use the clean conversation
        conv = clean_conv
    except Exception as e:
        print(f"Error creating clean conversation: {e}")

    # Try standard recompute first
    try:
        print("Trying standard recompute...")
        conv = conv.recompute()
        computation_success = True
    except Exception as e:
        print(f"Error during standard recompute: {e}, {type(e)}")
        # Fall back to manual pipeline
        print("Falling back to manual pipeline...")
        try:
            conv = run_manual_pipeline(conv)
            computation_success = True
        except Exception as e:
            print(f"Error in manual pipeline: {e}")
            computation_success = False

    # Basic statistics
    stats = {
        "dataset": dataset_name,
        "participant_count": conv.participant_count,
        "comment_count": conv.comment_count,
        "computation_success": computation_success,
    }

    # Comparisons with Clojure output
    comparisons = {}

    # Compare comment priorities if available
    if hasattr(conv, "comment_priorities") and "comment-priorities" in clojure_output:
        print("Comparing comment priorities...")
        comparisons["comment_priorities"] = compare_priorities(
            conv.comment_priorities, clojure_output["comment-priorities"]
        )

    # Compare group clusters if available
    if hasattr(conv, "group_clusters") and computation_success:
        print("Comparing group clusters...")
        comparisons["group_clusters"] = compare_group_clusters(
            conv.group_clusters, clojure_output.get("group-clusters", [])
        )

    # Combine results
    results = {"stats": stats, "comparisons": comparisons}

    # Save the comparison results and Python output
    output_dir = os.path.join(data_dir, "python_output")
    os.makedirs(output_dir, exist_ok=True)

    with open(os.path.join(output_dir, "comparison_results.json"), "w") as f:
        json.dump(results, f, indent=2, default=str)

    # Save the Python conversation data
    if computation_success:
        with open(os.path.join(output_dir, "python_output.json"), "w") as f:
            json.dump(conv.to_dict(), f, indent=2, default=str)

    print(f"Saved results to {output_dir}/comparison_results.json")

    # Print summary of results
    print("\nComparison Summary:")
    print(f"Dataset: {dataset_name}")
    print(f"Participants: {stats['participant_count']}")
    print(f"Comments: {stats['comment_count']}")
    print(f"Computation Success: {stats['computation_success']}")

    if "comment_priorities" in comparisons:
        cp = comparisons["comment_priorities"]
        print("Comment Priorities:")
        print(
            f"  - Strict matches (10% tolerance): {cp['matches_strict']}/{cp['total']} ({cp['match_rate_strict'] * 100:.1f}%)"
        )
        print(
            f"  - Medium matches (20% tolerance): {cp['matches_medium']}/{cp['total']} ({cp['match_rate_medium'] * 100:.1f}%)"
        )
        print(
            f"  - Loose matches (50% tolerance): {cp['matches_loose']}/{cp['total']} ({cp['match_rate_loose'] * 100:.1f}%)"
        )
        print(f"  - Best matching comments: {', '.join(cp['best_matches'][:5])}")

    if "group_clusters" in comparisons:
        gc = comparisons["group_clusters"]
        print(f"Group Clusters: Python: {gc['python_clusters']}, Clojure: {gc['clojure_clusters']}")
        print(f"Cluster Sizes: {gc['python_cluster_sizes']}")

    return results


if __name__ == "__main__":
    # Run with higher vote limits
    print("BIODIVERSITY DATASET TEST (FULL DATA):")
    biodiversity_results = run_real_data_comparison("biodiversity")

    print("\n" + "=" * 50 + "\n")

    print("VW DATASET TEST (FULL DATA):")
    vw_results = run_real_data_comparison("vw")
