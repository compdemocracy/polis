"""
Database polling implementation for Pol.is math.

This module provides functionality for polling the database for new votes,
moderation actions, and tasks, and sending them to the conversation manager
for processing.
"""

import asyncio
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Union, Any, Set, Callable
import queue
import json

from polismath.database import PostgresManager
from polismath.conversation import ConversationManager
from polismath.components.config import Config

# Set up logging
logger = logging.getLogger(__name__)


class Poller:
    """
    Polls the database for new votes, moderation actions, and tasks.
    """
    
    def __init__(self, 
                conversation_manager: ConversationManager,
                config: Optional[Config] = None):
        """
        Initialize a poller.
        
        Args:
            conversation_manager: Conversation manager to send updates to
            config: Configuration for the poller
        """
        self.conversation_manager = conversation_manager
        self.config = config or Config()
        
        # Get database client
        self.db = PostgresManager.get_client()
        
        # Timestamps for polling
        self._last_vote_timestamps: Dict[int, datetime] = {}
        self._last_mod_timestamps: Dict[int, datetime] = {}
        
        # Default to polling from 10 days ago
        self._default_timestamp = datetime.now() - timedelta(days=10)
        
        # Status flags
        self._running = False
        self._threads = []
        self._stop_event = threading.Event()
        
        # Conversation allowlist/blocklist
        self._allowlist = self.config.get('poller.allowlist', [])
        self._blocklist = self.config.get('poller.blocklist', [])
        
        # Queue for tasks to process
        self._task_queue = queue.Queue()
        
        # Polling intervals
        self._vote_interval = self.config.get('poller.vote_interval', 1.0)
        self._mod_interval = self.config.get('poller.mod_interval', 5.0)
        self._task_interval = self.config.get('poller.task_interval', 10.0)
    
    def start(self) -> None:
        """
        Start the poller.
        """
        if self._running:
            return
        
        self._running = True
        self._stop_event.clear()
        
        # Start vote polling thread
        vote_thread = threading.Thread(
            target=self._vote_polling_loop,
            name="vote-poller"
        )
        vote_thread.daemon = True
        vote_thread.start()
        self._threads.append(vote_thread)
        
        # Start moderation polling thread
        mod_thread = threading.Thread(
            target=self._mod_polling_loop,
            name="mod-poller"
        )
        mod_thread.daemon = True
        mod_thread.start()
        self._threads.append(mod_thread)
        
        # Start task polling thread
        task_thread = threading.Thread(
            target=self._task_polling_loop,
            name="task-poller"
        )
        task_thread.daemon = True
        task_thread.start()
        self._threads.append(task_thread)
        
        # Start task processing thread
        process_thread = threading.Thread(
            target=self._task_processing_loop,
            name="task-processor"
        )
        process_thread.daemon = True
        process_thread.start()
        self._threads.append(process_thread)
        
        logger.info("Poller started")
    
    def stop(self) -> None:
        """
        Stop the poller.
        """
        if not self._running:
            return
        
        self._running = False
        self._stop_event.set()
        
        # Wait for threads to terminate
        for thread in self._threads:
            thread.join(timeout=5.0)
        
        self._threads = []
        
        logger.info("Poller stopped")
    
    def _should_process_conversation(self, zid: int) -> bool:
        """
        Check if a conversation should be processed.
        
        Args:
            zid: Conversation ID
            
        Returns:
            True if the conversation should be processed
        """
        # Check allowlist
        if self._allowlist and zid not in self._allowlist:
            return False
        
        # Check blocklist
        if zid in self._blocklist:
            return False
        
        return True
    
    def _vote_polling_loop(self) -> None:
        """
        Main loop for polling for new votes.
        """
        logger.info("Vote polling loop started")
        
        while not self._stop_event.is_set():
            try:
                # Poll for new votes
                self._poll_votes()
                
                # Sleep until next poll
                self._stop_event.wait(self._vote_interval)
            except Exception as e:
                logger.error(f"Error in vote polling loop: {e}")
                self._stop_event.wait(self._vote_interval)
    
    def _mod_polling_loop(self) -> None:
        """
        Main loop for polling for new moderation actions.
        """
        logger.info("Moderation polling loop started")
        
        while not self._stop_event.is_set():
            try:
                # Poll for new moderation actions
                self._poll_moderation()
                
                # Sleep until next poll
                self._stop_event.wait(self._mod_interval)
            except Exception as e:
                logger.error(f"Error in moderation polling loop: {e}")
                self._stop_event.wait(self._mod_interval)
    
    def _task_polling_loop(self) -> None:
        """
        Main loop for polling for new tasks.
        """
        logger.info("Task polling loop started")
        
        while not self._stop_event.is_set():
            try:
                # Poll for new tasks
                self._poll_tasks()
                
                # Sleep until next poll
                self._stop_event.wait(self._task_interval)
            except Exception as e:
                logger.error(f"Error in task polling loop: {e}")
                self._stop_event.wait(self._task_interval)
    
    def _task_processing_loop(self) -> None:
        """
        Main loop for processing tasks.
        """
        logger.info("Task processing loop started")
        
        while not self._stop_event.is_set():
            try:
                # Get task from queue (with timeout)
                try:
                    task = self._task_queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                
                # Process task
                self._process_task(task)
                
                # Mark task as done
                self._task_queue.task_done()
            except Exception as e:
                logger.error(f"Error in task processing loop: {e}")
                time.sleep(1.0)
    
    def _poll_votes(self) -> None:
        """
        Poll for new votes.
        """
        # Get all active conversation IDs
        zids = self._get_active_conversation_ids()
        
        # Check if we have any conversations to poll
        if not zids:
            return
        
        # Poll each conversation
        for zid in zids:
            # Skip if conversation should not be processed
            if not self._should_process_conversation(zid):
                continue
            
            # Get last timestamp for this conversation
            last_timestamp = self._last_vote_timestamps.get(zid, self._default_timestamp)
            
            try:
                # Poll for new votes
                votes = self.db.poll_votes(zid, last_timestamp)
                
                # Skip if no new votes
                if not votes:
                    continue
                
                # Get latest timestamp
                latest_timestamp = max(v["created"] for v in votes)
                
                # Update last timestamp
                self._last_vote_timestamps[zid] = latest_timestamp
                
                # Format votes for processing
                vote_data = {
                    "votes": votes,
                    "lastVoteTimestamp": latest_timestamp
                }
                
                # Process votes
                self.conversation_manager.process_votes(str(zid), vote_data)
                
                logger.info(f"Processed {len(votes)} new votes for conversation {zid}")
            except Exception as e:
                logger.error(f"Error polling votes for conversation {zid}: {e}")
    
    def _poll_moderation(self) -> None:
        """
        Poll for new moderation actions.
        """
        # Get all active conversation IDs
        zids = self._get_active_conversation_ids()
        
        # Check if we have any conversations to poll
        if not zids:
            return
        
        # Poll each conversation
        for zid in zids:
            # Skip if conversation should not be processed
            if not self._should_process_conversation(zid):
                continue
            
            # Get last timestamp for this conversation
            last_timestamp = self._last_mod_timestamps.get(zid, self._default_timestamp)
            
            try:
                # Poll for new moderation actions
                moderation = self.db.poll_moderation(zid, last_timestamp)
                
                # Skip if no new moderation actions
                if not any(moderation.values()):
                    continue
                
                # Update last timestamp
                self._last_mod_timestamps[zid] = datetime.now()
                
                # Process moderation
                self.conversation_manager.update_moderation(str(zid), moderation)
                
                logger.info(f"Processed new moderation actions for conversation {zid}")
            except Exception as e:
                logger.error(f"Error polling moderation for conversation {zid}: {e}")
    
    def _poll_tasks(self) -> None:
        """
        Poll for new tasks.
        """
        try:
            # Poll for new tasks
            tasks = self.db.poll_tasks("math_process", limit=10)
            
            # Add tasks to queue
            for task in tasks:
                self._task_queue.put(task)
            
            if tasks:
                logger.info(f"Added {len(tasks)} new tasks to queue")
        except Exception as e:
            logger.error(f"Error polling tasks: {e}")
    
    def _process_task(self, task: Dict[str, Any]) -> None:
        """
        Process a task.
        
        Args:
            task: Task data
        """
        task_id = task["id"]
        task_data = task["task_data"]
        
        try:
            # Get task type
            task_type = task_data.get("task_type")
            
            if task_type == "recompute":
                # Recompute conversation
                zid = task_data.get("zid")
                
                if zid:
                    # Convert to string
                    zid_str = str(zid)
                    
                    # Recompute
                    self.conversation_manager.recompute(zid_str)
                    
                    logger.info(f"Recomputed conversation {zid}")
                else:
                    logger.error(f"Missing zid in task {task_id}")
            else:
                logger.warning(f"Unknown task type: {task_type}")
            
            # Mark task as complete
            self.db.mark_task_complete(task_id)
        except Exception as e:
            logger.error(f"Error processing task {task_id}: {e}")
    
    def _get_active_conversation_ids(self) -> List[int]:
        """
        Get IDs of all active conversations.
        
        Returns:
            List of conversation IDs
        """
        # Get conversations from manager
        conversations = self.conversation_manager.get_summary()
        
        # Extract IDs and convert to integers
        zids = []
        for conv_id in conversations.keys():
            try:
                zid = int(conv_id)
                zids.append(zid)
            except ValueError:
                pass
        
        return zids
    
    def add_conversation(self, zid: int) -> None:
        """
        Add a conversation to the poller.
        
        Args:
            zid: Conversation ID
        """
        # Make sure conversation is loaded
        try:
            # Try to load from database
            math_data = self.db.load_math_main(zid)
            
            if math_data and math_data.get("data"):
                # Create conversation from data
                self.conversation_manager.import_conversation_from_data(str(zid), math_data["data"])
                
                # Update timestamps
                if math_data.get("last_vote_timestamp"):
                    self._last_vote_timestamps[zid] = math_data["last_vote_timestamp"]
                
                if math_data.get("last_mod_timestamp"):
                    self._last_mod_timestamps[zid] = math_data["last_mod_timestamp"]
                
                logger.info(f"Loaded conversation {zid} from database")
            else:
                # Create new conversation
                self.conversation_manager.create_conversation(str(zid))
                
                logger.info(f"Created new conversation {zid}")
        except Exception as e:
            logger.error(f"Error adding conversation {zid}: {e}")
    
    def remove_conversation(self, zid: int) -> None:
        """
        Remove a conversation from the poller.
        
        Args:
            zid: Conversation ID
        """
        # Remove timestamps
        if zid in self._last_vote_timestamps:
            del self._last_vote_timestamps[zid]
        
        if zid in self._last_mod_timestamps:
            del self._last_mod_timestamps[zid]
        
        # Remove conversation
        self.conversation_manager.delete_conversation(str(zid))
        
        logger.info(f"Removed conversation {zid}")
    
    def load_recent_conversations(self, days: int = 30) -> None:
        """
        Load recent active conversations.
        
        Args:
            days: Number of days to look back
        """
        try:
            # SQL to find active conversations
            sql = """
            SELECT DISTINCT zid
            FROM votes
            WHERE created > NOW() - INTERVAL ':days days'
            """
            
            # Execute query
            results = self.db.query(sql, {"days": days})
            
            # Load each conversation
            for row in results:
                zid = row["zid"]
                
                if self._should_process_conversation(zid):
                    self.add_conversation(zid)
            
            logger.info(f"Loaded {len(results)} recent conversations")
        except Exception as e:
            logger.error(f"Error loading recent conversations: {e}")


class PollerManager:
    """
    Singleton manager for the poller.
    """
    
    _instance = None
    _lock = threading.RLock()
    
    @classmethod
    def get_poller(cls, 
                  conversation_manager: ConversationManager,
                  config: Optional[Config] = None) -> Poller:
        """
        Get the poller instance.
        
        Args:
            conversation_manager: Conversation manager
            config: Configuration
            
        Returns:
            Poller instance
        """
        with cls._lock:
            if cls._instance is None:
                cls._instance = Poller(conversation_manager, config)
            
            return cls._instance
    
    @classmethod
    def shutdown(cls) -> None:
        """
        Shut down the poller.
        """
        with cls._lock:
            if cls._instance is not None:
                cls._instance.stop()
                cls._instance = None