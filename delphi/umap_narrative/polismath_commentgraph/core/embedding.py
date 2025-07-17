"""
Core embedding functionality for the Polis comment graph microservice.
"""

import numpy as np
from typing import List, Dict, Any, Optional, Union
from sentence_transformers import SentenceTransformer
import logging
import os
import time
from pathlib import Path
import torch

logger = logging.getLogger(__name__)

class EmbeddingEngine:
    """
    Generates and manages comment embeddings using SentenceTransformer.
    Provides methods for embedding generation, similarity calculation,
    and nearest neighbor search.
    """
    
    def __init__(
        self, 
        model_name: Optional[str] = None,
        cache_dir: Optional[str] = None,
        device: Optional[str] = None
    ):
        """
        Initialize the embedding engine with a specific model.
        
        Args:
            model_name: The name of the SentenceTransformer model to use
            cache_dir: Optional directory to cache models
            device: Optional device to use (cpu, cuda, etc.)
        """
        # Get model name from environment variable or use provided name, with fallback to default
        if model_name is None:
            model_name = os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
        
        logger.info(f"Initializing embedding engine with model: {model_name}")
        self.model_name = model_name
        self._model = None  # Lazy-loaded
        self.vector_dim = 384  # Default for all-MiniLM-L6-v2 and paraphrase-multilingual-MiniLM-L12-v2
        
        # Set up cache directory
        self.cache_dir = cache_dir or os.environ.get("MODEL_CACHE_DIR")
        
        # Set up device
        if device:
            self.device = device
        elif torch.cuda.is_available():
            self.device = "cuda"
        else:
            self.device = "cpu"
        logger.info(f"Using device: {self.device}")
    
    @property
    def model(self) -> SentenceTransformer:
        """Lazy-load the model when first needed."""
        if self._model is None:
            start_time = time.time()
            logger.info(f"Loading SentenceTransformer model: {self.model_name}")
            
            try:
                # Load with cache dir if specified
                if self.cache_dir:
                    os.makedirs(self.cache_dir, exist_ok=True)
                    self._model = SentenceTransformer(
                        self.model_name, 
                        cache_folder=self.cache_dir,
                        device=self.device
                    )
                else:
                    self._model = SentenceTransformer(
                        self.model_name,
                        device=self.device
                    )
                
                self.vector_dim = self._model.get_sentence_embedding_dimension()
                logger.info(
                    f"SentenceTransformer model loaded in {time.time() - start_time:.2f}s. "
                    f"Vector dimension: {self.vector_dim}"
                )
            except Exception as e:
                logger.error(f"Error loading SentenceTransformer model: {str(e)}")
                # Fall back to a simple model that returns zeros
                logger.warning("Using fallback zero-vector model")
                self._model = None
                raise
                
        return self._model
    
    def embed_text(self, text: str) -> np.ndarray:
        """
        Generate an embedding vector for a single text string.
        
        Args:
            text: The text to embed
            
        Returns:
            A numpy array containing the embedding vector
        """
        if not text or not text.strip():
            # Return zero vector for empty text to avoid errors
            logger.warning("Received empty text for embedding. Returning zero vector.")
            return np.zeros(self.vector_dim)
        
        try:
            # Generate the embedding
            embedding = self.model.encode(text, convert_to_numpy=True)
            return embedding
        except Exception as e:
            logger.error(f"Error generating embedding: {str(e)}")
            return np.zeros(self.vector_dim)
    
    def embed_batch(
        self, 
        texts: List[str], 
        batch_size: int = 32,
        show_progress: bool = False
    ) -> np.ndarray:
        """
        Generate embeddings for a batch of texts.
        
        Args:
            texts: List of text strings to embed
            batch_size: Batch size for processing
            show_progress: Whether to show a progress bar
            
        Returns:
            A numpy array of shape (len(texts), embedding_dim)
        """
        if not texts:
            return np.array([])
        
        # Filter out empty texts to avoid errors
        valid_indices = []
        valid_texts = []
        
        for i, text in enumerate(texts):
            if text and text.strip():
                valid_indices.append(i)
                valid_texts.append(text)
        
        if not valid_texts:
            logger.warning("No valid texts in batch. Returning empty array.")
            return np.array([])
        
        try:
            # Generate embeddings for valid texts
            embeddings = self.model.encode(
                valid_texts, 
                convert_to_numpy=True, 
                batch_size=batch_size,
                show_progress_bar=show_progress
            )
            
            # Create result array with zeros for invalid texts
            result = np.zeros((len(texts), self.vector_dim))
            for i, idx in enumerate(valid_indices):
                result[idx] = embeddings[i]
            
            return result
        except Exception as e:
            logger.error(f"Error generating batch embeddings: {str(e)}")
            return np.zeros((len(texts), self.vector_dim))
    
    def calculate_similarity(
        self, 
        embedding1: np.ndarray, 
        embedding2: np.ndarray
    ) -> float:
        """
        Calculate cosine similarity between two embeddings.
        
        Args:
            embedding1: First embedding vector
            embedding2: Second embedding vector
            
        Returns:
            Cosine similarity score (float between -1 and 1)
        """
        # Normalize vectors to unit length
        norm1 = np.linalg.norm(embedding1)
        norm2 = np.linalg.norm(embedding2)
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
            
        # Calculate cosine similarity
        return np.dot(embedding1, embedding2) / (norm1 * norm2)
    
    def calculate_similarities(
        self,
        query_embedding: np.ndarray,
        embeddings: np.ndarray
    ) -> np.ndarray:
        """
        Calculate cosine similarities between a query and multiple embeddings.
        
        Args:
            query_embedding: The query embedding vector
            embeddings: Matrix of embedding vectors to compare against
            
        Returns:
            Array of similarity scores
        """
        if len(embeddings) == 0:
            return np.array([])
            
        # Normalize query vector
        query_norm = np.linalg.norm(query_embedding)
        if query_norm == 0:
            query_normalized = query_embedding
        else:
            query_normalized = query_embedding / query_norm
            
        # Normalize all embeddings
        embedding_norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        embedding_norms[embedding_norms == 0] = 1.0  # Avoid division by zero
        embeddings_normalized = embeddings / embedding_norms
        
        # Calculate similarities using dot product of normalized vectors
        similarities = np.dot(embeddings_normalized, query_normalized)
        
        return similarities
    
    def find_nearest_neighbors(
        self, 
        query_embedding: np.ndarray, 
        embeddings: np.ndarray, 
        k: int = 5,
        include_distances: bool = True
    ) -> Dict[str, List]:
        """
        Find k nearest neighbors to a query embedding.
        
        Args:
            query_embedding: The query embedding vector
            embeddings: Matrix of embedding vectors to search
            k: Number of neighbors to return
            include_distances: Whether to include distances in the result
            
        Returns:
            Dictionary with 'indices' and optionally 'distances' lists
        """
        if len(embeddings) == 0:
            return {"indices": [], "distances": []}
            
        # Calculate similarities (1 - similarity = distance for normalized vectors)
        similarities = self.calculate_similarities(query_embedding, embeddings)
        
        # Convert similarities to distances (1 - similarity)
        distances = 1 - similarities
        
        # Get indices of k smallest distances (nearest neighbors)
        if k >= len(distances):
            k = len(distances)
            
        nearest_indices = np.argsort(distances)[:k]
        
        result = {
            "indices": nearest_indices.tolist()
        }
        
        if include_distances:
            nearest_distances = distances[nearest_indices]
            result["distances"] = nearest_distances.tolist()
        
        return result