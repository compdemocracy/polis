"""
General utility functions for the polismath package.

This module provides Python implementations of the utility functions
from the original Clojure codebase.
"""

import itertools
import numpy as np
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple, TypeVar, Union

T = TypeVar('T')
U = TypeVar('U')


def xor(a: bool, b: bool) -> bool:
    """
    Logical exclusive OR.
    
    Args:
        a: First boolean
        b: Second boolean
        
    Returns:
        a XOR b
    """
    return bool(a) != bool(b)


def round_to(n: float, digits: int = 0) -> float:
    """
    Round a number to a specific number of decimal places.
    
    Args:
        n: Number to round
        digits: Number of decimal digits to keep
        
    Returns:
        Rounded number
    """
    return round(n, digits)


def agree(vote: Optional[float]) -> bool:
    """
    Check if a vote is an agreement.
    
    Args:
        vote: Vote value (1 for agree, -1 for disagree, None for pass)
        
    Returns:
        True if the vote is an agreement
    """
    return vote == 1


def disagree(vote: Optional[float]) -> bool:
    """
    Check if a vote is a disagreement.
    
    Args:
        vote: Vote value (1 for agree, -1 for disagree, None for pass)
        
    Returns:
        True if the vote is a disagreement
    """
    return vote == -1


def pass_vote(vote: Optional[float]) -> bool:
    """
    Check if a vote is a pass.
    
    Args:
        vote: Vote value (1 for agree, -1 for disagree, None for pass)
        
    Returns:
        True if the vote is a pass (None)
    """
    return vote is None


def zip_collections(*colls: Iterable[T]) -> List[Tuple[T, ...]]:
    """
    Zip multiple collections together.
    Similar to Python's built-in zip, but returns a list.
    
    Args:
        *colls: Collections to zip
        
    Returns:
        List of tuples containing corresponding elements
    """
    return list(zip(*colls))


def with_indices(coll: Iterable[T]) -> List[Tuple[int, T]]:
    """
    Combine elements of a collection with their indices.
    
    Args:
        coll: Collection to process
        
    Returns:
        List of (index, item) tuples
    """
    return list(enumerate(coll))


def filter_by_index(coll: Iterable[T], indices: Iterable[int]) -> List[T]:
    """
    Filter a collection to only include items at specified indices.
    
    Args:
        coll: Collection to filter
        indices: Indices to include
        
    Returns:
        Filtered list
    """
    coll_list = list(coll)
    index_set = set(indices)
    return [item for i, item in enumerate(coll_list) if i in index_set]


def map_rest(f: Callable[[T, T], U], coll: List[T]) -> List[U]:
    """
    Apply a function to each element and all remaining elements.
    
    For each element in coll, apply function f to that element and each 
    element that comes after it.
    
    Args:
        f: Function taking two arguments
        coll: Collection to process
        
    Returns:
        List of results
    """
    result = []
    n = len(coll)
    for i in range(n):
        for j in range(i + 1, n):
            result.append(f(coll[i], coll[j]))
    return result


def mapv_rest(f: Callable[[T, T], U], coll: List[T]) -> List[U]:
    """
    Same as map_rest but guaranteed to return a list.
    
    Args:
        f: Function taking two arguments
        coll: Collection to process
        
    Returns:
        List of results
    """
    return map_rest(f, coll)


def typed_indexof(coll: List[T], item: T) -> int:
    """
    Find the index of an item in a collection.
    
    Args:
        coll: Collection to search
        item: Item to find
        
    Returns:
        Index of the item, or -1 if not found
    """
    try:
        return coll.index(item)
    except ValueError:
        return -1


def hash_map_subset(m: Dict[T, U], keys: Iterable[T]) -> Dict[T, U]:
    """
    Create a subset of a dictionary containing only specified keys.
    
    Args:
        m: Dictionary to subset
        keys: Keys to include
        
    Returns:
        Dictionary subset
    """
    return {k: m[k] for k in keys if k in m}


def distinct(coll: Iterable[T]) -> List[T]:
    """
    Return a list with duplicates removed, preserving order.
    
    Args:
        coll: Collection to process
        
    Returns:
        List with duplicates removed
    """
    seen = set()
    result = []
    for item in coll:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def weighted_mean(values: List[float], weights: Optional[List[float]] = None) -> float:
    """
    Calculate the weighted mean of a list of values.
    
    Args:
        values: Values to average
        weights: Weights for each value (defaults to equal weights)
        
    Returns:
        Weighted mean
    """
    values_array = np.array(values)
    
    if weights is None:
        return np.mean(values_array)
    else:
        weights_array = np.array(weights)
        return np.average(values_array, weights=weights_array)


def weighted_means(values_matrix: List[List[float]], 
                  weights: Optional[List[float]] = None) -> List[float]:
    """
    Calculate the weighted means of each column in a matrix.
    
    Args:
        values_matrix: Matrix of values (rows are observations, columns are variables)
        weights: Weights for each row (defaults to equal weights)
        
    Returns:
        List of weighted means for each column
    """
    values_array = np.array(values_matrix)
    
    if weights is None:
        return np.mean(values_array, axis=0).tolist()
    else:
        weights_array = np.array(weights)
        # Reshape weights for broadcasting
        weights_array = weights_array.reshape(-1, 1) 
        
        # Calculate weighted sum and sum of weights for each column
        weighted_sum = np.sum(values_array * weights_array, axis=0)
        sum_weights = np.sum(weights_array)
        
        return (weighted_sum / sum_weights).tolist()