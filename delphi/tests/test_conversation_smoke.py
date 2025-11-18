#!/usr/bin/env python3
"""
Tests for the Conversation class with real data.

⚠️ WARNING: These are smoke tests only - they verify the code runs without
crashing, but do NOT compare results against Clojure or validate correctness.
"""

import pytest
import logging
import sys
import os

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from common_utils import create_test_conversation
from polismath.regression import list_available_datasets

logger = logging.getLogger(__name__)


class TestConversationWithRealData:
    """Smoke tests for Conversation class with real data."""

    @pytest.fixture(scope="class", autouse=True)
    def log_warning(self):
        """Log warning that these are smoke tests only."""
        logger.warning(
            "⚠️ These tests verify the Conversation class runs without crashing, "
            "but do NOT validate correctness or compare against Clojure results. "
            "For comparison tests, run test_real_data_comparison.py manually."
        )

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_conversation_recompute(self, dataset_name: str):
        """
        Test that Conversation.recompute() runs successfully on real data.

        This is a smoke test - it only verifies the code doesn't crash,
        not that the results are correct.

        Args:
            dataset_name: Name of the dataset ('biodiversity' or 'vw')
        """
        logger.info(f"Testing Conversation with {dataset_name} dataset")

        # Create a conversation with the dataset
        logger.debug("Creating conversation...")
        conv = create_test_conversation(dataset_name)

        # Assert conversation was created
        assert conv is not None, f"Failed to create conversation for {dataset_name}"
        assert conv.participant_count > 0, "No participants in conversation"
        assert conv.comment_count > 0, "No comments in conversation"

        logger.debug(f"Conversation created successfully")
        logger.debug(f"Participants: {conv.participant_count}")
        logger.debug(f"Comments: {conv.comment_count}")
        logger.debug(f"Matrix shape: {conv.rating_mat.values.shape}")

        # Recompute the conversation
        logger.debug("Running recompute...")
        updated_conv = conv.recompute()

        # Assert recompute returned a conversation
        assert updated_conv is not None, "recompute() returned None"

        # Check PCA results exist
        assert hasattr(updated_conv, 'pca'), "No PCA results after recompute"
        assert 'center' in updated_conv.pca, "PCA missing 'center'"
        assert 'comps' in updated_conv.pca, "PCA missing 'comps'"

        logger.debug(f"PCA Results:")
        logger.debug(f"  - Center shape: {updated_conv.pca['center'].shape}")
        logger.debug(f"  - Components shape: {updated_conv.pca['comps'].shape}")
        logger.debug(f"  - Projections count: {len(updated_conv.proj)}")

        # Check clustering results exist
        assert hasattr(updated_conv, 'group_clusters'), "No group_clusters after recompute"
        assert len(updated_conv.group_clusters) > 0, "No clusters created"

        logger.debug(f"Clustering Results:")
        logger.debug(f"  - Number of clusters: {len(updated_conv.group_clusters)}")
        for i, cluster in enumerate(updated_conv.group_clusters):
            assert 'members' in cluster, f"Cluster {i} missing 'members'"
            logger.debug(f"  - Cluster {i+1}: {len(cluster['members'])} participants")

        logger.info(f"✓ Conversation recompute successful for {dataset_name}")

    def test_conversation_structure(self):
        """Test that conversation has expected structure after creation."""
        dataset_name = 'biodiversity'  # Use first available dataset
        logger.debug(f"Testing conversation structure with {dataset_name}")

        conv = create_test_conversation(dataset_name)

        # Check expected attributes exist
        assert hasattr(conv, 'rating_mat'), "Conversation missing 'rating_mat'"
        assert hasattr(conv, 'participant_count'), "Conversation missing 'participant_count'"
        assert hasattr(conv, 'comment_count'), "Conversation missing 'comment_count'"

        # Check matrix structure
        assert conv.rating_mat.values.ndim == 2, "Rating matrix is not 2D"
        n_participants, n_comments = conv.rating_mat.values.shape
        assert n_participants == conv.participant_count, "Participant count mismatch"
        assert n_comments == conv.comment_count, "Comment count mismatch"

        logger.debug(f"✓ Conversation structure validated")

    def test_pca_dimensionality(self):
        """Test that PCA produces expected dimensionality."""
        dataset_name = 'biodiversity'
        logger.debug(f"Testing PCA dimensionality with {dataset_name}")

        conv = create_test_conversation(dataset_name)
        updated_conv = conv.recompute()

        # Check PCA dimensions
        n_comments = conv.comment_count
        center_shape = updated_conv.pca['center'].shape
        comps_shape = updated_conv.pca['comps'].shape

        assert center_shape[0] == n_comments, \
            f"PCA center dimension {center_shape[0]} != comment count {n_comments}"

        assert comps_shape[1] == n_comments, \
            f"PCA components dimension {comps_shape[1]} != comment count {n_comments}"

        # Check projections
        n_participants = conv.participant_count
        assert len(updated_conv.proj) == n_participants, \
            f"Number of projections {len(updated_conv.proj)} != participants {n_participants}"

        logger.debug(f"✓ PCA dimensionality validated")
