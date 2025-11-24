"""
Correlation and hierarchical clustering implementation for Pol.is.

This module provides functions for computing correlations between comments
and performing hierarchical clustering based on those correlations.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Union, Any
import scipy
import scipy.stats
import scipy.cluster.hierarchy as hcluster
from scipy.spatial.distance import pdist, squareform
import json


def clean_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Clean a DataFrame by replacing NaN values with zeros.

    Args:
        df: pd.DataFrame to clean

    Returns:
        Cleaned DataFrame
    """
    # Get the matrix values and replace NaN with zeros
    values = df.to_numpy(copy=True)
    values = np.nan_to_num(values, nan=0.0)

    # Create a new DataFrame with the cleaned values
    return pd.DataFrame(
        data=values,
        index=df.index,
        columns=df.columns
    )


def transpose_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Transpose a DataFrame.

    Args:
        df: pd.DataFrame to transpose

    Returns:
        Transposed DataFrame
    """
    # Transpose the matrix values
    values = df.values.T

    # Create a new DataFrame with rows and columns swapped
    return pd.DataFrame(
        data=values,
        index=df.columns,
        columns=df.index
    )


def correlation_matrix(nmat: pd.DataFrame, method: str = 'pearson') -> np.ndarray:
    """
    Compute correlation matrix for a DataFrame.
    
    Args:
        nmat: pd.DataFrame to compute correlations for
        method: Correlation method ('pearson', 'spearman', or 'kendall')
        
    Returns:
        Correlation matrix as numpy array
    """
    # Clean the matrix values
    values = nmat.to_numpy(copy = True)
    values = np.nan_to_num(values, nan=0.0)
    
    # Compute correlation matrix
    if method == 'pearson':
        corr = np.corrcoef(values)
    elif method == 'spearman':
        corr, _ = scipy.stats.spearmanr(values)
    elif method == 'kendall':
        # Compute pairwise correlations
        n = values.shape[0]
        corr = np.zeros((n, n))
        for i in range(n):
            for j in range(n):
                corr[i, j], _ = scipy.stats.kendalltau(values[i], values[j])
    else:
        raise ValueError(f"Unknown correlation method: {method}")
    
    # Replace NaN values with zeros
    corr = np.nan_to_num(corr, nan=0.0)
    
    return corr


def hierarchical_cluster(nmat: pd.DataFrame, 
                        method: str = 'complete',
                        metric: str = 'correlation',
                        transpose: bool = False) -> Dict[str, Any]:
    """
    Perform hierarchical clustering on a DataFrame.
    
    Args:
        nmat: pd.DataFrame to cluster
        method: Linkage method ('single', 'complete', 'average', 'weighted', 'centroid', 'median', 'ward')
        metric: Distance metric ('correlation', 'euclidean', 'cityblock', etc.)
        transpose: Whether to transpose the matrix before clustering
        
    Returns:
        Dictionary with hierarchical clustering results
    """
    # Clean the matrix
    clean_nmat = clean_dataframe(nmat)

    # Transpose if requested
    if transpose:
        clean_nmat = transpose_dataframe(clean_nmat)
    
    # Extract names and values
    names = clean_nmat.index
    values = clean_nmat.to_numpy()
    
    # Compute distance matrix
    distances = pdist(values, metric=metric)
    
    # Perform hierarchical clustering
    linkage = hcluster.linkage(distances, method=method)
    
    # Convert to a more convenient format
    result = {
        'linkage': linkage.tolist(),
        'names': names,
        'leaves': hcluster.leaves_list(linkage).tolist(),
        'distances': distances.tolist()
    }
    
    return result


def flatten_hierarchical_cluster(hclust_result: Dict[str, Any]) -> List[str]:
    """
    Extract leaf node ordering from hierarchical clustering results.
    
    Args:
        hclust_result: Result from hierarchical_cluster
        
    Returns:
        List of names in hierarchical order
    """
    # Get leaves and names
    leaves = hclust_result['leaves']
    names = hclust_result['names']
    
    # Return names in hierarchical order
    return [names[i] for i in leaves]


def blockify_correlation_matrix(corr_matrix: np.ndarray, 
                              row_order: List[int], 
                              col_order: Optional[List[int]] = None) -> np.ndarray:
    """
    Reorder a correlation matrix based on clustering results.
    
    Args:
        corr_matrix: Correlation matrix to reorder
        row_order: List of row indices in desired order
        col_order: List of column indices in desired order (defaults to row_order)
        
    Returns:
        Reordered correlation matrix
    """
    if col_order is None:
        col_order = row_order
    
    # Reorder rows and columns
    reordered = corr_matrix[row_order, :]
    reordered = reordered[:, col_order]
    
    return reordered


def compute_correlation(vote_matrix: pd.DataFrame, 
                       method: str = 'pearson',
                       cluster_method: str = 'complete',
                       metric: str = 'correlation') -> Dict[str, Any]:
    """
    Compute correlations and hierarchical clustering for a vote matrix.
    
    Args:
        vote_matrix: pd.DataFrame containing votes
        method: Correlation method
        cluster_method: Hierarchical clustering method
        metric: Distance metric
        
    Returns:
        Dictionary with correlation and clustering results
    """
    # Transpose to get comment correlations
    comment_matrix = transpose_dataframe(vote_matrix)
    
    # Compute correlation matrix
    corr = correlation_matrix(comment_matrix, method)
    
    # Perform hierarchical clustering
    hclust_result = hierarchical_cluster(
        comment_matrix, 
        method=cluster_method,
        metric=metric
    )
    
    # Get leaf ordering
    leaf_order = hclust_result['leaves']
    
    # Reorder correlation matrix
    reordered_corr = blockify_correlation_matrix(corr, leaf_order)
    
    # Return results
    return {
        'correlation': corr.tolist(),
        'reordered_correlation': reordered_corr.tolist(),
        'hierarchical_clustering': hclust_result,
        'comment_order': flatten_hierarchical_cluster(hclust_result),
        'comment_ids': comment_matrix.index
    }


def prepare_correlation_export(corr_result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Prepare correlation results for export to JSON.
    
    Args:
        corr_result: Result from compute_correlation
        
    Returns:
        Export-ready dictionary
    """
    # Convert numpy arrays to lists
    result = {
        'correlation': corr_result['correlation'],
        'reordered_correlation': corr_result['reordered_correlation'],
        'comment_order': corr_result['comment_order'],
        'comment_ids': corr_result['comment_ids']
    }
    
    # Simplify hierarchical clustering data
    hclust = corr_result['hierarchical_clustering']
    result['hierarchical_clustering'] = {
        'linkage': hclust['linkage'],
        'names': hclust['names'],
        'leaves': hclust['leaves']
    }
    
    return result


def save_correlation_to_json(corr_result: Dict[str, Any], filepath: str) -> None:
    """
    Save correlation results to a JSON file.
    
    Args:
        corr_result: Result from compute_correlation or prepare_correlation_export
        filepath: Path to save the JSON file
        
    Returns:
        None
    """
    # Prepare for export if needed
    if 'distances' in corr_result.get('hierarchical_clustering', {}):
        export_data = prepare_correlation_export(corr_result)
    else:
        export_data = corr_result
    
    # Write to file
    with open(filepath, 'w') as f:
        json.dump(export_data, f)


def participant_correlation(vote_matrix: pd.DataFrame, 
                          p1_id: str, 
                          p2_id: str,
                          method: str = 'pearson') -> float:
    """
    Compute correlation between two participants.
    
    Args:
        vote_matrix: pd.DataFrame containing votes
        p1_id: ID of first participant
        p2_id: ID of second participant
        method: Correlation method
        
    Returns:
        Correlation coefficient
    """
    # Get the participant votes
    p1_votes = vote_matrix.loc[p1_id].to_numpy()
    p2_votes = vote_matrix.loc[p2_id].to_numpy()
    
    # Find comments both participants voted on
    mask = ~np.isnan(p1_votes) & ~np.isnan(p2_votes)
    
    # If no overlap, return 0
    if np.sum(mask) < 2:
        return 0.0
    
    # Extract common votes
    p1_common = p1_votes[mask]
    p2_common = p2_votes[mask]
    
    # Compute correlation
    if method == 'pearson':
        corr, _ = scipy.stats.pearsonr(p1_common, p2_common)
    elif method == 'spearman':
        corr, _ = scipy.stats.spearmanr(p1_common, p2_common)
    elif method == 'kendall':
        corr, _ = scipy.stats.kendalltau(p1_common, p2_common)
    else:
        raise ValueError(f"Unknown correlation method: {method}")
    
    # Handle NaN
    if np.isnan(corr):
        return 0.0
    
    return corr


def participant_correlation_matrix(vote_matrix: pd.DataFrame, 
                                 method: str = 'pearson') -> Dict[str, Any]:
    """
    Compute correlation matrix for all participants.
    
    Args:
        vote_matrix: pd.DataFrame containing votes
        method: Correlation method
        
    Returns:
        Dictionary with correlation matrix and participant IDs
    """
    participant_ids = vote_matrix.index
    n_participants = len(participant_ids)
    
    # Initialize correlation matrix
    corr_matrix = np.zeros((n_participants, n_participants))
    
    # Compute pairwise correlations
    for i in range(n_participants):
        for j in range(i, n_participants):
            corr = participant_correlation(
                vote_matrix,
                participant_ids[i],
                participant_ids[j],
                method
            )
            corr_matrix[i, j] = corr
            corr_matrix[j, i] = corr
    
    # Set diagonal to 1
    np.fill_diagonal(corr_matrix, 1.0)
    
    return {
        'correlation': corr_matrix.tolist(),
        'participant_ids': participant_ids
    }