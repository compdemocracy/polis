#!/usr/bin/env python3
"""
Smoke tests for representativeness calculation with real data.

Tests representativeness functions directly (not through full Conversation class
pipeline) to verify they work in isolation.

⚠️ WARNING: These are smoke tests only - they verify the code runs without
crashing, but do NOT validate correctness or compare against Clojure results.
"""

import pytest
import logging
import sys
import os
from typing import Dict

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.repness import conv_repness, participant_stats
from common_utils import create_test_conversation
from polismath.regression import list_available_datasets

logger = logging.getLogger(__name__)


class TestRepnessImplementation:
    """
    Smoke tests for representativeness implementation with real data.

    Tests representativeness functions directly, bypassing full pipeline.
    """

    @pytest.fixture(scope="class", autouse=True)
    def log_warning(self):
        """Log warning that these are smoke tests only."""
        logger.warning(
            "⚠️ These tests verify representativeness functions run without crashing, "
            "but do NOT validate correctness or compare against Clojure results. "
            "For comparison tests, run test_repness_comparison.py manually."
        )

    @pytest.fixture
    def conversation(self, dataset_name: str):
        """Create conversation with PCA and clustering computed."""
        logger.debug(f"Creating conversation for {dataset_name}")
        conv = create_test_conversation(dataset_name)

        logger.debug(f"Participants: {conv.participant_count}, Comments: {conv.comment_count}")
        logger.debug(f"Matrix shape: {conv.rating_mat.values.shape}")

        # Run PCA and clustering (needed for repness)
        logger.debug("Computing PCA and clustering...")
        conv._compute_pca()
        conv._compute_clusters()

        logger.debug(f"Number of clusters: {len(conv.group_clusters)}")

        return conv

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_repness_runs_without_error(self, dataset_name: str, conversation):
        """Test representativeness calculation runs successfully on real data (smoke test)."""
        logger.info(f"Testing representativeness on {dataset_name} dataset")

        assert conversation is not None
        assert conversation.rating_mat is not None
        assert conversation.group_clusters is not None
        assert len(conversation.group_clusters) > 0

        # Run representativeness calculation
        repness_results = conv_repness(conversation.rating_mat, conversation.group_clusters)

        assert repness_results is not None
        assert 'comment_ids' in repness_results
        assert 'group_repness' in repness_results
        assert len(repness_results['comment_ids']) > 0
        assert len(repness_results['group_repness']) > 0

        logger.debug(f"Comment IDs: {len(repness_results['comment_ids'])}")
        logger.debug(f"Groups with repness: {len(repness_results['group_repness'])}")

        logger.info(f"✓ Representativeness runs without error for {dataset_name}")

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_repness_structure(self, dataset_name: str, conversation):
        """Test representativeness results have expected structure."""
        logger.debug(f"Testing representativeness structure for {dataset_name}")

        repness_results = conv_repness(conversation.rating_mat, conversation.group_clusters)

        # Check structure of group_repness
        for group_id, comments in repness_results['group_repness'].items():
            assert isinstance(comments, list)
            assert len(comments) > 0

            # Check structure of first comment
            if len(comments) > 0:
                comment = comments[0]
                assert 'comment_id' in comment
                assert 'repful' in comment  # 'agree', 'disagree', or other type
                logger.debug(f"Group {group_id}: {len(comments)} representative comments")

        # Check consensus comments if present
        if 'consensus_comments' in repness_results:
            consensus = repness_results['consensus_comments']
            logger.debug(f"Consensus comments: {len(consensus)}")

            if len(consensus) > 0:
                comment = consensus[0]
                assert 'comment_id' in comment

        logger.debug("✓ Representativeness structure validated")

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_participant_stats(self, dataset_name: str, conversation):
        """Test participant statistics calculation."""
        logger.debug(f"Testing participant stats for {dataset_name}")

        ptpt_stats = participant_stats(conversation.rating_mat, conversation.group_clusters)

        assert ptpt_stats is not None
        assert 'participant_ids' in ptpt_stats
        assert 'stats' in ptpt_stats
        assert len(ptpt_stats['participant_ids']) > 0
        assert len(ptpt_stats['stats']) > 0

        logger.debug(f"Participant IDs: {len(ptpt_stats['participant_ids'])}")
        logger.debug(f"Participants with stats: {len(ptpt_stats['stats'])}")

        # Check structure of first participant
        sample_id = list(ptpt_stats['stats'].keys())[0]
        ptpt_data = ptpt_stats['stats'][sample_id]

        assert 'group' in ptpt_data
        assert 'n_votes' in ptpt_data
        assert 'n_agree' in ptpt_data
        assert 'n_disagree' in ptpt_data
        assert 'n_pass' in ptpt_data
        assert 'group_correlations' in ptpt_data

        logger.debug(f"Sample participant {sample_id}: group={ptpt_data['group']}, votes={ptpt_data['n_votes']}")

        logger.debug("✓ Participant statistics validated")
