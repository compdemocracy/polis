#!/usr/bin/env python3
"""
Smoke tests for PCA implementation with real data.

Tests PCA functions directly (not through Conversation class) to verify
they work in isolation.

⚠️ WARNING: These are smoke tests only - they verify the code runs without
crashing, but do NOT validate correctness or compare against Clojure results.
"""

import pytest
import logging
import sys
import os
import numpy as np
import pandas as pd
from typing import Dict

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.pca_kmeans_rep.pca import pca_project_dataframe
from polismath.regression import get_dataset_files, list_available_datasets

logger = logging.getLogger(__name__)


class TestPCAImplementation:
    """
    Smoke tests for PCA implementation with real data.

    Tests PCA functions directly, bypassing the Conversation class.
    """

    @pytest.fixture(scope="class", autouse=True)
    def log_warning(self):
        """Log warning that these are smoke tests only."""
        logger.warning(
            "⚠️ These tests verify PCA functions run without crashing, "
            "but do NOT validate correctness or compare against Clojure results. "
            "For comparison tests, run test_real_data_comparison.py manually."
        )

    @pytest.fixture
    def vote_matrix(self, dataset_name: str) -> pd.DataFrame:
        """Load votes and create a DataFrame."""
        dataset_files = get_dataset_files(dataset_name)
        votes_path = dataset_files['votes']
        logger.debug(f"Loading votes from {votes_path}")

        df = pd.read_csv(votes_path)
        ptpt_ids = sorted(df['voter-id'].unique())
        cmt_ids = sorted(df['comment-id'].unique())
        logger.debug(f"Found {len(ptpt_ids)} participants, {len(cmt_ids)} comments")

        vote_matrix = np.full((len(ptpt_ids), len(cmt_ids)), np.nan)
        ptpt_map = {pid: i for i, pid in enumerate(ptpt_ids)}
        cmt_map = {cid: i for i, cid in enumerate(cmt_ids)}

        for _, row in df.iterrows():
            pid = row['voter-id']
            cid = row['comment-id']
            try:
                vote_val = float(row['vote'])
                if vote_val > 0:
                    vote_val = 1.0
                elif vote_val < 0:
                    vote_val = -1.0
                else:
                    vote_val = 0.0
            except ValueError:
                vote_text = str(row['vote']).lower()
                if vote_text == 'agree':
                    vote_val = 1.0
                elif vote_text == 'disagree':
                    vote_val = -1.0
                else:
                    vote_val = 0.0

            r_idx = ptpt_map[pid]
            c_idx = cmt_map[cid]
            vote_matrix[r_idx, c_idx] = vote_val

        df_matrix = pd.DataFrame(
            vote_matrix,
            index=[str(pid) for pid in ptpt_ids],
            columns=[str(cid) for cid in cmt_ids]
        )
        return df_matrix.apply(pd.to_numeric, errors='coerce')

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_pca_runs_without_error(self, dataset_name: str, vote_matrix):
        """Test PCA functions run successfully on real data (smoke test)."""
        logger.info(f"Testing PCA on {dataset_name} dataset")

        assert vote_matrix is not None
        assert vote_matrix.shape[0] > 0
        assert vote_matrix.shape[1] > 0

        logger.debug(f"Matrix shape: {vote_matrix.shape}")

        pca_results, projections = pca_project_dataframe(vote_matrix)

        assert pca_results is not None
        assert projections is not None
        assert 'center' in pca_results
        assert 'comps' in pca_results

        logger.debug(f"Center shape: {pca_results['center'].shape}")
        logger.debug(f"Components shape: {pca_results['comps'].shape}")
        logger.debug(f"Number of projections: {len(projections)}")

        logger.info(f"✓ PCA runs without error for {dataset_name}")

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_pca_projection_statistics(self, dataset_name: str, vote_matrix):
        """Test PCA projections have reasonable statistical properties."""
        logger.debug(f"Testing projection statistics for {dataset_name}")

        pca_results, projections = pca_project_dataframe(vote_matrix)
        proj_array = np.array(list(projections.values()))

        assert proj_array.ndim == 2
        assert proj_array.shape[1] >= 2

        x_mean = np.mean(proj_array[:, 0])
        y_mean = np.mean(proj_array[:, 1])
        x_std = np.std(proj_array[:, 0])
        y_std = np.std(proj_array[:, 1])

        logger.debug(f"X: mean={x_mean:.2f}, std={x_std:.2f}")
        logger.debug(f"Y: mean={y_mean:.2f}, std={y_std:.2f}")

        assert np.isfinite(x_mean) and np.isfinite(y_mean)
        assert np.isfinite(x_std) and np.isfinite(y_std)
        assert x_std > 0 or y_std > 0

        logger.debug(f"✓ Projection statistics validated")

    @pytest.mark.parametrize("dataset_name", list(list_available_datasets().keys()))
    def test_pca_with_clustering(self, dataset_name: str, vote_matrix):
        """Test PCA projections can be used for clustering."""
        logger.debug(f"Testing clustering for {dataset_name}")

        pca_results, projections = pca_project_dataframe(vote_matrix)
        proj_array = np.array(list(projections.values()))

        from sklearn.cluster import KMeans
        n_clusters = 3
        kmeans = KMeans(n_clusters=n_clusters, random_state=42)
        labels = kmeans.fit_predict(proj_array)

        assert labels is not None
        assert len(labels) == len(proj_array)

        for i in range(n_clusters):
            count = np.sum(labels == i)
            logger.debug(f"Cluster {i+1}: {count} participants")
            assert count > 0

        logger.debug(f"✓ Clustering completed")
