#!/usr/bin/env python3
"""
Instance Type Configuration for Delphi

This script detects the instance type (small or large) based on the instance_size.txt file
or environment variables and sets appropriate resource limits for Delphi.

It should be called at the beginning of run_delphi.sh script.
"""

import logging
import os
import sys
from typing import Any

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("delphi.configure_instance")

# Resource settings for different instance types
INSTANCE_CONFIGS = {
    "small": {
        "max_workers": 3,
        "worker_memory": "2g",
        "container_memory": "8g",
        "container_cpus": 2,
        "description": "Cost-efficient t3.large instance",
    },
    "large": {
        "max_workers": 8,
        "worker_memory": "8g",
        "container_memory": "32g",
        "container_cpus": 8,
        "description": "High-performance c6g.4xlarge ARM instance",
    },
    "default": {
        "max_workers": 2,
        "worker_memory": "1g",
        "container_memory": "4g",
        "container_cpus": 1,
        "description": "Default configuration",
    },
}


def detect_instance_type() -> str:
    """
    Detect instance type from instance_size.txt or environment variables.

    Returns:
        str: Instance type (small, large, or default)
    """
    # First check environment variable
    instance_type = os.environ.get("INSTANCE_SIZE")
    if instance_type in INSTANCE_CONFIGS:
        logger.info(f"Using instance type from environment variable: {instance_type}")
        return instance_type

    # Then check instance_size.txt file (created by UserData script)
    if os.path.exists("/etc/app-info/instance_size.txt"):
        try:
            with open("/etc/app-info/instance_size.txt") as f:
                instance_type = f.read().strip()
                if instance_type in INSTANCE_CONFIGS:
                    logger.info(f"Using instance type from file: {instance_type}")
                    return instance_type
                else:
                    logger.warning(f"Unknown instance type in file: {instance_type}, using default configuration")
        except Exception as e:
            logger.warning(f"Error reading instance_size.txt: {e}")

    # Fall back to default configuration
    logger.info("No instance type detected, using default configuration")
    return "default"


def configure_resources(instance_type: str) -> dict[str, Any]:
    """
    Configure resource limits based on instance type.

    Args:
        instance_type (str): Instance type (small, large, or default)

    Returns:
        dict: Resource configuration
    """
    # Get configuration for instance type
    config = INSTANCE_CONFIGS.get(instance_type, INSTANCE_CONFIGS["default"])

    # Set environment variables
    os.environ["INSTANCE_SIZE"] = instance_type
    os.environ["DELPHI_MAX_WORKERS"] = str(config["max_workers"])
    os.environ["DELPHI_WORKER_MEMORY"] = config["worker_memory"]
    os.environ["DELPHI_CONTAINER_MEMORY"] = config["container_memory"]
    os.environ["DELPHI_CONTAINER_CPUS"] = str(config["container_cpus"])

    logger.info(f"Configured for {config['description']}")
    logger.info(f"  - Max Workers: {config['max_workers']}")
    logger.info(f"  - Worker Memory: {config['worker_memory']}")
    logger.info(f"  - Container Memory: {config['container_memory']}")
    logger.info(f"  - Container CPUs: {config['container_cpus']}")

    return config


def main() -> None:
    """Main entry point."""
    # Detect instance type
    instance_type = detect_instance_type()

    # Configure resources
    config = configure_resources(instance_type)

    # Print configuration (so it can be captured by the shell script)
    print(f"INSTANCE_SIZE={instance_type}")
    print(f"DELPHI_MAX_WORKERS={config['max_workers']}")
    print(f"DELPHI_WORKER_MEMORY={config['worker_memory']}")
    print(f"DELPHI_CONTAINER_MEMORY={config['container_memory']}")
    print(f"DELPHI_CONTAINER_CPUS={config['container_cpus']}")


if __name__ == "__main__":
    main()
