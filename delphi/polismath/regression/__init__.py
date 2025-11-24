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
]
