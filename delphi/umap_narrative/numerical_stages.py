"""Pure numerical stages shared by legacy CLI and independently queued Delphi jobs.

Extracted without changing parameters, EVOC fallback, or corpus TF-IDF semantics.
No storage clients or provider imports. UMAP, EVōC and scikit-learn are imported
where they are used, so reading DEFAULT_SEED or CLUSTER_MODEL stays cheap.
"""
import logging
import traceback
import numpy as np
logger = logging.getLogger(__name__)

# The seed of UMAP, EVōC and the KMeans fallback when the caller names none: the
# value UMAP has always used here. The full pipeline runs with it and its output
# manifest names it; a queued graph run passes the seed of its declared input.
DEFAULT_SEED = 42
# The clustering's model id: UMAP plus EVōC, as project_and_cluster runs them.
CLUSTER_MODEL = "delphi-umap-evoc/1"

_numba_seed = None


def _seed_evoc(seed):
    """Make EVōC (0.1.3, which takes no random_state) repeat for one seed.

    EVōC draws from NumPy's global generator (the nearest-neighbour forest, the
    label-propagation start, the node embedding's start and per-epoch draws) and
    from Numba's own generator (label-propagation tie breaks), and its
    node-embedding epochs update shared rows from parallel threads. So it runs
    with both generators seeded and on one Numba thread. On one thread EVōC would
    also build a smaller nearest-neighbour forest (it takes 4 to 8 trees from the
    thread count), so the forest keeps the size this machine's thread count
    gives. Returns the function that puts NumPy's global state, the thread count
    and the forest size back.
    """
    global _numba_seed
    import functools
    import numba
    from evoc import clustering

    if _numba_seed is None:
        @numba.njit
        def seed_numba(value):
            np.random.seed(value)

        _numba_seed = seed_numba
    threads = numba.get_num_threads()
    knn_graph = clustering.knn_graph
    state = np.random.get_state()
    np.random.seed(seed)
    _numba_seed(seed)
    clustering.knn_graph = functools.partial(knn_graph, n_trees=max(4, min(8, threads)))
    numba.set_num_threads(1)

    def restore():
        numba.set_num_threads(threads)
        clustering.knn_graph = knn_graph
        np.random.set_state(state)

    return restore


def project_and_cluster(document_vectors, seed=DEFAULT_SEED):
    """UMAP's 2-D map and EVōC's cluster layers, both from `seed`: the same
    vectors and seed give the same map and the same layers."""
    import evoc
    from umap import UMAP

    # Generate 2D projection with UMAP
    logger.info("Generating 2D projection with UMAP...")
    document_map = UMAP(n_components=2, metric="cosine", random_state=seed).fit_transform(
        document_vectors
    )

    # Cluster with EVōC. It is built and seeded before the try: an argument it
    # refuses, or a failure to seed it, raises instead of falling back to KMeans.
    logger.info(f"Clustering with EVōC (seed {seed})...")
    clusterer = evoc.EVoC(min_samples=5)  # Set min_samples to avoid empty clusters
    restore = _seed_evoc(seed)
    try:
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
        kmeans = KMeans(n_clusters=5, random_state=seed)
        cluster_labels = kmeans.fit_predict(document_vectors)

        # Create a simple layered clustering for demonstration
        from sklearn.cluster import AgglomerativeClustering

        layer1 = AgglomerativeClustering(n_clusters=3).fit_predict(document_vectors)
        layer2 = AgglomerativeClustering(n_clusters=2).fit_predict(document_vectors)

        cluster_layers = [cluster_labels, layer1, layer2]
        logger.info(
            f"Created {len(cluster_layers)} cluster layers with fallback clustering"
        )
    finally:
        restore()

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
    from sklearn.feature_extraction.text import CountVectorizer, TfidfTransformer

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

