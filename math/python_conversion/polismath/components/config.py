"""
Configuration management for Pol.is math.

This module provides functionality for managing configuration,
including loading from environment variables and default values.
"""

import os
import json
import logging
import threading
from typing import Dict, List, Optional, Tuple, Union, Any, Set, Callable
import re
from copy import deepcopy
import yaml

# Set up logging
logger = logging.getLogger(__name__)


def to_int(value: Any) -> Optional[int]:
    """
    Convert a value to an integer.
    
    Args:
        value: Value to convert
        
    Returns:
        Integer value, or None if conversion failed
    """
    if value is None:
        return None
    
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def to_float(value: Any) -> Optional[float]:
    """
    Convert a value to a float.
    
    Args:
        value: Value to convert
        
    Returns:
        Float value, or None if conversion failed
    """
    if value is None:
        return None
    
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def to_bool(value: Any) -> Optional[bool]:
    """
    Convert a value to a boolean.
    
    Args:
        value: Value to convert
        
    Returns:
        Boolean value, or None if conversion failed
    """
    if value is None:
        return None
    
    if isinstance(value, bool):
        return value
    
    if isinstance(value, (int, float)):
        return bool(value)
    
    if isinstance(value, str):
        value = value.lower().strip()
        if value in ('true', 'yes', 'y', '1', 't'):
            return True
        if value in ('false', 'no', 'n', '0', 'f'):
            return False
    
    return None


def to_list(value: Any, separator: str = ',') -> Optional[List[str]]:
    """
    Convert a value to a list.
    
    Args:
        value: Value to convert
        separator: Separator for string values
        
    Returns:
        List value, or None if conversion failed
    """
    if value is None:
        return None
    
    if isinstance(value, list):
        return value
    
    if isinstance(value, str):
        return [item.strip() for item in value.split(separator) if item.strip()]
    
    return None


def to_int_list(value: Any, separator: str = ',') -> Optional[List[int]]:
    """
    Convert a value to a list of integers.
    
    Args:
        value: Value to convert
        separator: Separator for string values
        
    Returns:
        List of integers, or None if conversion failed
    """
    string_list = to_list(value, separator)
    
    if string_list is None:
        return None
    
    try:
        return [int(item) for item in string_list]
    except (ValueError, TypeError):
        return None


def get_env_value(name: str, default: Any = None) -> Any:
    """
    Get a value from environment variables.
    
    Args:
        name: Environment variable name
        default: Default value if not found
        
    Returns:
        Environment variable value, or default if not found
    """
    return os.environ.get(name, default)


class Config:
    """
    Configuration manager for Pol.is math.
    """
    
    def __init__(self, overrides: Optional[Dict[str, Any]] = None):
        """
        Initialize configuration.
        
        Args:
            overrides: Optional configuration overrides
        """
        self._lock = threading.RLock()
        self._config = {}
        self._initialized = False
        
        # Load configuration
        self.load_config(overrides)
    
    def load_config(self, overrides: Optional[Dict[str, Any]] = None) -> None:
        """
        Load configuration from all sources.
        
        Args:
            overrides: Optional configuration overrides
        """
        with self._lock:
            # Start with default configuration
            config = self._get_defaults()
            
            # Apply environment variables
            config = self._apply_env_vars(config)
            
            # Apply overrides
            if overrides:
                config = self._apply_overrides(config, overrides)
            
            # Apply inferred values
            config = self._apply_inferred_values(config)
            
            # Store configuration
            self._config = config
            self._initialized = True
            
            logger.info("Configuration loaded")
    
    def _get_defaults(self) -> Dict[str, Any]:
        """
        Get default configuration values.
        
        Returns:
            Default configuration
        """
        return {
            # Environment
            'math-env': 'dev',
            
            # Server
            'server': {
                'port': 8080,
                'host': 'localhost'
            },
            
            # Database
            'database': {
                'pool-size': 5,
                'max-overflow': 10
            },
            
            # Polling
            'poller': {
                'vote-interval': 1.0,  # seconds
                'mod-interval': 5.0,   # seconds
                'task-interval': 10.0, # seconds
                'allowlist': [],        # allowed conversation IDs
                'blocklist': []         # blocked conversation IDs
            },
            
            # Conversation
            'conversation': {
                'max-ptpts': 5000,      # maximum participants
                'max-cmts': 400,        # maximum comments
                'group-k-min': 2,       # minimum number of groups
                'group-k-max': 5        # maximum number of groups
            },
            
            # Logging
            'logging': {
                'level': 'warn'
            }
        }
    
    def _apply_env_vars(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply environment variables to configuration.
        
        Args:
            config: Current configuration
            
        Returns:
            Updated configuration
        """
        # Make a copy
        config = deepcopy(config)
        
        # Environment
        if 'MATH_ENV' in os.environ:
            config['math-env'] = os.environ['MATH_ENV']
        
        # Server
        config['server']['port'] = to_int(os.environ.get('PORT', config['server']['port']))
        config['server']['host'] = os.environ.get('HOST', config['server']['host'])
        
        # Database
        config['database']['pool-size'] = to_int(os.environ.get('DATABASE_POOL_SIZE', config['database']['pool-size']))
        config['database']['max-overflow'] = to_int(os.environ.get('DATABASE_MAX_OVERFLOW', config['database']['max-overflow']))
        
        # Polling
        config['poller']['vote-interval'] = to_float(os.environ.get('POLL_VOTE_INTERVAL_MS', to_float(os.environ.get('POLL_INTERVAL_MS', config['poller']['vote-interval'] * 1000)))) / 1000.0
        config['poller']['mod-interval'] = to_float(os.environ.get('POLL_MOD_INTERVAL_MS', to_float(os.environ.get('POLL_INTERVAL_MS', config['poller']['mod-interval'] * 1000)))) / 1000.0
        config['poller']['task-interval'] = to_float(os.environ.get('POLL_TASK_INTERVAL_MS', to_float(os.environ.get('POLL_INTERVAL_MS', config['poller']['task-interval'] * 1000)))) / 1000.0
        config['poller']['allowlist'] = to_int_list(os.environ.get('POLL_ALLOWLIST', []))
        config['poller']['blocklist'] = to_int_list(os.environ.get('POLL_BLOCKLIST', []))
        
        # Conversation
        config['conversation']['max-ptpts'] = to_int(os.environ.get('CONV_MAX_PTPTS', config['conversation']['max-ptpts']))
        config['conversation']['max-cmts'] = to_int(os.environ.get('CONV_MAX_CMTS', config['conversation']['max-cmts']))
        config['conversation']['group-k-min'] = to_int(os.environ.get('CONV_GROUP_K_MIN', config['conversation']['group-k-min']))
        config['conversation']['group-k-max'] = to_int(os.environ.get('CONV_GROUP_K_MAX', config['conversation']['group-k-max']))
        
        # Logging
        config['logging']['level'] = os.environ.get('LOG_LEVEL', config['logging']['level']).lower()
        
        return config
    
    def _apply_overrides(self, config: Dict[str, Any], overrides: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply configuration overrides.
        
        Args:
            config: Current configuration
            overrides: Configuration overrides
            
        Returns:
            Updated configuration
        """
        # Make a copy
        config = deepcopy(config)
        
        # Helper function for deep update
        def deep_update(d, u):
            for k, v in u.items():
                if isinstance(v, dict) and k in d and isinstance(d[k], dict):
                    d[k] = deep_update(d[k], v)
                else:
                    d[k] = v
            return d
        
        # Apply overrides
        return deep_update(config, overrides)
    
    def _apply_inferred_values(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply inferred configuration values.
        
        Args:
            config: Current configuration
            
        Returns:
            Updated configuration
        """
        # Make a copy
        config = deepcopy(config)
        
        # Set math-env-string
        config['math-env-string'] = str(config['math-env'])
        
        # Set webserver-url based on environment
        if config['math-env'] == 'prod':
            config['webserver-url'] = "https://pol.is"
        elif config['math-env'] == 'preprod':
            config['webserver-url'] = "https://preprod.pol.is"
        else:
            config['webserver-url'] = f"http://{config['server']['host']}:{config['server']['port']}"
        
        return config
    
    def get(self, path: str, default: Any = None) -> Any:
        """
        Get a configuration value.
        
        Args:
            path: Configuration path (dot-separated)
            default: Default value if not found
            
        Returns:
            Configuration value, or default if not found
        """
        if not self._initialized:
            self.load_config()
        
        # Split path into components
        components = path.split('.')
        
        # Start with full configuration
        value = self._config
        
        # Traverse path
        for component in components:
            if isinstance(value, dict) and component in value:
                value = value[component]
            else:
                return default
        
        return value
    
    def set(self, path: str, value: Any) -> None:
        """
        Set a configuration value.
        
        Args:
            path: Configuration path (dot-separated)
            value: Configuration value
        """
        with self._lock:
            if not self._initialized:
                self.load_config()
            
            # Split path into components
            components = path.split('.')
            
            # Start with full configuration
            config = self._config
            
            # Traverse path
            for i, component in enumerate(components[:-1]):
                if component not in config:
                    config[component] = {}
                
                config = config[component]
            
            # Set value
            config[components[-1]] = value
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Convert configuration to a dictionary.
        
        Returns:
            Configuration dictionary
        """
        if not self._initialized:
            self.load_config()
        
        return deepcopy(self._config)
    
    def save_to_file(self, filepath: str) -> None:
        """
        Save configuration to a file.
        
        Args:
            filepath: Path to save configuration
        """
        if not self._initialized:
            self.load_config()
        
        # Determine file format from extension
        if filepath.endswith('.json'):
            with open(filepath, 'w') as f:
                json.dump(self._config, f, indent=2)
        elif filepath.endswith('.yaml') or filepath.endswith('.yml'):
            with open(filepath, 'w') as f:
                yaml.dump(self._config, f, default_flow_style=False)
        else:
            raise ValueError(f"Unsupported file format: {filepath}")
    
    def load_from_file(self, filepath: str) -> None:
        """
        Load configuration from a file.
        
        Args:
            filepath: Path to load configuration from
        """
        # Determine file format from extension
        if filepath.endswith('.json'):
            with open(filepath, 'r') as f:
                overrides = json.load(f)
        elif filepath.endswith('.yaml') or filepath.endswith('.yml'):
            with open(filepath, 'r') as f:
                overrides = yaml.safe_load(f)
        else:
            raise ValueError(f"Unsupported file format: {filepath}")
        
        # Apply overrides
        self.load_config(overrides)


class ConfigManager:
    """
    Singleton manager for configuration.
    """
    
    _instance = None
    _lock = threading.RLock()
    
    @classmethod
    def get_config(cls, overrides: Optional[Dict[str, Any]] = None) -> Config:
        """
        Get the configuration instance.
        
        Args:
            overrides: Optional configuration overrides
            
        Returns:
            Config instance
        """
        with cls._lock:
            if cls._instance is None:
                cls._instance = Config(overrides)
            elif overrides:
                cls._instance.load_config(overrides)
            
            return cls._instance