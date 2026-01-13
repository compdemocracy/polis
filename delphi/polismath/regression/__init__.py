"""
Regression testing package for Polis math computations.

This package provides tools for recording and comparing conversation computation
outputs to ensure consistency across code changes.
"""

from .recorder import ConversationRecorder
from .comparer import ConversationComparer
from .datasets import (
    DatasetInfo,
    discover_datasets,
    list_regression_datasets,
    list_available_datasets,
    get_dataset_info,
    get_dataset_files,
    get_dataset_report_id,
)
from .clojure_comparer import (
    ClojureComparer,
    load_clojure_math_blob,
    compare_cluster_distributions,
    compare_cluster_membership,
    compare_projections,
    compute_wasserstein_similarity,
)

__all__ = [
    'ConversationRecorder',
    'ConversationComparer',
    'DatasetInfo',
    'discover_datasets',
    'list_regression_datasets',
    'list_available_datasets',
    'get_dataset_info',
    'get_dataset_files',
    'get_dataset_report_id',
    'ClojureComparer',
    'load_clojure_math_blob',
    'compare_cluster_distributions',
    'compare_cluster_membership',
    'compare_projections',
    'compute_wasserstein_similarity',
]
