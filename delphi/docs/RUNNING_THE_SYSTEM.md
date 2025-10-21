# Running the Pol.is Math Python System

This document provides a comprehensive guide on how to set up, run, and test the Python implementation of the Pol.is math module.

## Table of Contents

1. [Environment Setup](#environment-setup)
2. [Package Installation](#package-installation)
3. [Running Tests](#running-tests)
4. [Using the System](#using-the-system)
5. [Working with Notebooks](#working-with-notebooks)
6. [Command-line Interface](#command-line-interface)
7. [Troubleshooting](#troubleshooting)

## Environment Setup

### Prerequisites

- Python 3.8+ (Python 3.12 recommended)
- pip (Python package manager)
- Virtual environment (optional but recommended)

### Creating a Virtual Environment

```bash
# Navigate to the delphi directory
cd delphi

# Create a virtual environment
python -m venv delphi-env

# Activate the virtual environment
# On Linux/macOS
source delphi-env/bin/activate
# On Windows
delphi-env\Scripts\activate
```

## Package Installation

Once your environment is set up, install the package in development mode:

```bash
# Make sure you're in the delphi directory
pip install -e .
```

This will install all the required dependencies and make the `polismath` package available in your environment.

## Running Tests

### Using the Test Runner Script

The most straightforward way to run tests is using the provided `run_tests.py` script:

```bash
# Run all tests
python run_tests.py

# Run only unit tests
python run_tests.py --unit

# Run only real data tests
python run_tests.py --real

# Run only demo scripts
python run_tests.py --demo

# Run only simplified test scripts
python run_tests.py --simplified
```

### Using pytest Directly

For more control over test execution, you can use pytest directly:

```bash
# Run all tests
python -m pytest tests/

# Run a specific test file
python -m pytest tests/test_pca.py

# Run tests with coverage
python -m pytest --cov=polismath tests/
```

### Understanding Test Output

Test output will indicate whether each component passes its tests. The real data tests will provide additional information:

- Number of participants and comments processed
- Number of groups found
- Top representative comments for each group
- Comparison with Clojure output (where available)

Test results for real data are saved to the `python_output` directory within each dataset's folder for manual inspection.

## Using the System

### Basic Usage

Here's a basic example of how to use the system in Python:

```python
from polismath import SystemManager
from polismath.conversation import Conversation

# Start the system manager
system = SystemManager.start()

# Create a conversation manager
conv_manager = system.conversation_manager

# Create a new conversation
conv_id = "my-conversation"
conv = conv_manager.create_conversation(conv_id)

# Process votes
votes = [
    {"pid": "participant1", "tid": "comment1", "vote": 1},   # Agree
    {"pid": "participant1", "tid": "comment2", "vote": -1},  # Disagree
    {"pid": "participant2", "tid": "comment1", "vote": 1},   # Agree
    {"pid": "participant2", "tid": "comment3", "vote": 1},   # Agree
]

# Update the conversation with votes
updated_conv = conv_manager.process_votes(conv_id, {"votes": votes})

# Access results
group_clusters = updated_conv.group_clusters
repness = updated_conv.repness
```

### Loading Real Data

To load and analyze real data:

```python
import pandas as pd
from polismath.conversation import Conversation

# Load votes and comments
votes_df = pd.read_csv("path/to/votes.csv")
comments_df = pd.read_csv("path/to/comments.csv")

# Convert to the format expected by the system
votes = votes_df.to_dict('records')
comments = {row['tid']: row['txt'] for _, row in comments_df.iterrows()}

# Create and initialize a conversation
conv = Conversation("conversation_id")

# Process the votes
conv.update_votes(votes)

# Access results
pca_results = conv.pca
clusters = conv.group_clusters
repness = conv.repness
```

## Working with Notebooks

The `eda_notebooks` directory contains Jupyter notebooks for exploratory data analysis and demonstrating system capabilities.

### Running the Biodiversity Analysis Notebook

1. Make sure your environment is set up and the package is installed
2. Navigate to the `eda_notebooks` directory
3. Start Jupyter Notebook or Jupyter Lab:

```bash
cd delphi/eda_notebooks
jupyter notebook
# or
jupyter lab
```

4. Open `biodiversity_analysis.ipynb`
5. Run all cells to see the complete analysis

### Creating Your Own Analysis

To create your own analysis:

1. Copy one of the existing notebooks as a template
2. Update the data paths to your own dataset
3. Customize the analysis as needed

### Helper Script

You can use the included helper script to launch a notebook server:

```bash
cd delphi/eda_notebooks
./launch_notebook.sh
```

## Command-line Interface

The package includes a basic command-line interface:

```bash
# Run with default settings
polismath

# Show help
polismath --help

# Run with custom settings
polismath --config config.yaml --port 8000 --log-level DEBUG
```

## Running the Simplified Test Scripts

The repository includes simplified versions of the core algorithms that can be run independently:

```bash
# Run the simplified PCA and clustering test
python simplified_test.py

# Run the simplified representativeness test
python simplified_repness_test.py
```

These scripts demonstrate the core algorithms without depending on the full package structure and can be useful for understanding the underlying mathematics.

## Running the Demo Scripts

The repository includes demo scripts that demonstrate the system's capabilities:

```bash
# Run the simple demo
python simple_demo.py

# Run the final demo
python final_demo.py
```

## Troubleshooting

### Common Issues

1. **ImportError or ModuleNotFoundError**
   - Make sure you've installed the package with `pip install -e .`
   - Check if your virtual environment is activated

2. **File Not Found Errors**
   - Make sure you're running from the correct directory
   - Check if the data files exist at the specified paths

3. **Test Failures**
   - Check the specific error messages
   - Verify that you have all dependencies installed
   - Make sure your environment is properly set up

### Getting Help

If you encounter issues, check:
1. The README.md file for the latest documentation
2. The tests/TESTING_RESULTS.md for known issues
3. The GitHub repository for open issues

## Conclusion

This guide covers the basics of setting up, running, and testing the Pol.is math Python implementation. For more details on the implementation, refer to the README.md and the source code documentation.

If you're new to the system, we recommend starting with the notebooks in the `eda_notebooks` directory, particularly `biodiversity_analysis.ipynb`, which provides a comprehensive demonstration of the system's capabilities.