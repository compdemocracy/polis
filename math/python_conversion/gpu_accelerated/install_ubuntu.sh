#!/bin/bash
# Installation script for Ubuntu Linux with NVIDIA GPUs

# Create virtual environment
echo "Creating virtual environment..."
python3 -m venv gpu_env
source gpu_env/bin/activate

# Check for NVIDIA GPU
if ! nvidia-smi > /dev/null 2>&1; then
    echo "NVIDIA GPU not detected or drivers not installed."
    echo "Would you like to install NVIDIA drivers? (y/n)"
    read install_drivers
    
    if [ "$install_drivers" = "y" ]; then
        echo "Installing NVIDIA drivers and CUDA toolkit..."
        sudo apt-get update
        sudo apt-get install -y ubuntu-drivers-common
        
        # Check for recommended driver
        RECOMMENDED_DRIVER=$(ubuntu-drivers devices | grep "recommended" | awk '{print $3}')
        if [ -n "$RECOMMENDED_DRIVER" ]; then
            echo "Installing recommended driver: $RECOMMENDED_DRIVER"
            sudo apt-get install -y $RECOMMENDED_DRIVER
        else
            echo "No recommended driver found. Installing nvidia-driver-510..."
            sudo apt-get install -y nvidia-driver-510
        fi
        
        # Install CUDA toolkit
        echo "Installing CUDA toolkit..."
        sudo apt-get install -y nvidia-cuda-toolkit
        
        echo "Driver and CUDA installation complete. Please reboot your system and run this script again."
        exit 0
    else
        echo "Installing CPU-only version..."
        pip install -e ".[dev]"
        exit 1
    fi
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