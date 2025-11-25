"""
Core mathematical algorithms for PCA, K-means clustering and representativeness.

This module contains implementations of:
- Principal Component Analysis (PCA)
- K-means clustering
- Representativeness calculation
- Correlation analysis
"""

from polismath.pca_kmeans_rep.pca import pca_project_dataframe
from polismath.pca_kmeans_rep.clusters import cluster_dataframe, Cluster
from polismath.pca_kmeans_rep.repness import conv_repness, participant_stats
from polismath.pca_kmeans_rep.corr import compute_correlation

__all__ = [
    'pca_project_dataframe',
    'cluster_dataframe',
    'Cluster',
    'conv_repness',
    'participant_stats',
    'compute_correlation',
]