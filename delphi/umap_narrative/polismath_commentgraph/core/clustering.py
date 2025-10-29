"""
Core clustering functionality for the Polis comment graph microservice.
"""

import logging
import time
from typing import Any

# Import EVOC directly
import evoc
import numpy as np
import umap
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer

logger = logging.getLogger(__name__)


class ClusteringEngine:
    """
    Implements hierarchical clustering for comment embeddings using EVOC.
    This class uses EVOC directly for clustering operations.
    """

    def __init__(
        self,
        umap_n_components: int = 2,
        umap_n_neighbors: int = 15,
        umap_min_dist: float = 0.1,
        umap_metric: str = "cosine",
        min_cluster_size: int = 5,
        min_samples: int = 5,
        cluster_selection_epsilon: float = 0.0,
        allow_single_cluster: bool = False,
        random_state: int = 42,
        n_jobs: int = -1,
    ):
        """
        Initialize the clustering engine with specific parameters.

        Args:
            umap_n_components: Number of dimensions for UMAP projection
            umap_n_neighbors: Number of neighbors for UMAP
            umap_min_dist: Minimum distance for UMAP
            umap_metric: Distance metric for UMAP
            min_cluster_size: Minimum cluster size for HDBSCAN
            min_samples: Minimum samples for HDBSCAN
            cluster_selection_epsilon: Epsilon for HDBSCAN cluster selection
            allow_single_cluster: Whether to allow a single cluster or force multiple
            random_state: Random state for reproducibility
            n_jobs: Number of parallel jobs (-1 for all processors)
        """
        self.umap_n_components = umap_n_components
        self.umap_n_neighbors = umap_n_neighbors
        self.umap_min_dist = umap_min_dist
        self.umap_metric = umap_metric
        self.min_cluster_size = min_cluster_size
        self.min_samples = min_samples
        self.cluster_selection_epsilon = cluster_selection_epsilon
        self.allow_single_cluster = allow_single_cluster
        self.random_state = random_state
        self.n_jobs = n_jobs

        logger.info(
            f"Initializing clustering engine with parameters: "
            f"UMAP(n_components={umap_n_components}, n_neighbors={umap_n_neighbors}, "
            f"min_dist={umap_min_dist}, metric={umap_metric}), "
            f"HDBSCAN(min_cluster_size={min_cluster_size}, min_samples={min_samples}, "
            f"cluster_selection_epsilon={cluster_selection_epsilon})"
        )

        # Initialize EVOC directly - using parameters from working examples
        self.evoc_clusterer = evoc.EVoC(min_samples=min_samples)
        logger.info("EVOC clusterer initialized")

    def project_to_2d(self, embeddings: np.ndarray) -> np.ndarray:
        """
        Project high-dimensional embeddings to 2D space using UMAP.

        Args:
            embeddings: High-dimensional embedding vectors

        Returns:
            2D projection of the embeddings
        """
        if len(embeddings) == 0:
            return np.array([])

        if len(embeddings) < self.umap_n_neighbors:
            # Adjust n_neighbors if there are too few samples
            n_neighbors = max(2, len(embeddings) - 1)
            logger.warning(
                f"Reducing UMAP n_neighbors from {self.umap_n_neighbors} to {n_neighbors} due to small sample size"
            )
        else:
            n_neighbors = self.umap_n_neighbors

        logger.info(f"Projecting {len(embeddings)} embeddings to 2D using UMAP")
        start_time = time.time()

        try:
            # Create and fit UMAP
            reducer = umap.UMAP(
                n_components=self.umap_n_components,
                n_neighbors=n_neighbors,
                min_dist=self.umap_min_dist,
                metric=self.umap_metric,
                random_state=self.random_state,
            )

            # Project the embeddings
            projection = reducer.fit_transform(embeddings)

            logger.info(f"UMAP projection complete: {projection.shape}, time: {time.time() - start_time:.2f}s")
            return projection
        except Exception as e:
            logger.error(f"Error in UMAP projection: {str(e)}")
            # Return a simple 2D projection based on PCA as fallback
            logger.warning("Falling back to PCA for dimensionality reduction")
            pca = PCA(n_components=2, random_state=self.random_state)
            projection = pca.fit_transform(embeddings)
            return projection

    def evoc_cluster(self, embeddings: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """
        Cluster embeddings using EVOC, with KMeans fallback exactly like in visualize_comments_with_layers.py

        Args:
            embeddings: Embedding vectors to cluster

        Returns:
            Tuple of (cluster_labels, probabilities)
        """
        if len(embeddings) == 0:
            return np.array([]), np.array([])

        try:
            # Try EVOC first - just like in visualize_comments_with_layers.py
            cluster_labels = self.evoc_clusterer.fit_predict(embeddings)

            # For compatibility with the rest of the code, return a dummy probabilities array
            # EVOC doesn't return probabilities directly
            probabilities = np.ones(len(cluster_labels))

            # Try to mark noise points if possible
            try:
                probabilities[cluster_labels == -1] = 0
            except Exception:
                pass

            logger.info("EVOC clustering successful")
        except Exception as e:
            # Fallback to KMeans exactly as in visualize_comments_with_layers.py
            logger.error(f"Error in EVOC clustering: {str(e)}")
            logger.info("Falling back to KMeans clustering as in visualize_comments_with_layers.py")

            kmeans = KMeans(n_clusters=5, random_state=self.random_state)
            cluster_labels = kmeans.fit_predict(embeddings)

            # Create probabilities (all 1s since KMeans doesn't have noise points)
            probabilities = np.ones(len(cluster_labels))

        return cluster_labels, probabilities

    def create_clustering_layers(self, embeddings: np.ndarray, num_layers: int = 4) -> list[np.ndarray]:
        """
        Create hierarchical clustering with multiple layers of granularity.
        Directly matches implementation in visualize_comments_with_layers.py, including the fallback.

        Args:
            embeddings: Embedding vectors to cluster
            num_layers: Number of hierarchical layers to create

        Returns:
            List of cluster label arrays, one per layer
        """
        if len(embeddings) == 0:
            return [np.array([]) for _ in range(num_layers)]

        logger.info(f"Creating {num_layers} hierarchical clustering layers")

        try:
            # Try EVOC first
            self.evoc_clusterer.fit_predict(embeddings)  # Fit the clusterer
            cluster_layers = self.evoc_clusterer.cluster_layers_

            logger.info(f"EVOC created {len(cluster_layers)} cluster layers")

            # Return the layers created by EVOC
            return cluster_layers
        except Exception as e:
            # Fallback to KMeans exactly as in visualize_comments_with_layers.py
            logger.error(f"Error in EVOC multi-layer clustering: {str(e)}")
            logger.info("Falling back to KMeans for layer creation")

            # Create a simple set of layers with increasing KMeans clusters
            fallback_layers = []

            # Create several layers with different numbers of clusters
            for i in range(num_layers):
                n_clusters = max(2, min(20, 5 * (i + 1)))  # Similar scaling as used in examples

                kmeans = KMeans(n_clusters=n_clusters, random_state=self.random_state)
                layer_labels = kmeans.fit_predict(embeddings)

                fallback_layers.append(layer_labels)
                logger.info(f"Created fallback layer {i} with {n_clusters} clusters")

            return fallback_layers

    def analyze_cluster(self, texts: list[str], cluster_labels: np.ndarray, cluster_id: int) -> dict[str, Any]:
        """
        Analyze a cluster to extract descriptive characteristics.

        Args:
            texts: List of text strings for all embeddings
            cluster_labels: Cluster assignments for all embeddings
            cluster_id: The specific cluster ID to analyze

        Returns:
            Dictionary of cluster characteristics
        """
        if cluster_id < 0:
            return {"error": "Cannot analyze noise cluster (ID < 0)"}

        # Get indices of comments in this cluster
        cluster_indices = np.where(cluster_labels == cluster_id)[0]

        if len(cluster_indices) == 0:
            return {"size": 0, "error": "Empty cluster"}

        # Get texts for this cluster
        cluster_texts = [texts[i] for i in cluster_indices if i < len(texts)]

        # Basic characteristics
        characteristics = {"size": len(cluster_indices), "sample_comments": cluster_texts[:3] if cluster_texts else []}

        # Add more advanced analysis if there are enough texts
        if len(cluster_texts) >= 3:
            try:
                # Extract keywords using TF-IDF
                # Create a TF-IDF vectorizer
                vectorizer = TfidfVectorizer(max_features=100, stop_words="english", min_df=1, max_df=0.8)

                # Fit TF-IDF on all texts
                tfidf_matrix = vectorizer.fit_transform(cluster_texts)

                # Get feature names
                feature_names = vectorizer.get_feature_names_out()

                # Calculate average TF-IDF scores for the cluster
                avg_tfidf = tfidf_matrix.mean(axis=0).A1

                # Get indices of top words
                top_indices = avg_tfidf.argsort()[-10:][::-1]

                # Get top words and scores
                top_words = [feature_names[i] for i in top_indices]
                top_scores = [avg_tfidf[i] for i in top_indices]

                characteristics["top_words"] = top_words
                characteristics["top_tfidf_scores"] = top_scores
            except Exception as e:
                logger.error(f"Error extracting keywords: {str(e)}")
                characteristics["error_keywords"] = str(e)

        return characteristics
