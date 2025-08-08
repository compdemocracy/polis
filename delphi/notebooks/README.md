# Pol.is Conversation Analysis Notebooks

This directory contains Jupyter notebooks and scripts for analyzing Pol.is conversations using the Python implementation of the Pol.is math libraries.

## Contents

- `biodiversity_analysis.ipynb`: Comprehensive analysis of the biodiversity conversation dataset
- `run_analysis.py`: Python script to run the same analysis without Jupyter (for verification)
- `launch_notebook.sh`: Shell script to launch Jupyter Lab with the correct environment

## Getting Started

To run these notebooks:

1. Use the provided launch script:

   ```bash
   cd delphi/eda_notebooks
   ./launch_notebook.sh
   ```

2. This will:
   - Activate the virtual environment with the required dependencies
   - Start Jupyter Lab
   - You can then open the `biodiversity_analysis.ipynb` notebook

3. Alternative method:

   ```bash
   cd delphi
   source polis_env/bin/activate
   jupyter lab
   ```

## Verification Script

To verify the analysis works without Jupyter, you can run:

```bash
cd delphi/eda_notebooks
python run_analysis.py
```

This will:

1. Load the biodiversity conversation dataset
2. Process all votes and compute PCA, clustering, and representativeness
3. Save the results to the `output` directory
4. Print summary information to the console

## Analyses Included

The notebooks demonstrate:

1. Loading real conversation data
2. Processing votes into mathematical representations
3. Principal Component Analysis (PCA) to project participants into opinion space
4. K-means clustering to identify opinion groups
5. Representativeness analysis to find comments that characterize each group
6. Consensus detection to identify areas of common ground
7. Correlation analysis between comments
8. Group-aware consensus identification

## Using as Templates

These notebooks can be used as templates for analyzing other Pol.is conversations. Simply:

1. Replace the input data paths with your own conversation data
2. Adjust parameters as needed (e.g., sampling sizes, thresholds)
3. Run the analysis sections

Note that the notebooks only use existing polismath modules and do not modify any core functionality. They serve as "glue" to combine the various modules and visualize the results.
