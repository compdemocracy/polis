"""
System integration for Pol.is math.

This module provides the main system integration for the Pol.is math system,
tying together all components.
"""

import logging
import threading
import time
import signal
import os
from typing import Dict, List, Optional, Tuple, Union, Any, Set, Callable
import atexit

from polismath.components.config import Config, ConfigManager
from polismath.conversation import ConversationManager
from polismath.poller import Poller, PollerManager
from polismath.components.server import Server, ServerManager
from polismath.database import PostgresManager

# Set up logging
logger = logging.getLogger(__name__)


class System:
    """
    Main system for Pol.is math.
    """
    
    def __init__(self, config: Optional[Config] = None):
        """
        Initialize the system.
        
        Args:
            config: Configuration for the system
        """
        # Set up configuration
        self.config = config or ConfigManager.get_config()
        
        # Set up components
        self.db = None
        self.conversation_manager = None
        self.poller = None
        self.server = None
        
        # System status
        self._running = False
        self._stop_event = threading.Event()
    
    def initialize(self) -> None:
        """
        Initialize the system.
        """
        if self._running:
            return
        
        logger.info("Initializing system")
        
        # Initialize database
        self.db = PostgresManager.get_client()
        
        # Initialize conversation manager
        data_dir = self.config.get('data_dir')
        self.conversation_manager = ConversationManager(data_dir)
        
        # Initialize poller
        self.poller = PollerManager.get_poller(self.conversation_manager, self.config)
        
        # Initialize server
        self.server = ServerManager.get_server(self.conversation_manager, self.config)
        
        logger.info("System initialized")
    
    def start(self) -> None:
        """
        Start the system.
        """
        if self._running:
            return
        
        # Initialize if needed
        self.initialize()
        
        logger.info("Starting system")
        
        # Clear stop event
        self._stop_event.clear()
        
        # Start server
        self.server.start()
        
        # Start poller
        self.poller.start()
        
        # Mark as running
        self._running = True
        
        # Register shutdown handlers
        self._register_shutdown_handlers()
        
        logger.info("System started")
    
    def stop(self) -> None:
        """
        Stop the system.
        """
        if not self._running:
            return
        
        logger.info("Stopping system")
        
        # Set stop event
        self._stop_event.set()
        
        # Stop components in reverse order
        if self.poller:
            self.poller.stop()
        
        if self.server:
            self.server.stop()
        
        if self.db:
            self.db = None
        
        # Mark as not running
        self._running = False
        
        logger.info("System stopped")
    
    def _register_shutdown_handlers(self) -> None:
        """
        Register shutdown handlers.
        """
        # Register signal handlers
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, self._signal_handler)
        
        # Register atexit handler
        atexit.register(self.stop)
    
    def _signal_handler(self, signum: int, frame: Any) -> None:
        """
        Handle signals.
        
        Args:
            signum: Signal number
            frame: Current stack frame
        """
        logger.info(f"Received signal {signum}")
        self.stop()
    
    def wait_for_shutdown(self) -> None:
        """
        Wait for system shutdown.
        """
        self._stop_event.wait()


class SystemManager:
    """
    Singleton manager for the system.
    """
    
    _instance = None
    _lock = threading.RLock()
    
    @classmethod
    def get_system(cls, config: Optional[Config] = None) -> System:
        """
        Get the system instance.
        
        Args:
            config: Configuration for the system
            
        Returns:
            System instance
        """
        with cls._lock:
            if cls._instance is None:
                cls._instance = System(config)
            
            return cls._instance
    
    @classmethod
    def start(cls, config: Optional[Config] = None) -> System:
        """
        Start the system.
        
        Args:
            config: Configuration for the system
            
        Returns:
            System instance
        """
        system = cls.get_system(config)
        system.start()
        return system
    
    @classmethod
    def stop(cls) -> None:
        """
        Stop the system.
        """
        with cls._lock:
            if cls._instance is not None:
                cls._instance.stop()
                cls._instance = None