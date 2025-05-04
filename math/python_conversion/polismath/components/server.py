"""
Server component for Pol.is math.

This module provides a FastAPI server for exposing Pol.is math functionality.
"""

import os
import json
import logging
import threading
import time
from typing import Dict, List, Optional, Tuple, Union, Any, Set, Callable
from datetime import datetime

import fastapi
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from polismath.components.config import Config, ConfigManager
from polismath.conversation import ConversationManager
from polismath.poller import PollerManager
from polismath.database import PostgresManager

# Set up logging
logger = logging.getLogger(__name__)


# Define API models
class Vote(BaseModel):
    """Vote data model."""
    
    pid: str
    tid: str
    vote: Union[int, str]


class VoteRequest(BaseModel):
    """Vote request model."""
    
    votes: List[Vote]


class ModerationRequest(BaseModel):
    """Moderation request model."""
    
    mod_out_tids: Optional[List[str]] = None
    mod_in_tids: Optional[List[str]] = None
    meta_tids: Optional[List[str]] = None
    mod_out_ptpts: Optional[List[str]] = None


class MathRequest(BaseModel):
    """Math processing request model."""
    
    conversation_id: str


class Server:
    """
    FastAPI server for Pol.is math.
    """
    
    def __init__(self, 
                conversation_manager: ConversationManager,
                config: Optional[Config] = None):
        """
        Initialize a server.
        
        Args:
            conversation_manager: Conversation manager
            config: Configuration for the server
        """
        self.conversation_manager = conversation_manager
        self.config = config or ConfigManager.get_config()
        
        # Create FastAPI app
        self.app = FastAPI(
            title="Pol.is Math API",
            description="API for Pol.is mathematical processing",
            version="0.1.0"
        )
        
        # Set up CORS
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        
        # Database client
        self.db = PostgresManager.get_client()
        
        # Set up routes
        self._setup_routes()
        
        # Set up request validation
        self._setup_validation()
        
        # Set up error handling
        self._setup_error_handling()
        
        # Server status
        self._running = False
        self._server_thread = None
        self._uvicorn = None
    
    def _setup_routes(self) -> None:
        """
        Set up API routes.
        """
        # Health check
        @self.app.get("/health")
        async def health_check():
            return {"status": "ok"}
        
        # Vote processing
        @self.app.post("/api/v3/votes/{conversation_id}")
        async def process_votes(conversation_id: str, vote_request: VoteRequest):
            # Convert to format expected by conversation manager
            votes = {
                "votes": [
                    {
                        "pid": vote.pid,
                        "tid": vote.tid,
                        "vote": vote.vote
                    }
                    for vote in vote_request.votes
                ]
            }
            
            # Process votes
            conv = self.conversation_manager.process_votes(conversation_id, votes)
            
            # Return summary
            return conv.get_summary()
        
        # Moderation
        @self.app.post("/api/v3/moderation/{conversation_id}")
        async def update_moderation(conversation_id: str, mod_request: ModerationRequest):
            # Convert to format expected by conversation manager
            moderation = {
                "mod_out_tids": mod_request.mod_out_tids or [],
                "mod_in_tids": mod_request.mod_in_tids or [],
                "meta_tids": mod_request.meta_tids or [],
                "mod_out_ptpts": mod_request.mod_out_ptpts or []
            }
            
            # Update moderation
            conv = self.conversation_manager.update_moderation(conversation_id, moderation)
            
            if not conv:
                raise HTTPException(status_code=404, detail="Conversation not found")
            
            # Return summary
            return conv.get_summary()
        
        # Recompute
        @self.app.post("/api/v3/math/{conversation_id}")
        async def recompute(conversation_id: str):
            # Recompute
            conv = self.conversation_manager.recompute(conversation_id)
            
            if not conv:
                raise HTTPException(status_code=404, detail="Conversation not found")
            
            # Return summary
            return conv.get_summary()
        
        # Get conversation data
        @self.app.get("/api/v3/conversations/{conversation_id}")
        async def get_conversation(conversation_id: str):
            # Get conversation
            conv = self.conversation_manager.get_conversation(conversation_id)
            
            if not conv:
                raise HTTPException(status_code=404, detail="Conversation not found")
            
            # Return full data
            return conv.get_full_data()
        
        # List conversations
        @self.app.get("/api/v3/conversations")
        async def list_conversations():
            # Get summaries of all conversations
            return self.conversation_manager.get_summary()
    
    def _setup_validation(self) -> None:
        """
        Set up request validation.
        """
        @self.app.exception_handler(fastapi.exceptions.RequestValidationError)
        async def validation_exception_handler(request, exc):
            return JSONResponse(
                status_code=422,
                content={"detail": str(exc)}
            )
    
    def _setup_error_handling(self) -> None:
        """
        Set up error handling.
        """
        @self.app.exception_handler(Exception)
        async def generic_exception_handler(request, exc):
            logger.exception("Unhandled exception")
            return JSONResponse(
                status_code=500,
                content={"detail": "Internal server error"}
            )
    
    def start(self) -> None:
        """
        Start the server.
        """
        if self._running:
            return
        
        # Import uvicorn here to avoid circular imports
        import uvicorn
        self._uvicorn = uvicorn
        
        # Get port and host
        port = self.config.get('server.port', 8080)
        host = self.config.get('server.host', '0.0.0.0')
        
        # Start in a separate thread
        def run_server():
            self._uvicorn.run(
                self.app,
                host=host,
                port=port,
                log_level=self.config.get('logging.level', 'info')
            )
        
        self._server_thread = threading.Thread(
            target=run_server,
            daemon=True
        )
        self._server_thread.start()
        
        self._running = True
        
        logger.info(f"Server started at http://{host}:{port}")
    
    def stop(self) -> None:
        """
        Stop the server.
        """
        if not self._running:
            return
        
        # There's no clean way to stop uvicorn, so we'll just set the flag
        self._running = False
        
        logger.info("Server stopping (full shutdown requires process restart)")


class ServerManager:
    """
    Singleton manager for the server.
    """
    
    _instance = None
    _lock = threading.RLock()
    
    @classmethod
    def get_server(cls, 
                 conversation_manager: ConversationManager,
                 config: Optional[Config] = None) -> Server:
        """
        Get the server instance.
        
        Args:
            conversation_manager: Conversation manager
            config: Configuration
            
        Returns:
            Server instance
        """
        with cls._lock:
            if cls._instance is None:
                cls._instance = Server(conversation_manager, config)
            
            return cls._instance
    
    @classmethod
    def shutdown(cls) -> None:
        """
        Shut down the server.
        """
        with cls._lock:
            if cls._instance is not None:
                cls._instance.stop()
                cls._instance = None