"""
Regression testing package for Polis math computations.

This package provides tools for recording and comparing conversation computation
outputs to ensure consistency across code changes.
"""

from .recorder import ConversationRecorder
from .comparer import ConversationComparer
from .datasets import (
    get_dataset_files,
    get_dataset_report_id,
    list_available_datasets,
    DATASETS
)

__all__ = [
    'ConversationRecorder',
    'ConversationComparer',
    'get_dataset_files',
    'get_dataset_report_id',
    'list_available_datasets',
    'DATASETS',
]
