# Pol.is Math Python Notebooks

This directory contains Jupyter notebooks that demonstrate and test the Python conversion of the Pol.is math codebase.

## Overview

These notebooks provide a comprehensive exploration of the entire Pol.is math system, from the low-level mathematical algorithms to the high-level system integration. They serve as both documentation and executable tests for all components of the system.

## Notebook Contents

0. **[Introduction](00_introduction.ipynb)**: Overview of the Pol.is math Python conversion and how to use these notebooks
1. **[Named Matrix](01_named_matrix.ipynb)**: The core data structure for storing votes
2. **[PCA](02_pca.ipynb)**: Dimensionality reduction for visualization
3. **[Clustering](03_clustering.ipynb)**: Grouping participants by opinion
4. **[Representativeness](04_representativeness.ipynb)**: Finding representative comments
5. **[Correlation](05_correlation.ipynb)**: Analyzing relationships between comments
6. **[Conversation Management](06_conversation.ipynb)**: State handling and updates
7. **[System Integration](07_system_integration.ipynb)**: Database, server, and poller components

## Usage

To run these notebooks, you need to have the Pol.is math Python package installed:

```bash
# Create and activate a virtual environment
python -m venv polis_env
source polis_env/bin/activate

# Install the package in development mode
pip install -e .

# Install Jupyter and other visualization dependencies
pip install jupyterlab notebook ipywidgets matplotlib seaborn

# Start Jupyter Lab
jupyter lab
```

Each notebook is designed to be self-contained and can be run independently, though they are best explored in sequence as later notebooks build on concepts introduced in earlier ones.

## What You'll Learn

These notebooks will teach you:

1. How the Pol.is algorithms work in detail
2. How the Python implementation handles various edge cases
3. How to visualize and interpret the results
4. How the different components integrate into a complete system
5. How to use the Pol.is math Python package in your own applications

## Contributing

If you find issues or have suggestions for improving these notebooks, please file an issue or submit a pull request to the [Pol.is repository](https://github.com/compdemocracy/polis).