"""
Simplified tests for the conversion with real data from conversations.
This focuses only on vote loading and matrix creation without advanced math.
"""

import json
import os
import sys

import pandas as pd

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from polismath.conversation.conversation import Conversation


def load_votes(votes_path):
    """Load votes from a CSV file into a format suitable for conversion."""
    # Read CSV
    df = pd.read_csv(votes_path)

    # Convert to the format expected by the Conversation class
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


def test_biodiversity_conversation_simple():
    """Test conversation processing with the biodiversity dataset."""
    # Paths to dataset files
    data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "real_data/biodiversity"))
    votes_path = os.path.join(data_dir, "2025-03-18-2000-3atycmhmer-votes.csv")

    # Create a new conversation
    conv_id = "biodiversity"
    conv = Conversation(conv_id)

    # Load votes - only read a smaller subset
    df = pd.read_csv(votes_path, nrows=1000)  # Read only 1000 votes
    votes = {"votes": []}

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

        votes["votes"].append({"pid": pid, "tid": tid, "vote": vote_val})

    # Update conversation with votes, but don't recompute yet
    print(f"Processing conversation with {len(votes['votes'])} votes")
    conv = conv.update_votes(votes, recompute=False)

    # Check the raw rating matrix
    print(
        f"Created rating matrix with {len(conv.raw_rating_mat.rownames())} participants and {len(conv.raw_rating_mat.colnames())} comments"
    )

    # Save the raw rating matrix for examination
    output_dir = os.path.join(data_dir, "python_output")
    os.makedirs(output_dir, exist_ok=True)

    # Save basic conversation info
    basic_info = {
        "conversation_id": conv.conversation_id,
        "participant_count": conv.participant_count,
        "comment_count": conv.comment_count,
        "participants": conv.raw_rating_mat.rownames(),
        "comments": conv.raw_rating_mat.colnames(),
    }

    with open(os.path.join(output_dir, "basic_info.json"), "w") as f:
        json.dump(basic_info, f, indent=2, default=list)

    print(f"Saved basic info to {output_dir}/basic_info.json")

    # Try a simple manual cluster without using the complex math
    print("\nTrying a simple manual clustering...")

    # Create fixed clusters (just for testing)
    group_clusters = [
        {"id": 0, "members": conv.raw_rating_mat.rownames()[:5]},
        {"id": 1, "members": conv.raw_rating_mat.rownames()[5:10]},
    ]

    print(f"Created {len(group_clusters)} test clusters")
    for i, cluster in enumerate(group_clusters):
        print(f"  - Cluster {i}: {len(cluster['members'])} participants")

    # Return success
    print("\nSimple test completed successfully!")
    return True


if __name__ == "__main__":
    test_biodiversity_conversation_simple()
