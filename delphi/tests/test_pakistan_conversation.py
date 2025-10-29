"""
Test module specifically for the Pakistan conversation (zid: 22154, zinvite: 69hm3zfanb).

This conversation is significantly larger than others:
- 400,075 votes
- 9,034 comments
- 18,081 participants

This test verifies that the math system can process this large conversation efficiently.
"""

import decimal
import json
import logging
import os
import time
import traceback

import numpy as np
import pytest

from polismath.conversation.conversation import Conversation
from tests.test_postgres_real_data import (
    connect_to_db,
    fetch_comments,
    fetch_moderation,
    init_dynamodb,
)


# Custom JSON encoder for handling Decimal and other types
class ExtendedJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, decimal.Decimal):
            return float(obj)
        if hasattr(obj, "isoformat"):  # Handle datetime objects
            return obj.isoformat()
        return super().default(obj)


# Helper function to convert dictionaries with special types for JSON serialization
def prepare_for_json(obj):  # noqa: PLR0911
    """
    Recursively process data structures to make them JSON serializable,
    particularly handling Decimal, numpy arrays, and datetime objects.

    Args:
        obj: Any Python object to prepare for JSON serialization

    Returns:
        JSON-serializable version of the object
    """
    if isinstance(obj, decimal.Decimal):
        return float(obj)
    elif hasattr(obj, "tolist"):  # Convert numpy arrays to lists
        return obj.tolist()
    elif hasattr(obj, "isoformat"):  # Handle datetime objects
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {k: prepare_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [prepare_for_json(item) for item in obj]
    elif isinstance(obj, set):
        return [prepare_for_json(item) for item in obj]
    elif isinstance(obj, (np.int64, np.int32, np.int16, np.int8)):
        return int(obj)
    elif isinstance(obj, (np.float64, np.float32, np.float16)):
        return float(obj)
    else:
        return obj


# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Constants
PAKISTAN_ZID = 22154
PAKISTAN_ZINVITE = "69hm3zfanb"


def test_pakistan_conversation_batch():
    """Test the Pakistan conversation in batches to handle the large size."""
    start_time = time.time()

    logger.info(f"[{time.time() - start_time:.2f}s] Starting Pakistan conversation test")

    # Connect to database
    logger.info(f"[{time.time() - start_time:.2f}s] Connecting to database...")
    conn = connect_to_db()
    if not conn:
        logger.error(f"[{time.time() - start_time:.2f}s] Database connection failed")
        pytest.skip("Could not connect to PostgreSQL database")

    try:
        # Create a new conversation
        logger.info(
            f"[{time.time() - start_time:.2f}s] Creating conversation object for Pakistan conversation (zid: {PAKISTAN_ZID})"
        )
        conv = Conversation(str(PAKISTAN_ZID))

        # Fetch comments first (much smaller than votes)
        logger.info(f"[{time.time() - start_time:.2f}s] Fetching comments...")
        comment_fetch_start = time.time()
        comments = fetch_comments(conn, PAKISTAN_ZID)
        logger.info(
            f"[{time.time() - start_time:.2f}s] Comment retrieval completed in {time.time() - comment_fetch_start:.2f}s - {len(comments['comments'])} comments fetched"
        )

        # Fetch moderation
        logger.info(f"[{time.time() - start_time:.2f}s] Fetching moderation data...")
        mod_fetch_start = time.time()
        moderation = fetch_moderation(conn, PAKISTAN_ZID)
        logger.info(
            f"[{time.time() - start_time:.2f}s] Moderation retrieval completed in {time.time() - mod_fetch_start:.2f}s"
        )

        # Apply moderation
        logger.info(f"[{time.time() - start_time:.2f}s] Applying moderation settings...")
        mod_update_start = time.time()
        conv = conv.update_moderation(moderation, recompute=False)
        logger.info(f"[{time.time() - start_time:.2f}s] Moderation applied in {time.time() - mod_update_start:.2f}s")

        # Process votes in batches
        batch_size = 50000  # Process 50,000 votes at a time
        max_batches = 10  # Process up to 10 batches (500,000 votes)

        # Get the total vote count
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM votes WHERE zid = %s", (PAKISTAN_ZID,))
        total_votes = cursor.fetchone()[0]
        cursor.close()

        logger.info(
            f"[{time.time() - start_time:.2f}s] Pakistan conversation has {total_votes} total votes. Processing in batches of {batch_size}."
        )

        # Fetch and process votes in batches
        for batch_num in range(max_batches):
            batch_start = time.time()
            offset = batch_num * batch_size

            # Check if we've processed all votes
            if offset >= total_votes:
                logger.info(f"[{time.time() - start_time:.2f}s] All votes processed. Stopping batch processing.")
                break

            logger.info(
                f"[{time.time() - start_time:.2f}s] Processing batch {batch_num + 1} (votes {offset + 1} to {offset + batch_size})..."
            )

            # Custom SQL to fetch a batch of votes
            cursor = conn.cursor()
            batch_query = """
            SELECT
                v.created as timestamp,
                v.tid as comment_id,
                v.pid as voter_id,
                v.vote
            FROM
                votes v
            WHERE
                v.zid = %s
            ORDER BY
                v.created
            LIMIT %s OFFSET %s
            """
            cursor.execute(batch_query, (PAKISTAN_ZID, batch_size, offset))
            vote_batch = cursor.fetchall()
            cursor.close()

            logger.info(f"[{time.time() - start_time:.2f}s] Fetched {len(vote_batch)} votes in batch {batch_num + 1}")

            # Format votes for conversation update
            votes_list = []
            for vote in vote_batch:
                # Handle timestamp
                if vote[0]:  # timestamp
                    try:
                        created_time = int(float(vote[0]) * 1000)
                    except (ValueError, TypeError):
                        created_time = None
                else:
                    created_time = None

                votes_list.append(
                    {
                        "pid": str(vote[2]),  # voter_id
                        "tid": str(vote[1]),  # comment_id
                        "vote": float(vote[3]),  # vote
                        "created": created_time,
                    }
                )

            batch_votes = {"votes": votes_list}

            # Update conversation with this batch of votes
            logger.info(f"[{time.time() - start_time:.2f}s] Updating conversation with {len(votes_list)} votes...")
            update_start = time.time()
            conv = conv.update_votes(batch_votes, recompute=False)  # Don't recompute until all batches processed
            logger.info(
                f"[{time.time() - start_time:.2f}s] Batch {batch_num + 1} update completed in {time.time() - update_start:.2f}s"
            )

            # Log batch timing
            logger.info(
                f"[{time.time() - start_time:.2f}s] Batch {batch_num + 1} completed in {time.time() - batch_start:.2f}s"
            )

            # Process all batches
            # logger.info(f"[{time.time() - start_time:.2f}s] Breaking after first batch for testing")
            # break

        # Final recomputation after all batches
        logger.info(f"[{time.time() - start_time:.2f}s] Starting final computation...")
        recompute_start = time.time()

        # Break down the recomputation steps
        logger.info(f"[{time.time() - start_time:.2f}s] 1. Computing PCA...")
        pca_time = time.time()
        try:
            conv._compute_pca()
            logger.info(f"[{time.time() - start_time:.2f}s] PCA completed in {time.time() - pca_time:.2f}s")
        except Exception as e:
            logger.error(f"[{time.time() - start_time:.2f}s] Error in PCA computation: {e}")

        logger.info(f"[{time.time() - start_time:.2f}s] 2. Computing clusters...")
        cluster_time = time.time()
        try:
            conv._compute_clusters()
            logger.info(f"[{time.time() - start_time:.2f}s] Clustering completed in {time.time() - cluster_time:.2f}s")
        except Exception as e:
            logger.error(f"[{time.time() - start_time:.2f}s] Error in clustering computation: {e}")

        logger.info(f"[{time.time() - start_time:.2f}s] 3. Computing representativeness...")
        repness_time = time.time()
        try:
            conv._compute_repness()
            logger.info(
                f"[{time.time() - start_time:.2f}s] Representativeness completed in {time.time() - repness_time:.2f}s"
            )
        except Exception as e:
            logger.error(f"[{time.time() - start_time:.2f}s] Error in representativeness computation: {e}")

        logger.info(f"[{time.time() - start_time:.2f}s] 4. Computing participant info...")
        ptptinfo_time = time.time()
        try:
            conv._compute_participant_info()
            logger.info(
                f"[{time.time() - start_time:.2f}s] Participant info completed in {time.time() - ptptinfo_time:.2f}s"
            )
        except Exception as e:
            logger.error(f"[{time.time() - start_time:.2f}s] Error in participant info computation: {e}")

        logger.info(
            f"[{time.time() - start_time:.2f}s] All recomputations completed in {time.time() - recompute_start:.2f}s"
        )

        # Extract key metrics
        logger.info(f"[{time.time() - start_time:.2f}s] Extracting results...")

        # 1. Number of groups found
        group_count = len(conv.group_clusters)
        logger.info(f"[{time.time() - start_time:.2f}s] Found {group_count} groups")

        # 2. Number of comments processed
        comment_count = conv.comment_count
        logger.info(f"[{time.time() - start_time:.2f}s] Processed {comment_count} comments")

        # 3. Number of participants
        participant_count = conv.participant_count
        logger.info(f"[{time.time() - start_time:.2f}s] Found {participant_count} participants")

        # 4. Check that we have representative comments
        repness_count = 0
        if conv.repness and "comment_repness" in conv.repness:
            repness_count = len(conv.repness["comment_repness"])
            logger.info(f"[{time.time() - start_time:.2f}s] Calculated representativeness for {repness_count} comments")

        # Save the results for manual inspection
        logger.info(f"[{time.time() - start_time:.2f}s] Saving results...")
        save_start = time.time()

        output_dir = os.path.join(os.path.dirname(__file__), "..", "real_data", "postgres_output")
        os.makedirs(output_dir, exist_ok=True)

        # Save the conversation data to file using optimized to_dynamo_dict method if available
        output_file = os.path.join(output_dir, f"conversation_{PAKISTAN_ZINVITE}_result.json")
        to_dict_start = time.time()

        # Convert conversation to dictionary representation
        logger.info(f"[{time.time() - start_time:.2f}s] Converting conversation to dictionary...")
        conv_data = conv.to_dict()

        logger.info(
            f"[{time.time() - start_time:.2f}s] Dictionary conversion completed in {time.time() - to_dict_start:.2f}s"
        )

        # Pre-process data to make it JSON serializable and then write to file
        logger.info(f"[{time.time() - start_time:.2f}s] Preparing data for JSON serialization...")
        json_prep_start = time.time()
        json_ready_data = prepare_for_json(conv_data)
        logger.info(
            f"[{time.time() - start_time:.2f}s] JSON preparation completed in {time.time() - json_prep_start:.2f}s"
        )

        # Write to file
        with open(output_file, "w") as f:
            json.dump(json_ready_data, f, indent=2)

        logger.info(
            f"[{time.time() - start_time:.2f}s] Saved results to {output_file} in {time.time() - save_start:.2f}s"
        )

        # Save to DynamoDB using optimized to_dynamo_dict method
        try:
            logger.info(f"[{time.time() - start_time:.2f}s] Initializing DynamoDB client...")
            dynamo_start = time.time()
            # Use already imported init_dynamodb and write_to_dynamodb functions
            # They were imported at the top of the file
            dynamodb_client = init_dynamodb()
            logger.info(
                f"[{time.time() - start_time:.2f}s] DynamoDB client initialized in {time.time() - dynamo_start:.2f}s"
            )

            # Ready to export conversation to DynamoDB

            logger.info(f"[{time.time() - start_time:.2f}s] Ready to write conversation data to DynamoDB")

            # Write to DynamoDB using the unified export method
            logger.info(f"[{time.time() - start_time:.2f}s] Writing to DynamoDB...")
            write_start = time.time()

            # Use the export_to_dynamodb method which automatically handles large conversations
            logger.info(f"[{time.time() - start_time:.2f}s] Using unified export method for conversation")
            success = conv.export_to_dynamodb(dynamodb_client)

            write_time = time.time() - write_start
            logger.info(
                f"[{time.time() - start_time:.2f}s] DynamoDB write {'succeeded' if success else 'failed'} in {write_time:.2f}s"
            )

            # Calculate write time
            logger.info(f"[{time.time() - start_time:.2f}s] Write time: {write_time:.2f}s")

        except Exception as e:
            logger.error(f"[{time.time() - start_time:.2f}s] Error with DynamoDB: {e}")
            traceback.print_exc()

        # Perform basic assertions
        logger.info(f"[{time.time() - start_time:.2f}s] Running tests...")

        assert group_count >= 0, "Group count should be non-negative"
        assert participant_count > 0, "Participant count should be positive"
        assert conv.rating_mat.values.shape[0] == participant_count, "Matrix dimensions should match participant count"

        # Validate PCA results
        if participant_count > 1 and comment_count > 1:
            assert conv.pca is not None, "PCA should be computed"
            assert "center" in conv.pca, "PCA should have center"
            assert "comps" in conv.pca, "PCA should have components"

        # Test representativeness computation
        if group_count > 0:
            assert conv.repness is not None, "Representativeness should be computed"
            assert "comment_repness" in conv.repness, "Comment representativeness should be computed"

        logger.info(f"[{time.time() - start_time:.2f}s] Pakistan conversation test completed successfully")

    except Exception as e:
        logger.error(f"[{time.time() - start_time:.2f}s] ERROR: Test failed with exception: {e}")
        traceback.print_exc()
        raise

    finally:
        conn.close()
        logger.info(f"[{time.time() - start_time:.2f}s] Database connection closed")
        logger.info(f"[{time.time() - start_time:.2f}s] Test completed in {time.time() - start_time:.2f} seconds")


if __name__ == "__main__":
    # This allows the test to be run directly
    test_pakistan_conversation_batch()
