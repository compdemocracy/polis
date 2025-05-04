"""
Simple demo script to test the core math components of the Pol.is math system.
"""

import numpy as np
from polismath.math.named_matrix import NamedMatrix
from polismath.math.pca import pca_project_named_matrix
from polismath.math.clusters import cluster_named_matrix
import json

def main():
    print("Creating a test named matrix...")
    
    # Create a simple votes matrix with two clear groups
    # Group 1 (participants 0-49) tends to agree with comments 0-9
    # Group 2 (participants 50-99) tends to agree with comments 10-19
    
    # Create participant and comment IDs
    num_participants = 100
    num_comments = 20
    participant_ids = [f"p{i}" for i in range(num_participants)]
    comment_ids = [f"c{i}" for i in range(num_comments)]
    
    # Initialize a matrix with all NaN values
    votes_matrix = np.full((num_participants, num_comments), np.nan)
    
    # Fill in the matrix with votes (1 for agree, -1 for disagree)
    for p_idx in range(num_participants):
        group = 0 if p_idx < 50 else 1
        
        for c_idx in range(num_comments):
            # Group 1 agrees with first half of comments, disagrees with second half
            # Group 2 does the opposite
            if (group == 0 and c_idx < 10) or (group == 1 and c_idx >= 10):
                votes_matrix[p_idx, c_idx] = 1  # Agree
            else:
                votes_matrix[p_idx, c_idx] = -1  # Disagree
    
    # Create a NamedMatrix
    named_matrix = NamedMatrix(votes_matrix, participant_ids, comment_ids)
    
    print(f"Created matrix with {len(participant_ids)} participants and {len(comment_ids)} comments")
    
    # Perform PCA
    print("\nPerforming PCA...")
    pca_results, projections = pca_project_named_matrix(named_matrix)
    
    # Examine PCA results structure
    print("\nPCA Results structure:")
    print(f"PCA Results type: {type(pca_results)}")
    print(f"Keys: {list(pca_results.keys()) if isinstance(pca_results, dict) else 'Not a dictionary'}")
    
    # Examine projections structure
    print("\nProjections structure:")
    print(f"Projections type: {type(projections)}")
    if hasattr(projections, 'shape'):
        print(f"Projections shape: {projections.shape}")
    
    # Try using the projections
    try:
        # Get the first two components
        x = projections[:, 0]
        y = projections[:, 1]
        print(f"\nFirst participant projection: ({x[0]}, {y[0]})")
    except Exception as e:
        print(f"Error accessing projections: {e}")
    
    # Try clustering directly with the matrix
    print("\nPerforming clustering...")
    try:
        clusters = cluster_named_matrix(named_matrix, k=2)
        print(f"Clustering succeeded with {len(clusters)} clusters")
    except Exception as e:
        print(f"Error in clustering: {e}")
    
    print("\nSimple demo completed successfully!")

if __name__ == "__main__":
    main()