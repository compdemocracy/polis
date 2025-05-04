#!/bin/bash
# Installation script for AWS EC2 instances with NVIDIA GPUs

# Check if running on AWS
if ! curl -s http://169.254.169.254/latest/meta-data/ > /dev/null; then
    echo "Warning: This doesn't appear to be an AWS EC2 instance."
    echo "Continuing anyway, but installation may fail if NVIDIA drivers are not properly set up."
fi

# Create virtual environment
echo "Creating virtual environment..."
python3 -m venv gpu_env
source gpu_env/bin/activate

# Check for NVIDIA GPU
if ! nvidia-smi > /dev/null 2>&1; then
    echo "NVIDIA GPU not detected or drivers not installed."
    echo "Please ensure you're using a GPU-enabled instance (e.g., p3.2xlarge)"
    echo "and that NVIDIA drivers are installed."
    echo "Installing CPU-only version..."
    pip install -e ".[dev]"
    exit 1
fi

# Determine CUDA version
CUDA_VERSION=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}')
MAJOR_VERSION=$(echo $CUDA_VERSION | cut -d. -f1)
MINOR_VERSION=$(echo $CUDA_VERSION | cut -d. -f2)

echo "Detected CUDA version: $CUDA_VERSION"

# Install appropriate cupy version
if [ "$MAJOR_VERSION" -eq 11 ]; then
    if [ "$MINOR_VERSION" -ge 2 ]; then
        echo "Installing cupy-cuda11x..."
        pip install cupy-cuda11x
    elif [ "$MINOR_VERSION" -eq 0 ] || [ "$MINOR_VERSION" -eq 1 ]; then
        echo "Installing cupy-cuda110..."
        pip install cupy-cuda110
    fi
elif [ "$MAJOR_VERSION" -eq 10 ]; then
    echo "Installing cupy-cuda10x..."
    pip install cupy-cuda10x
else
    echo "Unsupported CUDA version. Falling back to PyTorch..."
    pip install torch
fi

# Install PyTorch with CUDA support
pip install torch

# Install the package and dependencies
echo "Installing polismath-gpu and dependencies..."
pip install -e ".[cuda,dev]"

echo "Installation complete!"
echo "To activate the environment, run: source gpu_env/bin/activate"