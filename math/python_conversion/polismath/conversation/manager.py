"""
Conversation manager for handling multiple conversations.

This module provides a manager that can handle multiple conversations,
process votes, and perform clustering calculations.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Union, Any, Set, Callable
from copy import deepcopy
import time
import logging
import threading
import json
import os
from datetime import datetime

from polismath.conversation.conversation import Conversation


# Logging configuration
logger = logging.getLogger(__name__)


class ConversationManager:
    """
    Manages multiple Pol.is conversations.
    """
    
    def __init__(self, data_dir: Optional[str] = None):
        """
        Initialize a conversation manager.
        
        Args:
            data_dir: Directory for storing conversation data
        """
        self.conversations: Dict[str, Conversation] = {}
        self.data_dir = data_dir
        self.lock = threading.RLock()
        
        # Load conversations from data directory if provided
        if data_dir and os.path.exists(data_dir):
            self._load_conversations()
    
    def _load_conversations(self) -> None:
        """
        Load conversations from the data directory.
        """
        if not self.data_dir:
            return
        
        logger.info(f"Loading conversations from {self.data_dir}")
        
        with self.lock:
            # Find all conversation files
            files = [f for f in os.listdir(self.data_dir) 
                   if f.endswith('.json') and os.path.isfile(os.path.join(self.data_dir, f))]
            
            for file in files:
                try:
                    # Extract conversation ID from filename
                    conv_id = file.replace('.json', '')
                    
                    # Load conversation data
                    with open(os.path.join(self.data_dir, file), 'r') as f:
                        data = json.load(f)
                    
                    # Create conversation
                    conv = Conversation.from_dict(data)
                    
                    # Add to conversations
                    self.conversations[conv_id] = conv
                    
                    logger.info(f"Loaded conversation {conv_id}")
                except Exception as e:
                    logger.error(f"Error loading conversation from {file}: {e}")
        
        logger.info(f"Loaded {len(self.conversations)} conversations")
    
    def _save_conversation(self, conversation_id: str) -> None:
        """
        Save a conversation to the data directory.
        
        Args:
            conversation_id: ID of the conversation to save
        """
        if not self.data_dir:
            return
        
        # Make sure data directory exists
        os.makedirs(self.data_dir, exist_ok=True)
        
        with self.lock:
            # Get the conversation
            conv = self.conversations.get(conversation_id)
            
            if conv:
                # Convert to dictionary
                data = conv.to_dict()
                
                # Save to file
                file_path = os.path.join(self.data_dir, f"{conversation_id}.json")
                with open(file_path, 'w') as f:
                    json.dump(data, f)
                
                logger.info(f"Saved conversation {conversation_id}")
    
    def get_conversation(self, conversation_id: str) -> Optional[Conversation]:
        """
        Get a conversation by ID.
        
        Args:
            conversation_id: ID of the conversation to get
            
        Returns:
            Conversation object, or None if not found
        """
        with self.lock:
            return self.conversations.get(conversation_id)
    
    def create_conversation(self, 
                          conversation_id: str,
                          votes: Optional[Dict[str, Any]] = None) -> Conversation:
        """
        Create a new conversation.
        
        Args:
            conversation_id: ID for the new conversation
            votes: Optional initial votes
            
        Returns:
            The created conversation
        """
        with self.lock:
            # Check if conversation already exists
            if conversation_id in self.conversations:
                return self.conversations[conversation_id]
            
            # Create new conversation
            conv = Conversation(conversation_id, votes=votes)
            
            # Add to conversations
            self.conversations[conversation_id] = conv
            
            # Save conversation
            self._save_conversation(conversation_id)
            
            return conv
    
    def process_votes(self, 
                     conversation_id: str, 
                     votes: Dict[str, Any]) -> Conversation:
        """
        Process votes for a conversation.
        
        Args:
            conversation_id: ID of the conversation
            votes: Vote data to process
            
        Returns:
            Updated conversation
        """
        with self.lock:
            # Get or create conversation
            conv = self.get_conversation(conversation_id)
            
            if not conv:
                conv = self.create_conversation(conversation_id)
            
            # Update with votes
            updated_conv = conv.update_votes(votes)
            
            # Store updated conversation
            self.conversations[conversation_id] = updated_conv
            
            # Save conversation
            self._save_conversation(conversation_id)
            
            return updated_conv
    
    def update_moderation(self, 
                         conversation_id: str,
                         moderation: Dict[str, Any]) -> Optional[Conversation]:
        """
        Update moderation settings for a conversation.
        
        Args:
            conversation_id: ID of the conversation
            moderation: Moderation settings to apply
            
        Returns:
            Updated conversation, or None if conversation not found
        """
        with self.lock:
            # Get conversation
            conv = self.get_conversation(conversation_id)
            
            if not conv:
                return None
            
            # Update moderation
            updated_conv = conv.update_moderation(moderation)
            
            # Store updated conversation
            self.conversations[conversation_id] = updated_conv
            
            # Save conversation
            self._save_conversation(conversation_id)
            
            return updated_conv
    
    def recompute(self, conversation_id: str) -> Optional[Conversation]:
        """
        Recompute derived data for a conversation.
        
        Args:
            conversation_id: ID of the conversation
            
        Returns:
            Updated conversation, or None if conversation not found
        """
        with self.lock:
            # Get conversation
            conv = self.get_conversation(conversation_id)
            
            if not conv:
                return None
            
            # Recompute
            updated_conv = conv.recompute()
            
            # Store updated conversation
            self.conversations[conversation_id] = updated_conv
            
            # Save conversation
            self._save_conversation(conversation_id)
            
            return updated_conv
    
    def get_summary(self) -> Dict[str, Any]:
        """
        Get a summary of all conversations.
        
        Returns:
            Dictionary with conversation summaries
        """
        summaries = {}
        
        with self.lock:
            for conv_id, conv in self.conversations.items():
                summaries[conv_id] = conv.get_summary()
        
        return summaries
    
    def export_conversation(self, 
                          conversation_id: str, 
                          filepath: str) -> bool:
        """
        Export a conversation to a JSON file.
        
        Args:
            conversation_id: ID of the conversation
            filepath: Path to save the JSON file
            
        Returns:
            True if export was successful, False otherwise
        """
        with self.lock:
            # Get conversation
            conv = self.get_conversation(conversation_id)
            
            if not conv:
                return False
            
            # Export to file
            data = conv.to_dict()
            
            try:
                with open(filepath, 'w') as f:
                    json.dump(data, f)
                return True
            except Exception as e:
                logger.error(f"Error exporting conversation {conversation_id}: {e}")
                return False
    
    def import_conversation(self, filepath: str) -> Optional[str]:
        """
        Import a conversation from a JSON file.
        
        Args:
            filepath: Path to the JSON file
            
        Returns:
            Conversation ID if import was successful, None otherwise
        """
        try:
            # Load data from file
            with open(filepath, 'r') as f:
                data = json.load(f)
            
            # Create conversation
            conv_id = data.get('conversation_id')
            
            if not conv_id:
                logger.error("Conversation ID missing in import file")
                return None
            
            with self.lock:
                # Create conversation
                conv = Conversation.from_dict(data)
                
                # Store conversation
                self.conversations[conv_id] = conv
                
                # Save conversation
                self._save_conversation(conv_id)
            
            return conv_id
        except Exception as e:
            logger.error(f"Error importing conversation: {e}")
            return None
    
    def delete_conversation(self, conversation_id: str) -> bool:
        """
        Delete a conversation.
        
        Args:
            conversation_id: ID of the conversation to delete
            
        Returns:
            True if deletion was successful, False otherwise
        """
        with self.lock:
            # Check if conversation exists
            if conversation_id not in self.conversations:
                return False
            
            # Remove from memory
            del self.conversations[conversation_id]
            
            # Remove file if data directory is set
            if self.data_dir:
                file_path = os.path.join(self.data_dir, f"{conversation_id}.json")
                if os.path.exists(file_path):
                    os.remove(file_path)
            
            return True