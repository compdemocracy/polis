#!/usr/bin/env python3
"""
Legacy: Comparison with Clojure implementation. Will be removed once Clojure is phased out.

Comparison tests for representativeness calculation between Python and Clojure.

⚠️ WARNING: These tests compare Python implementation against Clojure reference
results, but the results are known to be quite different. These tests
verify structural compatibility and provide visibility into differences, but
do NOT validate correctness through assertions on match rates.
"""

import pytest
import logging
import sys
import os
from typing import Dict, Any, Tuple

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.repness import conv_repness, participant_stats
from common_utils import create_test_conversation
from polismath.regression import get_dataset_files, list_available_datasets
import json

logger = logging.getLogger(__name__)


class TestRepnessComparison:
    """
    Comparison tests for representativeness implementation vs Clojure reference.

    These tests compare Python and Clojure implementations structurally but
    do not assert on match rates, as the results are known to differ significantly.
    """

    @pytest.fixture(scope="class", autouse=True)
    def log_warning(self):
        """Log warning that these are comparison tests with known differences."""
        logger.warning(
            "⚠️ These tests compare Python vs Clojure representativeness implementations. "
            "The results are known to be quite different. Tests verify structural "
            "compatibility and report differences for visibility, but do NOT validate "
            "correctness through match rate assertions."
        )

    @pytest.fixture
    def clojure_results(self, dataset_name: str) -> Dict[str, Any]:
        """Load Clojure reference results from file."""
        dataset_files = get_dataset_files(dataset_name)
        json_path = dataset_files['math_blob']

        if not os.path.exists(json_path):
            logger.warning(f"Clojure output file {json_path} not found!")
            return {}

        with open(json_path, 'r') as f:
            return json.load(f)

    @pytest.fixture
    def conversation(self, dataset_name: str):
        """Create conversation with PCA and clustering computed."""
        logger.debug(f"Creating conversation for {dataset_name}")
        conv = create_test_conversation(dataset_name)

        logger.debug(f"Participants: {conv.participant_count}, Comments: {conv.comment_count}")

        # Run PCA and clustering (needed for repness)
        logger.debug("Computing PCA and clustering...")
        conv._compute_pca()
        conv._compute_clusters()

        logger.debug(f"Number of clusters: {len(conv.group_clusters)}")

        return conv

    @pytest.fixture
    def python_results(self, conversation):
        """Compute Python representativeness results."""
        logger.debug("Running representativeness calculation...")
        return conv_repness(conversation.rating_mat, conversation.group_clusters)

    def _compare_results(self, py_results: Dict[str, Any], clj_results: Dict[str, Any]) -> Tuple[float, Dict[str, Any]]:
        """
        Compare Python and Clojure representativeness results.

        Args:
            py_results: Python representativeness results
            clj_results: Clojure representativeness results

        Returns:
            Tuple of (match_rate, stats_dict)
        """
        if not clj_results:
            logger.info("No Clojure results to compare with.")
            return 0.0, {}

        # Initialize comparison stats
        stats = {
            'total_comments': 0,
            'comment_matches': 0,
            'group_match_rates': {},
            'consensus_match_rate': 0.0,
            'top_matching_comments': []
        }

        # Extract Clojure group repness data
        if 'group-clusters' in clj_results and 'repness' in clj_results:
            clj_repness = clj_results['repness']
            clj_group_clusters = clj_results['group-clusters']

            # Map Clojure group IDs to Python group IDs (assuming same order)
            group_id_map = {}
            for i, clj_group in enumerate(clj_group_clusters):
                clj_group_id = clj_group.get('id', i)
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
                py_group_repness = py_results.get('group_repness', {}).get(py_group_id_int, [])

                if not isinstance(clj_group_repness, list):
                    # Skip non-list items
                    continue

                # Extract comment IDs from both results
                clj_comment_ids = [str(c.get('tid', c.get('comment_id', ''))) for c in clj_group_repness]
                py_comment_ids = [str(c.get('comment_id', '')) for c in py_group_repness]

                # Count matches
                matches = set(clj_comment_ids) & set(py_comment_ids)
                total = len(set(clj_comment_ids) | set(py_comment_ids))

                if total > 0:
                    match_rate = len(matches) / total
                else:
                    match_rate = 0.0

                stats['group_match_rates'][py_group_id] = match_rate
                stats['total_comments'] += total
                stats['comment_matches'] += len(matches)

                # Find top matching comments
                for cid in matches:
                    # Get comment data from both results
                    clj_comment = next((c for c in clj_group_repness if str(c.get('tid', c.get('comment_id', ''))) == cid), {})
                    py_comment = next((c for c in py_group_repness if str(c.get('comment_id', '')) == cid), {})

                    # Extract values from Clojure comment (handle different key formats)
                    if 'p-success' in clj_comment:
                        clj_agree = clj_comment.get('p-success', 0)
                        clj_disagree = 1 - clj_agree
                    else:
                        clj_agree = clj_comment.get('pa', 0)
                        clj_disagree = clj_comment.get('pd', 0)

                    # Extract repness values
                    clj_repness_val = clj_comment.get('repness', 0)
                    clj_repness_test = clj_comment.get('repness-test', 0)

                    stats['top_matching_comments'].append({
                        'comment_id': cid,
                        'group_id': py_group_id,
                        'clojure': {
                            'agree': clj_agree,
                            'disagree': clj_disagree,
                            'repness': clj_repness_val,
                            'repness_test': clj_repness_test
                        },
                        'python': {
                            'agree': py_comment.get('pa', 0),
                            'disagree': py_comment.get('pd', 0),
                            'agree_metric': py_comment.get('agree_metric', 0),
                            'disagree_metric': py_comment.get('disagree_metric', 0)
                        }
                    })

            # Look for consensus comments if they exist
            if 'consensus-comments' in clj_repness:
                clj_consensus = clj_repness.get('consensus-comments', [])
                py_consensus = py_results.get('consensus_comments', [])

                # Extract comment IDs
                clj_consensus_ids = [str(c.get('comment-id', c.get('tid', c.get('comment_id', '')))) for c in clj_consensus]
                py_consensus_ids = [str(c.get('comment_id', '')) for c in py_consensus]

                consensus_matches = set(clj_consensus_ids) & set(py_consensus_ids)
                consensus_total = len(set(clj_consensus_ids) | set(py_consensus_ids))

                if consensus_total > 0:
                    stats['consensus_match_rate'] = len(consensus_matches) / consensus_total
                else:
                    stats['consensus_match_rate'] = 0.0

                stats['total_comments'] += consensus_total
                stats['comment_matches'] += len(consensus_matches)

        # Calculate overall match rate
        overall_match_rate = stats['comment_matches'] / stats['total_comments'] if stats['total_comments'] > 0 else 0.0

        return overall_match_rate, stats

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_structural_compatibility(self, dataset_name: str, python_results, clojure_results):
        """Test that Python and Clojure results have compatible structure."""
        logger.info(f"Testing structural compatibility for {dataset_name} dataset")

        # Verify Python results structure
        assert python_results is not None
        assert 'comment_ids' in python_results
        assert 'group_repness' in python_results

        # Verify we can compare (Clojure results exist and have expected structure)
        if clojure_results:
            assert 'repness' in clojure_results or 'group-clusters' in clojure_results
            logger.debug(f"✓ Both Python and Clojure results have compatible structure")
        else:
            logger.warning(f"No Clojure results available for {dataset_name}")

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_comparison_visibility(self, dataset_name: str, python_results, clojure_results):
        """
        Compare Python and Clojure results for visibility into differences.

        Note: This test does NOT assert on match rates, as implementations are
        known to be very different. It reports statistics for manual inspection.
        """
        logger.info(f"Comparing representativeness for {dataset_name} dataset")

        if not clojure_results:
            logger.warning(f"No Clojure results available for {dataset_name}. Skipping comparison.")
            pytest.skip(f"No Clojure results for {dataset_name}")
            return

        # Perform comparison
        match_rate, stats = self._compare_results(python_results, clojure_results)

        # Log comparison results (for visibility, not assertions)
        logger.info(f"Comparison results for {dataset_name}:")
        logger.info(f"  - Overall: {stats['comment_matches']} / {stats['total_comments']} comments match")
        logger.info(f"  - Note: Python and Clojure implementations are known to be very different")

        logger.debug(f"Group match rates:")
        for group_id, rate in stats['group_match_rates'].items():
            logger.debug(f"  - Group {group_id}: {rate:.2f}")

        logger.debug(f"Consensus comments match rate: {stats['consensus_match_rate']:.2f}")

        # Log sample matching comments for inspection
        if stats['top_matching_comments']:
            logger.debug(f"Sample matching comments (first 3):")
            for i, comment in enumerate(stats['top_matching_comments'][:3]):
                cid = comment['comment_id']
                gid = comment['group_id']
                logger.debug(f"  - Comment {cid} (Group {gid}):")
                logger.debug(f"    Clojure: Agree={comment['clojure']['agree']:.2f}, Disagree={comment['clojure']['disagree']:.2f}")
                logger.debug(f"    Python:  Agree={comment['python']['agree']:.2f}, Disagree={comment['python']['disagree']:.2f}")

        # Log Python results summary
        logger.debug(f"Python representativeness summary:")
        for group_id, comments in python_results.get('group_repness', {}).items():
            if comments:
                logger.debug(f"  - Group {group_id}: {len(comments)} comments")
                for i, cmt in enumerate(comments[:2]):  # Show top 2
                    logger.debug(f"    Comment {i+1}: ID {cmt.get('comment_id')}, Type: {cmt.get('repful')}")
                    logger.debug(f"      Agree: {cmt.get('pa', 0):.2f}, Disagree: {cmt.get('pd', 0):.2f}")

        logger.info(f"✓ Comparison completed for {dataset_name}")
