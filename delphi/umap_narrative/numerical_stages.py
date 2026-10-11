"""Pure numerical stages shared by legacy CLI and independently queued Delphi jobs.

Extracted without changing parameters, EVOC fallback, or corpus TF-IDF semantics.
No storage clients or provider imports.
"""
import logging
import traceback
import numpy as np
import evoc
from umap import UMAP
from sklearn.feature_extraction.text import CountVectorizer, TfidfTransformer
logger = logging.getLogger(__name__)


def project_and_cluster(document_vectors):
    # Generate 2D projection with UMAP
    logger.info("Generating 2D projection with UMAP...")
    document_map = UMAP(n_components=2, metric="cosine", random_state=42).fit_transform(
        document_vectors
    )

    # Cluster with EVōC
    logger.info("Clustering with EVōC...")
    try:
        clusterer = evoc.EVoC(min_samples=5)  # Set min_samples to avoid empty clusters
        cluster_labels = clusterer.fit_predict(document_vectors)
        cluster_layers = clusterer.cluster_layers_

        logger.info(
            f"Found {len(np.unique(cluster_labels))} clusters at the finest level"
        )
        for i, layer in enumerate(cluster_layers):
            unique_clusters = np.unique(layer[layer >= 0])
            logger.info(f"Layer {i}: {len(unique_clusters)} clusters")

    except Exception as e:
        logger.error(f"Error during EVōC clustering: {e}")
        logger.error(traceback.format_exc())
        # Fallback to simple clustering
        from sklearn.cluster import KMeans

        logger.info("Falling back to KMeans clustering...")
        kmeans = KMeans(n_clusters=5, random_state=42)
        cluster_labels = kmeans.fit_predict(document_vectors)

        # Create a simple layered clustering for demonstration
        from sklearn.cluster import AgglomerativeClustering

        layer1 = AgglomerativeClustering(n_clusters=3).fit_predict(document_vectors)
        layer2 = AgglomerativeClustering(n_clusters=2).fit_predict(document_vectors)

        cluster_layers = [cluster_labels, layer1, layer2]
        logger.info(
            f"Created {len(cluster_layers)} cluster layers with fallback clustering"
        )

    return document_map, cluster_layers


def characterize_comment_clusters(cluster_layer, comment_texts):
    """
    Characterize comment clusters by common themes and keywords.

    Args:
        cluster_layer: Cluster assignments for a specific layer
        comment_texts: List of comment text strings

    Returns:
        cluster_characteristics: Dictionary with cluster characterizations
    """
    # Create a dictionary to store cluster characteristics
    cluster_characteristics = {}

    # Get unique clusters
    unique_clusters = np.unique(cluster_layer)
    unique_clusters = unique_clusters[unique_clusters >= 0]  # Remove noise points (-1)

    # Create TF-IDF vectorizer
    vectorizer = CountVectorizer(max_features=1000, stop_words="english")
    transformer = TfidfTransformer()

    # Fit and transform the entire corpus
    X = vectorizer.fit_transform(comment_texts)
    X_tfidf = transformer.fit_transform(X)

    # Get feature names
    feature_names = vectorizer.get_feature_names_out()

    for cluster_id in unique_clusters:
        # Get cluster members
        cluster_members = np.where(cluster_layer == cluster_id)[0]

        if len(cluster_members) == 0:
            continue

        # Get comment texts for this cluster
        cluster_comments = [comment_texts[i] for i in cluster_members]

        # Find top words for this cluster by TF-IDF
        cluster_tfidf = X_tfidf[cluster_members].toarray().mean(axis=0)
        top_indices = np.argsort(cluster_tfidf)[-10:][::-1]  # Top 10 words
        top_words = [feature_names[i] for i in top_indices]

        # Get sample comments (shortest 3 for readability)
        comment_lengths = [len(comment) for comment in cluster_comments]
        shortest_indices = np.argsort(comment_lengths)[:3]  # 3 shortest comments
        sample_comments = [cluster_comments[i] for i in shortest_indices]

        # Add to cluster characteristics
        cluster_characteristics[int(cluster_id)] = {
            "size": len(cluster_members),
            "top_words": top_words,
            "top_tfidf_scores": [float(cluster_tfidf[i]) for i in top_indices],
            "sample_comments": sample_comments,
        }

    return cluster_characteristics

