#!/usr/bin/env python3
"""
Process Polis conversation from PostgreSQL and generate visualizations.

This script fetches conversation data from PostgreSQL, processes it using
EVōC for clustering, and generates interactive visualizations with topic labeling.
"""

import json
import logging
import os
import sys
import time
import traceback
import uuid  # For generating job_id
from datetime import datetime

import datamapplot

# Import from installed packages
import evoc
import numpy as np
from polismath_commentgraph.utils.converter import DataConverter

# Import from local modules
from polismath_commentgraph.utils.storage import DynamoDBStorage, PostgresClient
from polismath.utils.cli_flags import parse_bool_flag
from sentence_transformers import SentenceTransformer
from umap_narrative.topic_naming import (
    generate_cluster_topic_labels,
    origin_facts,
    resolve_model_name,
    resolve_provider_type,
)
from sklearn.feature_extraction.text import CountVectorizer, TfidfTransformer
from umap import UMAP
from umap_narrative.numerical_stages import characterize_comment_clusters
from polismath import step_log

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def setup_environment(
    db_host=None, db_port=None, db_name=None, db_user=None, db_password=None
):
    """Set up environment variables for database connections."""
    # PostgreSQL settings
    if db_host:
        os.environ["DATABASE_HOST"] = db_host
    elif not os.environ.get("DATABASE_HOST"):
        os.environ["DATABASE_HOST"] = "localhost"

    if db_port:
        os.environ["DATABASE_PORT"] = str(db_port)
    elif not os.environ.get("DATABASE_PORT"):
        os.environ["DATABASE_PORT"] = "5432"

    if db_name:
        os.environ["DATABASE_NAME"] = db_name
    elif not os.environ.get("DATABASE_NAME"):
        os.environ["DATABASE_NAME"] = "polisDB_prod_local_mar14"

    if db_user:
        os.environ["DATABASE_USER"] = db_user
    elif not os.environ.get("DATABASE_USER"):
        os.environ["DATABASE_USER"] = "postgres"

    if db_password:
        os.environ["DATABASE_PASSWORD"] = db_password
    elif not os.environ.get("DATABASE_PASSWORD"):
        os.environ["DATABASE_PASSWORD"] = ""

    # Print database connection info
    logger.info("Database connection info:")
    logger.info(f"- HOST: {os.environ.get('DATABASE_HOST')}")
    logger.info(f"- PORT: {os.environ.get('DATABASE_PORT')}")
    logger.info(f"- DATABASE: {os.environ.get('DATABASE_NAME')}")
    logger.info(f"- USER: {os.environ.get('DATABASE_USER')}")

    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def fetch_conversation_data(zid):
    """
    Fetch conversation data from PostgreSQL.

    Args:
        zid: Conversation ID

    Returns:
        comments: List of comment dictionaries
        metadata: Dictionary with conversation metadata
    """
    from polismath.job_child import input_bundle

    # The input bundle polis-jobs wrote, when the frame names one: the same rows,
    # read in one snapshot before the child started. Otherwise PostgreSQL.
    bundle = input_bundle.load(zid)
    postgres_client = None

    try:
        if bundle is not None:
            logger.info(f"Reading conversation {zid} from the input bundle...")
            conversation = bundle.conversation()
            comments = bundle.comments()
        else:
            logger.info(f"Fetching conversation {zid} from PostgreSQL...")
            postgres_client = PostgresClient()
            # Initialize connection
            postgres_client.initialize()

            # Get conversation metadata
            conversation = postgres_client.get_conversation_by_id(zid)
            if not conversation:
                logger.error(f"Conversation {zid} not found in database.")
                return None, None

            # Get comments - include all comments, regardless of active status
            comments = postgres_client.get_comments_by_conversation(zid)
        logger.info(f"Retrieved {len(comments)} comments from conversation {zid}")

        # Count active and inactive for logging purposes only
        active_count = sum(1 for c in comments if c.get("active", True))
        inactive_count = sum(1 for c in comments if not c.get("active", True))
        logger.info(
            f"Comment counts - Active: {active_count}, Inactive: {inactive_count}, Total: {len(comments)}"
        )

        # Create metadata
        metadata = {
            "conversation_id": str(zid),
            "zid": zid,
            "conversation_name": conversation.get("topic", f"Conversation {zid}"),
            "description": conversation.get("description", ""),
            "created": str(conversation.get("created", "")),
            "modified": str(conversation.get("modified", "")),
            "owner": conversation.get("owner", ""),
            "num_comments": len(comments),
            "active_count": active_count,
            "inactive_count": inactive_count,
        }

        return comments, metadata

    except Exception as e:
        logger.error(f"Error fetching conversation: {str(e)}")
        import traceback

        logger.error(traceback.format_exc())
        return None, None

    finally:
        # Clean up connection
        if postgres_client is not None:
            postgres_client.shutdown()


def fetch_selection_columns(zid):
    """What a named selection reads besides the comment rows: the conversation's
    strict_moderation, and every comment's velocity by tid. From the input bundle
    when the frame names one (written for the selection: its comment rows carry
    their velocity, so the second value is None), else from PostgreSQL."""
    from polismath.job_child import input_bundle

    bundle = input_bundle.load(zid)
    if bundle is not None:
        return bundle.strict_moderation(), None
    postgres_client = PostgresClient()
    postgres_client.initialize()
    try:
        conversation = postgres_client.get_conversation_by_id(zid) or {}
        rows = postgres_client.query("SELECT tid, velocity FROM comments WHERE zid = :zid", {"zid": zid})
    finally:
        postgres_client.shutdown()
    return bool(conversation.get("strict_moderation")), {int(r["tid"]): float(r["velocity"]) for r in rows}


def _texts_and_ids(comments):
    """The comments that have text, as two lists: their texts and their ids."""
    return map(
        list,
        zip(
            *[(c["txt"], c["tid"]) for c in comments if c["txt"] and c["txt"].strip()],
            strict=True,
        ),
    )


def _embed(comment_texts):
    """The comments' vectors, from the run's embedding model."""
    # Generate embeddings with SentenceTransformer. DELPHI_EMBED_MODEL_PATH set
    # (the Delphi services): the model's files carried in the image, checked
    # against DELPHI_EMBED_MODEL_LOCK and read with no network. Unset: the
    # default model fetched by name once at the shipped lock's revision and
    # checked against that lock the same way; another name, from the hub as
    # given. Either way the vectors are the first 384 dimensions, normalized
    # (polismath/embedding_model.py).
    from polismath import embedding_model as em

    logger.info("Generating embeddings with SentenceTransformer...")
    with step_log.step("embed_load") as facts:
        embedding_model, resolved = em.load()
        facts["model_source"] = "image" if resolved.local else "hub"
        facts["model"] = resolved.model
        logger.info(f"Using model: {resolved.model}"
                    + (f" from {resolved.arg} (no download)" if resolved.local else ""))
    with step_log.step("embed_encode", n_comments=len(comment_texts)) as facts:
        document_vectors = em.encode(embedding_model, comment_texts, show_progress_bar=True)
        facts["dims"] = int(document_vectors.shape[1]) if getattr(document_vectors, "ndim", 0) == 2 else None
    return document_vectors


def process_selected_comments(comments, conversation_id, selected):
    """
    Embed every comment that has text; lay out and cluster only the selected ones.

    Args:
        comments: Every comment of the conversation (the run embeds them all)
        conversation_id: Conversation ID string
        selected: The ids of the comments the run's selection keeps

    Returns:
        embedded: (texts, ids, vectors) of every comment embedded, for the
            embeddings store
        then process_comments' five values, of the selected comments only
    """
    logger.info(
        f"Processing {len(comments)} comments for conversation {conversation_id}, "
        f"laying out the {len(selected)} its selection keeps..."
    )
    all_texts, all_ids = _texts_and_ids(comments)
    all_vectors = _embed(all_texts)
    keep = [i for i, tid in enumerate(all_ids) if int(tid) in selected]
    comment_texts = [all_texts[i] for i in keep]
    comment_ids = [all_ids[i] for i in keep]
    document_vectors = all_vectors[keep]

    from umap_narrative.numerical_stages import project_and_cluster
    document_map, cluster_layers = project_and_cluster(document_vectors)

    embedded = (all_texts, all_ids, all_vectors)
    return embedded, document_map, document_vectors, cluster_layers, comment_texts, comment_ids


def process_comments(comments, conversation_id):
    """
    Process comments with embedding and clustering.

    Args:
        comments: List of comment dictionaries
        conversation_id: Conversation ID string

    Returns:
        document_map: 2D projection of comment embeddings
        document_vectors: Comment embeddings
        cluster_layers: Hierarchy of cluster assignments
        comment_texts: List of comment text strings
        comment_ids: List of comment IDs
    """
    logger.info(
        f"Processing {len(comments)} comments for conversation {conversation_id}..."
    )

    # Extract comment texts and IDs
    comment_texts, comment_ids = _texts_and_ids(comments)

    document_vectors = _embed(comment_texts)

    from umap_narrative.numerical_stages import project_and_cluster
    document_map, cluster_layers = project_and_cluster(document_vectors)

    return document_map, document_vectors, cluster_layers, comment_texts, comment_ids



def create_comment_hover_info(cluster_layer, cluster_characteristics, comment_texts):
    """
    Create hover text information for comments based on cluster characteristics.

    Args:
        cluster_layer: Cluster assignments for a specific layer
        cluster_characteristics: Dictionary with cluster characterizations
        comment_texts: List of comment text strings

    Returns:
        hover_info: List of hover text strings for each comment
    """
    hover_info = []
    for i, (text, cluster_id) in enumerate(zip(comment_texts, cluster_layer)):
        if cluster_id >= 0 and cluster_id in cluster_characteristics:
            characteristics = cluster_characteristics[cluster_id]

            # Create hover text with the comment and cluster info
            hover_text = f"{text}\n\n"
            hover_text += f"Cluster {cluster_id} - Size: {characteristics['size']}\n"

            # Add top keywords
            if "top_words" in characteristics:
                hover_text += "Keywords: " + ", ".join(characteristics["top_words"][:5])
        else:
            hover_text = f"{text}\n\nUnclustered"

        hover_info.append(hover_text)

    return hover_info


def create_basic_layer_visualization(
    output_path,
    file_prefix,
    data_map,
    cluster_layer,
    cluster_characteristics,
    cluster_labels,
    hover_info,
    title,
    sub_title,
):
    """
    Create a basic visualization with numeric topic labels for a specific layer.

    Args:
        output_path: Path to save the visualization
        file_prefix: Prefix for the output file
        data_map: 2D coordinates of data points
        cluster_layer: Cluster assignments for a specific layer
        cluster_characteristics: Dictionary with cluster characterizations
        cluster_labels: Dictionary mapping cluster IDs to topic labels
        hover_info: Hover text for each data point
        title: Title for the visualization
        sub_title: Subtitle for the visualization

    Returns:
        file_path: Path to the saved visualization
    """
    # Create labels vector
    labels_for_viz = np.array(
        [
            cluster_labels.get(label, "Unlabelled") if label >= 0 else "Unlabelled"
            for label in cluster_layer
        ]
    )

    # Create interactive visualization
    logger.info(f"Creating basic visualization for {file_prefix}...")
    viz_file = os.path.join(output_path, f"{file_prefix}.html")

    try:
        interactive_figure = datamapplot.create_interactive_plot(
            data_map,
            labels_for_viz,
            hover_text=hover_info,
            title=title,
            sub_title=sub_title,
            point_radius_min_pixels=2,
            point_radius_max_pixels=10,
            width="100%",
            height=800,
        )

        # Save the visualization
        interactive_figure.save(viz_file)
        logger.info(f"Saved basic visualization to {viz_file}")
        return viz_file
    except Exception as e:
        logger.error(f"Error creating basic visualization: {e}")
        return None


def create_named_layer_visualization(
    output_path,
    file_prefix,
    data_map,
    cluster_layer,
    cluster_labels,
    hover_info,
    title,
    sub_title,
):
    """
    Create a named visualization with explicit topic labels for a specific layer.

    Args:
        output_path: Path to save the visualization
        file_prefix: Prefix for the output file
        data_map: 2D coordinates of data points
        cluster_layer: Cluster assignments for a specific layer
        cluster_labels: Dictionary mapping cluster IDs to topic labels
        hover_info: Hover text for each data point
        title: Title for the visualization
        sub_title: Subtitle for the visualization

    Returns:
        file_path: Path to the saved visualization
    """
    # Create labels vector
    labels_for_viz = np.array(
        [
            cluster_labels.get(label, "Unlabelled") if label >= 0 else "Unlabelled"
            for label in cluster_layer
        ]
    )

    # Create interactive visualization
    logger.info(f"Creating named visualization for {file_prefix}...")
    viz_file = os.path.join(output_path, f"{file_prefix}.html")

    try:
        interactive_figure = datamapplot.create_interactive_plot(
            data_map,
            labels_for_viz,
            hover_text=hover_info,
            title=title,
            sub_title=sub_title,
            point_radius_min_pixels=2,
            point_radius_max_pixels=10,
            width="100%",
            height=800,
        )

        # Save the visualization
        interactive_figure.save(viz_file)
        logger.info(f"Saved named visualization to {viz_file}")
        return viz_file
    except Exception as e:
        logger.error(f"Error creating named visualization: {e}")
        return None


def process_layers_and_store_characteristics(
    conversation_id,
    cluster_layers,
    comment_texts,
    output_dir=None,
    dynamo_storage=None,
    job_id=None,  # Added job_id
):
    """
    Process layers and store cluster characteristics and enhanced topic names in DynamoDB.

    Args:
        conversation_id: Conversation ID string
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Optional directory to save visualization data as JSON
        dynamo_storage: Optional DynamoDBStorage object for storing in DynamoDB
        job_id: Job ID for this run

    Returns:
        Dictionary with layer data including characteristics and enhanced topic names
    """
    layer_data = {}

    for layer_idx, cluster_layer in enumerate(cluster_layers):
        logger.info(
            f"Processing layer {layer_idx} with {len(np.unique(cluster_layer[cluster_layer >= 0]))} clusters..."
        )

        # Generate cluster characteristics
        cluster_characteristics = characterize_comment_clusters(
            cluster_layer, comment_texts
        )

        # Create basic numeric topic names
        numeric_labels = {
            str(i): f"Topic {i}" for i in np.unique(cluster_layer[cluster_layer >= 0])
        }

        # Store layer data
        layer_data[layer_idx] = {
            "characteristics": cluster_characteristics,
            "numeric_topic_names": numeric_labels,
        }

        # Save data to files if output directory provided
        if output_dir:
            # Save cluster characteristics
            with open(
                os.path.join(
                    output_dir,
                    f"{conversation_id}_comment_layer_{layer_idx}_characteristics.json",
                ),
                "w",
            ) as f:
                json_compatible = json.dumps(
                    cluster_characteristics,
                    default=lambda x: float(x) if isinstance(x, np.float32) else x,
                )
                f.write(json_compatible)

            # Save numeric topic names
            with open(
                os.path.join(
                    output_dir, f"{conversation_id}_layer_{layer_idx}_topic_names.json"
                ),
                "w",
            ) as f:
                json.dump(numeric_labels, f, indent=2)

        # Store in DynamoDB if provided
        if dynamo_storage:
            # Convert and store cluster characteristics
            logger.info(
                f"Storing cluster characteristics for layer {layer_idx} in DynamoDB..."
            )
            characteristic_models = DataConverter.batch_convert_cluster_characteristics(
                conversation_id, cluster_characteristics, layer_idx
            )  # job_id is not directly part of characteristics PK, but good to have if we extend

            result = dynamo_storage.batch_create_cluster_characteristics(
                characteristic_models
            )
            logger.info(
                f"Stored {result['success']} cluster characteristics with {result['failure']} failures"
            )

    logger.info("Processing of layers and storing characteristics complete!")
    return layer_data


def create_static_datamapplot(
    conversation_id,
    document_map,
    cluster_layer,
    cluster_labels,
    output_dir,
    layer_num=0,
):
    """
    Generate static datamapplot visualizations for a layer.

    Args:
        conversation_id: Conversation ID string
        document_map: 2D coordinates for visualization
        cluster_layer: Cluster assignments for this layer
        cluster_labels: Dictionary mapping cluster IDs to topic names
        output_dir: Directory to save visualizations
        layer_num: Layer number (default 0)

    Returns:
        Boolean indicating success
    """
    logger.info(
        f"Generating static datamapplot for conversation {conversation_id}, layer {layer_num}"
    )

    try:
        # Create visualization directory if it doesn't exist
        # Default location in the project structure
        vis_dir = os.path.join("visualizations", str(conversation_id))
        os.makedirs(vis_dir, exist_ok=True)

        # Also ensure the output directory exists in the pipeline's structure
        # This is typically polis_data/zid/python_output/comments_enhanced_multilayer
        os.makedirs(output_dir, exist_ok=True)

        # Prepare label strings with topic names
        def clean_topic_name(name):
            # Remove asterisks from topic names (e.g., "**Topic Name**" becomes "Topic Name")
            if isinstance(name, str):
                return name.replace("*", "")
            return name

        # Create labels vector
        label_strings = np.array(
            [
                (
                    clean_topic_name(cluster_labels.get(label, f"Topic {label}"))
                    if label >= 0
                    else "Unclustered"
                )
                for label in cluster_layer
            ]
        )

        # Generate the static plot - it returns (fig, ax) tuple
        fig, ax = datamapplot.create_plot(
            document_map,
            label_strings,
            title=f"Conversation {conversation_id} - Layer {layer_num}",
            label_over_points=True,  # Place labels directly over the point clusters
            dynamic_label_size=True,  # Vary label size based on cluster size
            dynamic_label_size_scaling_factor=0.75,
            max_font_size=28,  # Maximum font size for labels
            min_font_size=12,  # Minimum font size for labels
            label_wrap_width=15,  # Wrap long cluster names
            point_size=3,  # Size of the data points
            noise_label="Unclustered",  # Label for uncategorized points
            noise_color="#aaaaaa",  # Grey color for uncategorized points
            color_label_text=True,  # Color the label text to match points
            cvd_safer=True,  # Use CVD-safer colors
        )

        # Save to both locations: default visualizations directory and pipeline output

        # 1. Save to visualizations directory
        # Regular PNG
        static_png = os.path.join(
            vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.png"
        )
        fig.savefig(static_png, dpi=300, bbox_inches="tight")
        logger.info(f"Saved static PNG to {static_png}")

        # High resolution PNG for presentations
        presentation_png = os.path.join(
            vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_presentation.png"
        )
        fig.savefig(presentation_png, dpi=600, bbox_inches="tight")
        logger.info(f"Saved high-resolution PNG to {presentation_png}")

        # SVG for vector graphics
        svg_file = os.path.join(
            vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.svg"
        )
        fig.savefig(svg_file, format="svg", bbox_inches="tight")
        logger.info(f"Saved vector SVG to {svg_file}")

        # 2. Save the same files to the pipeline output directory
        if output_dir != vis_dir:
            # Regular PNG
            output_static_png = os.path.join(
                output_dir,
                f"{conversation_id}_layer_{layer_num}_datamapplot_static.png",
            )
            fig.savefig(output_static_png, dpi=300, bbox_inches="tight")
            logger.info(f"Saved static PNG to pipeline output: {output_static_png}")

            # High resolution PNG for presentations
            output_presentation_png = os.path.join(
                output_dir,
                f"{conversation_id}_layer_{layer_num}_datamapplot_presentation.png",
            )
            fig.savefig(output_presentation_png, dpi=600, bbox_inches="tight")
            logger.info(
                f"Saved high-resolution PNG to pipeline output: {output_presentation_png}"
            )

            # SVG for vector graphics
            output_svg_file = os.path.join(
                output_dir,
                f"{conversation_id}_layer_{layer_num}_datamapplot_static.svg",
            )
            fig.savefig(output_svg_file, format="svg", bbox_inches="tight")
            logger.info(f"Saved vector SVG to pipeline output: {output_svg_file}")

        return True

    except Exception as e:
        logger.error(f"Error generating static datamapplot: {str(e)}")
        logger.error(traceback.format_exc())
        return False


def create_visualizations(
    conversation_id,
    conversation_name,
    document_map,
    cluster_layers,
    comment_texts,
    output_dir,
    layer_data=None,
):
    """
    Create visualizations based on processed layer data.

    Args:
        conversation_id: Conversation ID string
        conversation_name: Name of the conversation
        document_map: 2D coordinates for visualization
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Directory to save visualizations
        layer_data: Optional dictionary with layer data including characteristics and enhanced topic names

    Returns:
        The path to the index file
    """
    # If layer_data not provided, generate it
    if layer_data is None:
        logger.info("Layer data not provided, generating it...")
        layer_data = {}
        for layer_idx, cluster_layer in enumerate(cluster_layers):
            # Generate cluster characteristics
            characteristics = characterize_comment_clusters(
                cluster_layer, comment_texts
            )

            # Create basic numeric topic names
            numeric_labels = {
                i: f"Topic {i}" for i in np.unique(cluster_layer[cluster_layer >= 0])
            }

            layer_data[layer_idx] = {
                "characteristics": characteristics,
                "numeric_topic_names": numeric_labels,
            }

    # Create visualizations
    layer_files = []
    layer_info = []

    for layer_idx, cluster_layer in enumerate(cluster_layers):
        if layer_idx not in layer_data:
            logger.warning(
                f"No layer data for layer {layer_idx}, skipping visualization..."
            )
            continue

        # Get characteristics and numeric topic names
        characteristics = layer_data[layer_idx]["characteristics"]
        numeric_topic_names = layer_data[layer_idx]["numeric_topic_names"]

        # Create hover information
        hover_info = create_comment_hover_info(
            cluster_layer, characteristics, comment_texts
        )

        # Create basic visualization
        create_basic_layer_visualization(
            output_dir,
            f"{conversation_id}_comment_layer_{layer_idx}_basic",
            document_map,
            cluster_layer,
            characteristics,
            numeric_topic_names,
            hover_info,
            f"{conversation_name} Comment Layer {layer_idx} - {len(np.unique(cluster_layer[cluster_layer >= 0]))} topics",
            "Comment topics with numeric labels",
        )

        # Create named visualization with just numeric topic names for now
        # (LLM names will be added in a separate step later)
        named_file = create_named_layer_visualization(
            output_dir,
            f"{conversation_id}_comment_layer_{layer_idx}_named",
            document_map,
            cluster_layer,
            numeric_topic_names,
            hover_info,
            f"{conversation_name} Comment Layer {layer_idx} - {len(np.unique(cluster_layer[cluster_layer >= 0]))} topics",
            "Comment topics (to be updated with LLM topic names)",
        )

        # Generate static datamapplot visualizations
        # TEMPORARILY DISABLED - These static files aren't used by the web interface
        # create_static_datamapplot(
        #     conversation_id,
        #     document_map,
        #     cluster_layer,
        #     numeric_topic_names,
        #     output_dir,
        #     layer_idx
        # )

        # Generate consensus/divisive visualization
        # TEMPORARILY DISABLED - These files aren't used by the web interface and slow down processing
        # try:
        #     logger.info(f"Generating consensus/divisive visualization for layer {layer_idx}...")
        #     # Use subprocess to run as a separate process to avoid any memory leaks
        #     import subprocess
        #     script_path = os.path.join(os.path.dirname(__file__), "702_consensus_divisive_datamapplot.py")
        #     command = [
        #         "python", script_path,
        #         "--zid", str(conversation_id),
        #         "--layer", str(layer_idx),
        #         "--output_dir", output_dir
        #     ]
        #
        #     # Run the script with appropriate environment variables
        #     env = os.environ.copy()
        #     process = subprocess.Popen(
        #         command,
        #         env=env,
        #         stdout=subprocess.PIPE,
        #         stderr=subprocess.PIPE,
        #         universal_newlines=True
        #     )
        #     stdout, stderr = process.communicate()
        #
        #     if process.returncode != 0:
        #         logger.warning(f"Consensus/divisive visualization failed: {stderr}")
        #     else:
        #         logger.info(f"Consensus/divisive visualization for layer {layer_idx} completed successfully")
        #
        # except Exception as e:
        #     logger.warning(f"Error running consensus/divisive visualization: {e}")

        # Add to list of layer files and info
        if named_file:
            layer_files.append(named_file)
            layer_info.append(
                (layer_idx, len(np.unique(cluster_layer[cluster_layer >= 0])))
            )

    # Create index file
    index_file = create_enhanced_multilayer_index(
        output_dir, conversation_id, layer_files, layer_info
    )

    logger.info("Visualization creation complete!")
    logger.info(f"Index file available at: {index_file}")

    # Try to open in browser
    # try:
    #     import webbrowser
    #     webbrowser.open(f"file://{index_file}")
    # except:
    #     pass

    return index_file


def _timed_layers(name, cluster_layers):
    """Yield (index, layer) pairs, one step line per layer when the step log is on."""
    for layer_idx, cluster_layer in enumerate(cluster_layers):
        with step_log.step(name, layer=layer_idx,
                           clusters=int(len(np.unique(cluster_layer[cluster_layer >= 0])))):
            yield layer_idx, cluster_layer


def process_layers_and_create_visualizations(
    conversation_id,
    conversation_name,
    document_map,
    cluster_layers,
    comment_texts,
    output_dir,
    name_topics=False,
    dynamo_storage=None,
    job_id=None,  # Added job_id
):
    """
    Process layers, store data, and create visualizations.

    Args:
        conversation_id: Conversation ID string
        conversation_name: Name of the conversation
        document_map: 2D coordinates for visualization
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Directory to save visualizations
        name_topics: Whether to generate LLM topic labels (provider chosen by
            LLM_PROVIDER; default anthropic via the Batch API)
        dynamo_storage: Optional DynamoDBStorage object for storing in DynamoDB
        job_id: Job ID for this run
    """
    # Process layers and store characteristics
    with step_log.step("keywords", layers=len(cluster_layers)):
        layer_data = process_layers_and_store_characteristics(
            conversation_id,
            cluster_layers,
            comment_texts,
            output_dir=output_dir,
            dynamo_storage=dynamo_storage,
            job_id=job_id,  # Pass job_id
        )

    # Create visualizations with basic numeric labels. With
    # DELPHI_SKIP_DATAMAPPLOT=1 (run_delphi.py) no page is written: the pages
    # hold comment text and no reader uses them.
    if os.environ.get("DELPHI_SKIP_DATAMAPPLOT", "").strip() == "1":
        logger.info("DELPHI_SKIP_DATAMAPPLOT=1: the layer pages are not written")
        index_file = None
        step_log.emit("layer_pages", status="skipped")
    else:
        with step_log.step("layer_pages", layers=len(cluster_layers)):
            index_file = create_visualizations(
                conversation_id,
                conversation_name,
                document_map,
                cluster_layers,
                comment_texts,
                output_dir,
                layer_data=layer_data,
            )

    # If topic naming is requested, generate LLM topic labels.
    if name_topics:
        provider_type = resolve_provider_type()
        topic_model = resolve_model_name(provider_type)
        logger.info(
            f"Generating LLM topic names with provider={provider_type} "
            f"model={topic_model}"
        )

        for layer_idx, cluster_layer in _timed_layers("topic_names", cluster_layers):
            characteristics = layer_data[layer_idx]["characteristics"]

            # Generate topic labels via the configured provider (Anthropic batch
            # by default; Ollama one-by-one when LLM_PROVIDER=ollama).
            logger.info(
                f"Generating LLM topic names for layer {layer_idx}..."
            )
            name_origins = {}
            cluster_labels = generate_cluster_topic_labels(
                characteristics,
                comment_texts=comment_texts,
                layer=cluster_layer,
                layer_idx=layer_idx,
                conversation_name=conversation_name,
                name_topics=True,
                document_map=document_map,
                origins=name_origins,
            )

            # How this layer was named, for the run's record (kept only while
            # the topic map step records the run's steps). Each name's origin
            # is what the naming decided when it made the name; a label's
            # shape is never read as proof of who wrote it. The topic map keeps
            # the names of the clusters listed in model_clusters as written.
            # Only while recording: with the topic map step off, nothing here runs.
            if step_log.recording():
                step_log.note(
                    "topic_names", layer=layer_idx, provider=provider_type, model=topic_model,
                    clusters=len(cluster_labels), **origin_facts(cluster_labels, name_origins),
                )

            # Save LLM topic names
            with open(
                os.path.join(
                    output_dir,
                    f"{conversation_id}_comment_layer_{layer_idx}_labels.json",
                ),
                "w",
            ) as f:
                json.dump(cluster_labels, f, indent=2)

            # Store in DynamoDB if provided
            if dynamo_storage:
                logger.info(
                    f"Storing LLM topic names for layer {layer_idx} in DynamoDB..."
                )
                # Record the model that actually produced these labels.
                model_name = topic_model
                llm_topic_models = DataConverter.batch_convert_llm_topic_names(
                    conversation_id,
                    cluster_labels,
                    layer_idx,
                    model_name=model_name,  # Model used for topic naming
                    job_id=job_id,  # Pass job_id
                )
                result = dynamo_storage.batch_create_llm_topic_names(llm_topic_models)
                logger.info(
                    f"Stored {result['success']} LLM topic names with {result['failure']} failures"
                )

            # Create a new static datamapplot with the LLM labels
            # logger.info(f"Generating static datamapplot with LLM labels for layer {layer_idx}...")
            # create_static_datamapplot(
            #     conversation_id,
            #     document_map,
            #     cluster_layer,
            #     cluster_labels,
            #     output_dir,
            #     layer_idx
            # )
            logger.info(
                f"Skipped static datamapplot with LLM labels for layer {layer_idx}..."
            )

    return index_file


def create_enhanced_multilayer_index(
    output_path, conversation_name, layer_files, layer_info
):
    """
    Create an index HTML file linking to all enhanced layer visualizations.

    Args:
        output_path: Path to save the index file
        conversation_name: Name of the conversation
        layer_files: List of paths to layer visualization files
        layer_info: List of tuples (layer_idx, num_clusters) for each layer

    Returns:
        file_path: Path to the saved index file
    """
    index_file = os.path.join(
        output_path, f"{conversation_name}_comment_enhanced_index.html"
    )

    with open(index_file, "w") as f:
        f.write(
            f"""<!DOCTYPE html>
<html>
<head>
    <title>{conversation_name} - Enhanced Multi-layer Comment Visualization</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 20px; }}
        h1 {{ color: #333; }}
        .layer-container {{ margin-bottom: 30px; }}
        .description {{ margin-bottom: 10px; }}
        iframe {{ border: 1px solid #ddd; width: 100%; height: 600px; }}
        .button-container {{ margin-bottom: 10px; }}
        .button {{
            background-color: #4CAF50;
            border: none;
            color: white;
            padding: 10px 20px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            margin: 4px 2px;
            cursor: pointer;
            border-radius: 4px;
        }}
        .view-options {{
            margin: 10px 0;
            display: flex;
            gap: 10px;
        }}
        .view-link {{
            padding: 5px 10px;
            background-color: #f0f0f0;
            color: #333;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
        }}
        .view-link:hover {{
            background-color: #e0e0e0;
        }}
        .active {{
            background-color: #007BFF;
            color: white;
        }}
        .static-downloads {{
            margin: 10px 0;
            padding: 10px;
            background-color: #f8f9fa;
            border-radius: 4px;
            border: 1px solid #e9ecef;
        }}
        .static-downloads h3 {{
            margin-top: 0;
            font-size: 16px;
        }}
        .static-downloads a {{
            display: inline-block;
            margin-right: 15px;
            color: #0066cc;
            text-decoration: none;
        }}
        .static-downloads a:hover {{
            text-decoration: underline;
        }}
    </style>
</head>
<body>
    <h1>{conversation_name} - Enhanced Multi-layer Comment Visualization</h1>
    <p>This page provides access to different layers of clustering granularity with topic labeling:</p>

    <div class="button-container">
        <button class="button" onclick="window.location.reload();">Refresh Page</button>
    </div>
"""
        )

        # Add links to each layer
        for (layer_idx, num_clusters), file_path in zip(layer_info, layer_files):
            file_name = os.path.basename(file_path)
            basic_view_file = file_name.replace("_named.html", "_enhanced.html")
            named_view_file = file_name

            # Static file references
            static_png = f"{conversation_name}_layer_{layer_idx}_datamapplot_static.png"
            presentation_png = (
                f"{conversation_name}_layer_{layer_idx}_datamapplot_presentation.png"
            )
            static_svg = f"{conversation_name}_layer_{layer_idx}_datamapplot_static.svg"

            # Consensus/divisive visualization references
            consensus_png = f"{conversation_name}_consensus_divisive_colored_map.png"
            consensus_enhanced = f"{conversation_name}_consensus_divisive_enhanced.png"

            description = (
                "Fine-grained grouping"
                if layer_idx == 0
                else (
                    "Coarser grouping"
                    if layer_idx == len(layer_info) - 1
                    else "Medium granularity"
                )
            )

            f.write(
                f"""
    <div class="layer-container">
        <h2>Layer {layer_idx}</h2>
        <p class="description">{description} with topic labels</p>
        <div class="view-options">
            <a href="{basic_view_file}" class="view-link " target="_blank">Basic View</a>
            <a href="{named_view_file}" class="view-link active" target="_blank">Named View (LLM-labeled)</a>
        </div>

        <div class="static-downloads">
            <h3>Static Visualizations:</h3>
            <a href="{static_png}" target="_blank">Standard PNG</a>
            <a href="{presentation_png}" target="_blank">Presentation PNG (HiRes)</a>
            <a href="{static_svg}" target="_blank">Vector SVG</a>
        </div>

        <div class="static-downloads">
            <h3>Consensus/Divisive Visualizations:</h3>
            <a href="{consensus_png}" target="_blank">Consensus Map</a>
            <a href="{consensus_enhanced}" target="_blank">Enhanced Consensus Map</a>
            <p><strong>Color legend:</strong> Green = Consensus Comments, Yellow = Mixed Opinions, Red = Divisive Comments</p>
        </div>

        <iframe src="{named_view_file}"></iframe>
    </div>
"""
            )

        f.write(
            """
</body>
</html>
"""
        )

    logger.info(f"Created enhanced multi-layer index at {index_file}")
    return index_file


def process_conversation(
    zid, export_dynamo=True, name_topics=False, include_moderation=False, exclude_comment_selections=True,
    selection=None,
):
    """
    Main function to process a conversation and generate visualizations.

    Args:
        zid: Conversation ID
        export_dynamo: Whether to export results to DynamoDB
        name_topics: Whether to generate LLM topic labels (provider via LLM_PROVIDER)
        include_moderation: Whether to filter out moderated comments (mod == -1)
        exclude_comment_selections: Whether to exclude comments that have selection == -1
            in report_comment_selections table (for any report in this conversation)
        selection: A selection's name (polismath/selection.py): every comment is
            embedded, and only the comments it keeps are laid out, clustered,
            named and stored. It is the whole rule, so the two filters above
            must be off. None (the default, and every run but the shadow's):
            the run is what it was.
    """
    # Create conversation directory
    output_dir = os.path.join(
        "polis_data", str(zid), "python_output", "comments_enhanced_multilayer"
    )
    os.makedirs(output_dir, exist_ok=True)

    # With the topic map step on, the run keeps a record of its steps in
    # memory, stored with its map (polismath/delphi_storage/topic_map.py).
    from polismath.delphi_storage import topic_map
    if topic_map.enabled():
        step_log.record()

    with step_log.step("total") as total:
        ok = _process_conversation(zid, output_dir, export_dynamo, name_topics,
                                   include_moderation, exclude_comment_selections, total,
                                   selection=selection)
        total["ok"] = bool(ok)
    return ok


def _read_inputs(zid, include_moderation, exclude_comment_selections, facts):
    """The comments a run clusters, after the moderation and report filters."""
    # Fetch data from PostgreSQL
    comments, metadata = fetch_conversation_data(zid)
    if not comments:
        logger.error("Failed to fetch conversation data.")
        facts["comments_read"] = 0
        return None, None
    facts["comments_read"] = len(comments)

    logger.info(f"moderation status: {include_moderation}")

    if include_moderation:
        comments = [comment for comment in comments if comment["mod"] > -1]

    if exclude_comment_selections:
        logger.info(f"exclude_comment_selections is enabled, fetching report comment selections for zid {zid}")
        from polismath.job_child import input_bundle

        bundle = input_bundle.load(zid)
        postgres_client = None if bundle is not None else PostgresClient()
        try:
            if bundle is not None:
                selections = bundle.report_comment_selections()
            else:
                postgres_client.initialize()
                selections = postgres_client.get_report_comment_selections(zid)
            # Build a set of tids that should be excluded (selection == -1 in any report)
            excluded_tids = {
                sel["tid"] for sel in selections if sel.get("selection") == -1
            }
            if excluded_tids:
                original_count = len(comments)
                comments = [comment for comment in comments if comment["tid"] not in excluded_tids]
                logger.info(f"Excluded {original_count - len(comments)} comments based on report_comment_selections (tids: {excluded_tids})")
            else:
                logger.info("No excluded comment selections found for this conversation")
        finally:
            if postgres_client is not None:
                postgres_client.shutdown()

    facts["comments_used"] = len(comments)
    return comments, metadata


def _read_selected_inputs(zid, selection_name, facts):
    """Every comment of the conversation (the run embeds them all) and the ids of
    the comments the selection keeps (the run lays out, clusters and names only
    those), with the counts in the step's facts: read, embedded, selected, and
    left out by reason."""
    from polismath import selection as selections

    comments, metadata = fetch_conversation_data(zid)
    if not comments:
        logger.error("Failed to fetch conversation data.")
        facts["comments_read"] = 0
        return None, None, None
    facts["comments_read"] = len(comments)
    strict, velocities = fetch_selection_columns(zid)
    if velocities is not None:
        comments = [dict(c, velocity=velocities.get(int(c["tid"]))) for c in comments]
    chosen = selections.select(selection_name, comments, strict)
    kept = set(chosen.tids)
    with_text = [c for c in comments if c["txt"] and c["txt"].strip()]
    facts["selection"] = selection_name
    facts["strict_moderation"] = bool(strict)
    facts["comments_embedded"] = len(with_text)
    facts["comments_selected"] = sum(1 for c in with_text if int(c["tid"]) in kept)
    for reason, count in chosen.left_out.items():
        facts[f"left_out_{reason}"] = count
    facts["comments_used"] = facts["comments_selected"]
    logger.info(
        f"Selection {selection_name}: {facts['comments_selected']} of {facts['comments_embedded']} "
        f"comments laid out (left out: {chosen.left_out})"
    )
    return comments, metadata, kept


def _store_base(export_dynamo, conversation_id, document_vectors, document_map, cluster_layers,
                comment_texts, comment_ids, metadata, embedded=None):
    """The run's first writes: metadata, embeddings, UMAP edges, assignments, topics.

    With ``embedded`` (a run that names a selection: the texts, ids and vectors of
    every comment it embedded), the embeddings stored are those; everything else
    is of the selected comments the other arguments hold. Without it, both are
    the same comments, as they always were."""
    embed_texts, embed_ids, embed_vectors = (
        embedded if embedded is not None else (comment_texts, comment_ids, document_vectors)
    )
    # Initialize DynamoDB storage if requested
    dynamo_storage = None
    if export_dynamo:
        # Use endpoint from environment if available
        raw_endpoint = os.environ.get("DYNAMODB_ENDPOINT")
        endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None
        logger.info(f"Using DynamoDB endpoint from environment: {endpoint_url}")
        region = os.environ.get("AWS_REGION", "us-east-1")

        dynamo_storage = DynamoDBStorage(region_name=region, endpoint_url=endpoint_url)

        # Store basic data in DynamoDB
        logger.info(
            f"Storing basic data in DynamoDB for conversation {conversation_id}..."
        )

        # The model the vectors came from, named as the run record names it
        # (repo@revision:384 for the image's or the default model).
        from polismath.embedding_model import resolve
        model_name = resolve().model

        # Store conversation metadata
        logger.info("Storing conversation metadata...")
        conversation_meta = DataConverter.create_conversation_meta(
            conversation_id, document_vectors, cluster_layers, metadata,
            embedding_model=model_name,
        )
        dynamo_storage.create_conversation_meta(conversation_meta)

        # Store embeddings. With the per-row table on (migration 000038), the run's
        # embeddings go to that table with each comment's text SHA-256 as provenance,
        # not the codec family; off, the codec-family path is unchanged.
        logger.info("Storing comment embeddings...")
        if dynamo_storage.embeddings_table_enabled():
            import hashlib
            text_shas = [hashlib.sha256(text.encode("utf-8")).digest() for text in embed_texts]
            result = dynamo_storage.put_comment_embeddings_table(
                conversation_id, embed_ids, text_shas, embed_vectors, model_name
            )
        else:
            embedding_models = DataConverter.batch_convert_embeddings(
                conversation_id, embed_vectors, embed_ids, model=model_name
            )
            result = dynamo_storage.batch_create_comment_embeddings(embedding_models)
        logger.info(
            f"Stored {result['success']} embeddings with {result['failure']} failures"
        )

        # Store UMAP graph edges
        logger.info("Storing UMAP graph edges...")
        edge_models = DataConverter.batch_convert_umap_edges(
            conversation_id, document_map, cluster_layers, comment_ids=comment_ids
        )
        result = dynamo_storage.batch_create_graph_edges(edge_models)
        logger.info(
            f"Stored {result['success']} UMAP graph edges with {result['failure']} failures"
        )

        # Store cluster assignments
        logger.info("Storing comment cluster assignments...")
        cluster_models = DataConverter.batch_convert_clusters(
            conversation_id, cluster_layers, document_map, comment_ids
        )
        result = dynamo_storage.batch_create_comment_clusters(cluster_models)
        logger.info(
            f"Stored {result['success']} cluster assignments with {result['failure']} failures"
        )

        # Store cluster topics (basic info only)
        logger.info("Storing cluster topics...")
        topic_models = DataConverter.batch_convert_topics(
            conversation_id,
            cluster_layers,
            document_map,
            comment_texts,
            topic_names={},  # No topic names yet
            characteristics={},  # No characteristics yet
        )
        result = dynamo_storage.batch_create_cluster_topics(topic_models)
        logger.info(
            f"Stored {result['success']} topics with {result['failure']} failures"
        )
    return dynamo_storage


def _process_conversation(zid, output_dir, export_dynamo, name_topics, include_moderation,
                          exclude_comment_selections, total, selection=None):
    with step_log.step("inputs") as facts:
        if selection is None:
            comments, metadata = _read_inputs(zid, include_moderation, exclude_comment_selections, facts)
            selected = None
        else:
            if include_moderation or exclude_comment_selections:
                raise ValueError("a named selection is the whole rule: include_moderation and "
                                 "exclude_comment_selections must be off")
            comments, metadata, selected = _read_selected_inputs(zid, selection, facts)
    if not comments:
        return False
    if selected is not None and not facts["comments_selected"]:
        logger.error(f"Selection {selection} keeps no comment with text: nothing to lay out.")
        return False
    total["n_comments"] = len(comments)

    # Generate a job_id for this pipeline run
    # If DELPHI_JOB_ID is set (e.g., by a calling script like run_delphi.py), use that.
    job_id = os.environ.get("DELPHI_JOB_ID", f"pipeline_run_{uuid.uuid4()}")
    logger.info(f"Using job_id: {job_id} for this pipeline run.")

    conversation_id = str(zid)
    conversation_name = metadata.get("conversation_name", f"Conversation {zid}")

    # Process comments
    if selected is None:
        document_map, document_vectors, cluster_layers, comment_texts, comment_ids = (
            process_comments(comments, conversation_id)
        )
        embedded = None
    else:
        embedded, document_map, document_vectors, cluster_layers, comment_texts, comment_ids = (
            process_selected_comments(comments, conversation_id, selected)
        )

    with step_log.step("store_base", n_comments=len(comment_ids)):
        dynamo_storage = _store_base(export_dynamo, conversation_id, document_vectors, document_map,
                                     cluster_layers, comment_texts, comment_ids, metadata,
                                     embedded=embedded)

    # Process layers, store characteristics, and create visualizations
    process_layers_and_create_visualizations(
        conversation_id,
        conversation_name,
        document_map,
        cluster_layers,
        comment_texts,
        output_dir,
        name_topics=name_topics,
        dynamo_storage=dynamo_storage,
        job_id=job_id,  # Pass job_id
    )

    # The topic map step, off unless DELPHI_TOPIC_MAP_DOCUMENT=1: the run's
    # map, drawn from the families just written, stored in the run's own
    # result batch (polismath/delphi_storage/topic_map.py). Off, nothing here
    # runs or prints.
    from polismath.delphi_storage import topic_map
    if topic_map.enabled() and export_dynamo:
        from polismath.job_child import full_pipeline_models
        with step_log.step("topic_map") as facts:
            stored = topic_map.store_run_map(
                zid, selection, full_pipeline_models(),
                execution=topic_map.execution_record(step_log.recorded(), selection))
            facts["outcome"] = stored["outcome"] if stored else "not_stored"
            for key in ("reason", "failure", "document_bytes", "gzip_bytes", "family_bytes"):
                if stored and key in stored:
                    facts[key] = stored[key]

    # Save metadata
    with open(os.path.join(output_dir, f"{conversation_id}_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    logger.info(f"Processing of conversation {conversation_id} complete!")

    return True


def main():
    """Main entry point."""
    # Parse arguments
    import argparse

    parser = argparse.ArgumentParser(
        description="Process Polis conversation from PostgreSQL"
    )
    parser.add_argument(
        "--zid",
        type=int,
        required=False,
        default=22154,
        help="Conversation ID to process",
    )
    parser.add_argument(
        "--no-dynamo", action="store_true", help="Skip exporting to DynamoDB"
    )
    parser.add_argument("--db-host", type=str, default=None, help="PostgreSQL host")
    parser.add_argument("--db-port", type=int, default=None, help="PostgreSQL port")
    parser.add_argument(
        "--db-name", type=str, default=None, help="PostgreSQL database name"
    )
    parser.add_argument("--db-user", type=str, default=None, help="PostgreSQL user")
    parser.add_argument(
        "--db-password", type=str, default=None, help="PostgreSQL password"
    )
    parser.add_argument(
        "--use-mock-data",
        action="store_true",
        help="Use mock data instead of connecting to PostgreSQL",
    )
    parser.add_argument(
        "--name-topics",
        action="store_true",
        help="Generate LLM topic labels (provider via LLM_PROVIDER; default anthropic batch)",
    )
    parser.add_argument(
        "--use-ollama",
        action="store_true",
        help="Deprecated alias for --name-topics that forces LLM_PROVIDER=ollama",
    )
    parser.add_argument(
        "--include_moderation",
        type=parse_bool_flag,
        default=False,
        help="Whether or not to include moderated comments in reports. If false, moderated comments will appear.",
    )
    parser.add_argument(
        "--exclude_comment_selections",
        type=parse_bool_flag,
        default=True,
        help="Whether to exclude comments with selection=-1 in report_comment_selections table.",
    )
    from polismath.selection import SELECTIONS
    parser.add_argument(
        "--selection",
        choices=SELECTIONS,
        default=None,
        help="Embed every comment, and lay out, cluster and name only those this selection keeps "
             "(the whole rule: both filters above must be False). Absent, the run is what it was.",
    )

    args = parser.parse_args()
    if args.selection is not None and (args.include_moderation or args.exclude_comment_selections):
        parser.error("--selection is the whole rule: it takes --include_moderation=False "
                     "and --exclude_comment_selections=False")

    # Set up environment
    setup_environment(
        db_host=args.db_host,
        db_port=args.db_port,
        db_name=args.db_name,
        db_user=args.db_user,
        db_password=args.db_password,
    )

    # Resolve topic-naming request. --use-ollama is a deprecated alias that both
    # enables naming and forces the ollama provider.
    if args.use_ollama:
        logger.warning(
            "--use-ollama is deprecated; use --name-topics with LLM_PROVIDER=ollama. "
            "Forcing LLM_PROVIDER=ollama for this run."
        )
        os.environ["LLM_PROVIDER"] = "ollama"
    name_topics = args.name_topics or args.use_ollama
    if name_topics:
        logger.info(
            f"Topic naming enabled (provider={resolve_provider_type()}, "
            f"model={resolve_model_name(resolve_provider_type())})"
        )

    # Process conversation
    if args.use_mock_data:
        logger.info("Using mock data instead of connecting to PostgreSQL")
        # Create mock comments data
        mock_comments = []
        for i in range(100):
            mock_comments.append(
                {
                    "tid": i,
                    "zid": args.zid,
                    "txt": f"This is a mock comment {i} for testing purposes without PostgreSQL connection.",
                    "created": datetime.now().isoformat(),
                    "pid": i % 20,  # Mock 20 different participants
                    "active": True,
                }
            )

        # Create mock metadata
        mock_metadata = {
            "conversation_id": str(args.zid),
            "zid": args.zid,
            "conversation_name": f"Mock Conversation {args.zid}",
            "description": "Mock conversation for testing without PostgreSQL",
            "created": datetime.now().isoformat(),
            "modified": datetime.now().isoformat(),
            "owner": "mock_user",
            "num_comments": len(mock_comments),
        }

        # Process with mock data
        document_map, document_vectors, cluster_layers, comment_texts, comment_ids = (
            process_comments(mock_comments, str(args.zid))
        )

        # Process each layer and create visualizations
        output_dir = os.path.join(
            "polis_data", str(args.zid), "python_output", "comments_enhanced_multilayer"
        )
        os.makedirs(output_dir, exist_ok=True)

        process_layers_and_create_visualizations(
            str(args.zid),
            mock_metadata.get("conversation_name"),
            document_map,
            cluster_layers,
            comment_texts,
            output_dir,
            name_topics=name_topics,
        )
    else:
        # Process with real data from PostgreSQL. process_conversation returns
        # False when it could not fetch the conversation; that is a failed
        # stage, and the exit code must say so (run_delphi.py reads it).
        ok = process_conversation(
            args.zid,
            export_dynamo=not args.no_dynamo,
            name_topics=name_topics,
            include_moderation=args.include_moderation,
            exclude_comment_selections=args.exclude_comment_selections,
            selection=args.selection,
        )
        if not ok:
            logger.error(f"Processing conversation {args.zid} failed.")
            sys.exit(1)


if __name__ == "__main__":
    main()
