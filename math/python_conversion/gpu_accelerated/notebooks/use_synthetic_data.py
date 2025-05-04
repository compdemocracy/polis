"""
Helper module for the notebook to use synthetic data.
"""

import os
import sys
import numpy as np

# Add parent directory to path to import our data_loader
sys.path.append('..')
from data_loader import create_synthetic_data

# Generate synthetic data
synthetic_data = create_synthetic_data(1000, 50)

print("Synthetic data created and ready to use in the notebook.")
print(f"Shape: {synthetic_data.shape}")
print(f"Non-NaN values: {np.sum(~np.isnan(synthetic_data))}")
print(f"Sparsity: {np.sum(np.isnan(synthetic_data)) / synthetic_data.size:.2%}")
print("\nTo use in the notebook, replace the biodiversity data loading with:")
print("```python")
print("# Use synthetic data instead of biodiversity dataset")
print("from use_synthetic_data import synthetic_data")
print("vote_matrix = synthetic_data")
print("```")