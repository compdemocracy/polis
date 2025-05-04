"""
Main entry point for Pol.is math system.

This module provides the main entry point for running the Pol.is math system.
"""

import argparse
import logging
import os
import sys
import json
import yaml

from polismath.system import SystemManager
from polismath.components.config import ConfigManager


def setup_logging(level: str = 'INFO') -> None:
    """
    Set up logging.
    
    Args:
        level: Logging level
    """
    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler()
        ]
    )


def parse_args() -> argparse.Namespace:
    """
    Parse command line arguments.
    
    Returns:
        Parsed arguments
    """
    parser = argparse.ArgumentParser(description='Pol.is Math System')
    
    parser.add_argument(
        '--config',
        help='Path to configuration file'
    )
    
    parser.add_argument(
        '--log-level',
        default='INFO',
        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'],
        help='Logging level'
    )
    
    parser.add_argument(
        '--data-dir',
        help='Directory for data files'
    )
    
    parser.add_argument(
        '--math-env',
        help='Math environment (dev, prod, preprod)'
    )
    
    parser.add_argument(
        '--port',
        type=int,
        help='Server port'
    )
    
    parser.add_argument(
        '--host',
        help='Server host'
    )
    
    return parser.parse_args()


def load_config_file(filepath: str) -> dict:
    """
    Load configuration from a file.
    
    Args:
        filepath: Path to configuration file
        
    Returns:
        Configuration dictionary
    """
    if filepath.endswith('.json'):
        with open(filepath, 'r') as f:
            return json.load(f)
    elif filepath.endswith('.yaml') or filepath.endswith('.yml'):
        with open(filepath, 'r') as f:
            return yaml.safe_load(f)
    else:
        raise ValueError(f"Unsupported configuration file format: {filepath}")


def main() -> None:
    """
    Main entry point.
    """
    # Parse arguments
    args = parse_args()
    
    # Set up logging
    setup_logging(args.log_level)
    
    # Create overrides from arguments
    overrides = {}
    
    # Load configuration from file if provided
    if args.config:
        file_config = load_config_file(args.config)
        overrides.update(file_config)
    
    # Override with command line arguments
    if args.data_dir:
        overrides['data_dir'] = args.data_dir
    
    if args.math_env:
        overrides['math-env'] = args.math_env
    
    if args.port:
        if 'server' not in overrides:
            overrides['server'] = {}
        overrides['server']['port'] = args.port
    
    if args.host:
        if 'server' not in overrides:
            overrides['server'] = {}
        overrides['server']['host'] = args.host
    
    # Initialize configuration
    config = ConfigManager.get_config(overrides)
    
    # Start system
    system = SystemManager.start(config)
    
    # Wait for shutdown
    try:
        system.wait_for_shutdown()
    except KeyboardInterrupt:
        pass
    finally:
        SystemManager.stop()


if __name__ == '__main__':
    main()