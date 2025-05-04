#!/bin/bash
# Installation script for macOS (Apple Silicon or Intel)

# Create virtual environment
echo "Creating virtual environment..."
python3 -m venv gpu_env
source gpu_env/bin/activate

# Detect Apple Silicon
if [[ $(uname -m) == 'arm64' ]]; then
    echo "Detected Apple Silicon (M1/M2)"
    # Install PyTorch with MPS backend for Apple Silicon
    pip install torch
    echo "Installed PyTorch with MPS (Metal Performance Shaders) support"
else
    echo "Detected Intel Mac"
    # Check for NVIDIA GPU
    if system_profiler SPDisplaysDataType | grep -q "NVIDIA"; then
        echo "NVIDIA GPU detected, installing with CUDA support"
        pip install torch cupy-cuda11x
    else
        # Intel Mac without NVIDIA GPU
        echo "No NVIDIA GPU detected, installing CPU-only PyTorch"
        pip install torch
    fi
fi

# Install the package and dependencies
echo "Installing polismath-gpu and dependencies..."
pip install -e ".[torch,dev]"

echo "Installation complete!"
echo "To activate the environment, run: source gpu_env/bin/activate"