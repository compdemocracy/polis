"""
Core mathematical algorithms for PCA, K-means clustering and representativeness.

This module contains implementations of:
- Principal Component Analysis (PCA)
- K-means clustering
- Representativeness calculation
- Correlation analysis
- NamedMatrix data structure
"""

from polismath.pca_kmeans_rep.clusters import Cluster, cluster_named_matrix
from polismath.pca_kmeans_rep.corr import compute_correlation
from polismath.pca_kmeans_rep.named_matrix import NamedMatrix
from polismath.pca_kmeans_rep.pca import pca_project_named_matrix
from polismath.pca_kmeans_rep.repness import conv_repness, participant_stats

__all__ = [
    "NamedMatrix",
    "pca_project_named_matrix",
    "cluster_named_matrix",
    "Cluster",
    "conv_repness",
    "participant_stats",
    "compute_correlation",
]
