#!/usr/bin/env python3
"""
Generate batch narrative reports for Polis conversations using Anthropic's Batch API.

This script is an optimized version of 800_report_topic_clusters.py that:
1. Prepares batch requests for all topics in a conversation
2. Submits them to Anthropic's Batch API
3. Stores batch job metadata in DynamoDB
4. Provides a way to check batch job status

Usage:
    python 801_narrative_report_batch.py --conversation_id CONVERSATION_ID [--model MODEL] [--no-cache] [--layers LAYER_NUMBERS...]

Args:
    --conversation_id: Conversation ID/zid
    --model: LLM model to use (defaults to ANTHROPIC_MODEL env var)
    --no-cache: Ignore cached report data
    --max-batch-size: Maximum number of topics to include in a single batch (default: 20)
    --layers: Specific layer numbers to process (e.g., --layers 0 1 2). If not specified, all layers will be processed.
"""

import os
import sys
import json
import time
import uuid
import logging
import argparse
import boto3
import asyncio
import numpy as np
import pandas as pd
import re  # Added re import for regex operations
import requests  # Added for HTTP error handling
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Union, Tuple
import xml.etree.ElementTree as ET
from xml.dom.minidom import parseString
import csv
import io
import xmltodict
from collections import defaultdict
import traceback  # Added for detailed error tracing

# Import the model provider
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from umap_narrative.llm_factory_constructor import get_model_provider
from umap_narrative.llm_factory_constructor.model_provider import AnthropicProvider

# Import from local modules
from polismath_commentgraph.utils.storage import PostgresClient, DynamoDBStorage
from polismath_commentgraph.utils.group_data import GroupDataProcessor

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class NarrativeReportService:
    """Storage service for narrative reports in DynamoDB."""

    def __init__(self, table_name="Delphi_NarrativeReports", dynamodb_resource=None):
        """Initialize the narrative report service."""
        self.table_name = table_name
        if dynamodb_resource:
            self.dynamodb = dynamodb_resource
        else:
            endpoint_url = os.environ.get('DYNAMODB_ENDPOINT') or None
            self.dynamodb = boto3.resource(
                'dynamodb',
                endpoint_url=endpoint_url,
                region_name=os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')
            )
        
        self.table = self.dynamodb.Table(self.table_name)

    def store_report(self, report_id, section, model, report_data, job_id=None, metadata=None):
        """Store a report in DynamoDB.

        Args:
            report_id: The report ID
            section: The section of the report
            model: The model used to generate the report
            report_data: The generated report content
            job_id: The ID of the job that generated this report (optional)
            metadata: Additional metadata to store with the report (optional)

        Returns:
            Response from DynamoDB
        """
        try:
            # Create a combined key for the report (report_id, section, model)
            rid_section_model = f"{report_id}#{section}#{model}"

            # Current timestamp
            timestamp = datetime.now().isoformat()

            # Create item to store
            item = {
                'rid_section_model': rid_section_model,
                'timestamp': timestamp,
                'report_id': report_id,
                'section': section,
                'model': model,
                'report_data': report_data
            }

            # Add job_id if provided
            if job_id:
                item['job_id'] = job_id
                
            # Add metadata if provided
            if metadata:
                item['metadata'] = metadata

            # Store in DynamoDB
            response = self.table.put_item(Item=item)
            logger.info(f"Report stored successfully for {rid_section_model}")
            return response
        except Exception as e:
            logger.error(f"Error storing report: {str(e)}")
            return None

    def get_report(self, report_id, section, model):
        """Get a report from DynamoDB.

        Args:
            report_id: The report ID
            section: The section of the report
            model: The model used to generate the report

        Returns:
            The report data if found, None otherwise
        """
        try:
            # Create the combined key
            rid_section_model = f"{report_id}#{section}#{model}"

            # Get from DynamoDB
            response = self.table.get_item(Key={'rid_section_model': rid_section_model})

            # Return the item if found
            return response.get('Item')
        except Exception as e:
            logger.error(f"Error getting report: {str(e)}")
            return None

class PolisConverter:
    """Convert between CSV and XML formats for Polis data."""
    
    @staticmethod
    def convert_to_xml(comment_data):
        """
        Convert comment data to XML format.
        
        Args:
            comment_data: List of dictionaries with comment data
            
        Returns:
            String with XML representation of the comment data
        """
        # Create root element
        root = ET.Element("polis-comments")
        
        # Process each comment
        for record in comment_data:
            # Extract base comment data
            comment = ET.SubElement(root, "comment", {
                "id": str(record.get("comment-id", "")),
                "votes": str(record.get("total-votes", 0)),
                "agrees": str(record.get("total-agrees", 0)),
                "disagrees": str(record.get("total-disagrees", 0)),
                "passes": str(record.get("total-passes", 0)),
            })
            
            # Add comment text
            text = ET.SubElement(comment, "text")
            text.text = record.get("comment", "")
            
            # Process group data
            group_keys = []
            for key in record.keys():
                if key.startswith("group-") and key.count("-") >= 2:
                    group_id = key.split("-")[1]
                    if group_id not in group_keys:
                        group_keys.append(group_id)
            
            # Add data for each group
            for group_id in group_keys:
                group = ET.SubElement(comment, f"group-{group_id}", {
                    "votes": str(record.get(f"group-{group_id}-votes", 0)),
                    "agrees": str(record.get(f"group-{group_id}-agrees", 0)),
                    "disagrees": str(record.get(f"group-{group_id}-disagrees", 0)),
                    "passes": str(record.get(f"group-{group_id}-passes", 0)),
                })
        
        # Convert to string with pretty formatting
        rough_string = ET.tostring(root, 'utf-8')
        reparsed = parseString(rough_string)
        return reparsed.toprettyxml(indent="  ")

class BatchReportGenerator:
    """Generate batch reports for Polis conversations."""

    def __init__(self, conversation_id, model=None, no_cache=False, max_batch_size=20, job_id=None, layers=None, include_moderation=False):
        """Initialize the batch report generator."""
        self.conversation_id = str(conversation_id)
        if not model:
            model = os.environ.get("ANTHROPIC_MODEL")
            if not model:
                raise ValueError("Model must be specified via --model argument or ANTHROPIC_MODEL environment variable")
        self.model = model
        self.no_cache = no_cache
        self.max_batch_size = max_batch_size
        self.layers = layers  # List of layers to process, or None for all layers
        self.job_id = job_id or os.environ.get('DELPHI_JOB_ID')
        self.report_id = os.environ.get('DELPHI_REPORT_ID')
        self.postgres_client = PostgresClient()
        self.include_moderation = include_moderation

        logger.info(f"include_moderation: {include_moderation}")

        endpoint_url = os.environ.get('DYNAMODB_ENDPOINT') or None
        self.dynamodb = boto3.resource(
            'dynamodb',
            endpoint_url=endpoint_url,
            region_name=os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')
        )

        self.report_storage = NarrativeReportService(dynamodb_resource=self.dynamodb)
        self.group_processor = GroupDataProcessor(self.postgres_client)

        current_dir = Path(__file__).parent
        self.prompt_base_path = current_dir / "report_experimental"
    
    def _get_math_main_data(self, conversation_id):
        """
        Get pre-calculated math data from the Clojure math pipeline stored in math_main table.
        
        Args:
            conversation_id: Conversation ID (zid)
            
        Returns:
            Dictionary containing math results including group_aware_consensus and comment_extremity
        """
        try:
            # Query the math_main table for the conversation's math results
            sql = """
            SELECT data 
            FROM math_main 
            WHERE zid = :zid AND math_env = :math_env
            ORDER BY modified DESC 
            LIMIT 1
            """
            
            # Use 'prod' as the default math_env (matches the server behavior)
            math_env = os.environ.get('MATH_ENV', 'prod')
            
            results = self.postgres_client.query(sql, {"zid": conversation_id, "math_env": math_env})
            
            if not results:
                logger.warning(f"No math_main data found for conversation {conversation_id} with math_env {math_env}")
                return None
            
            # Parse the JSON data
            math_data = results[0]['data']
            if isinstance(math_data, str):
                import json
                math_data = json.loads(math_data)
            
            logger.info(f"Successfully retrieved math_main data for conversation {conversation_id}")
            logger.debug(f"Math data keys: {list(math_data.keys()) if isinstance(math_data, dict) else 'not a dict'}")
            
            return math_data
            
        except Exception as e:
            logger.error(f"Error retrieving math_main data for conversation {conversation_id}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    
    async def get_conversation_data(self):
        """Get conversation data from PostgreSQL and DynamoDB."""
        try:
            # Initialize connection
            self.postgres_client.initialize()
            
            # Get conversation metadata
            conversation = self.postgres_client.get_conversation_by_id(int(self.conversation_id))
            if not conversation:
                logger.error(f"Conversation {self.conversation_id} not found in database.")
                return None
            
            # Get comments
            comments = self.postgres_client.get_comments_by_conversation(int(self.conversation_id))
            logger.info(f"Retrieved {len(comments)} comments from conversation {self.conversation_id}")

            if self.include_moderation:
                comments = [comment for comment in comments if comment['mod'] > -1]
            
            # Get math data from the Clojure math pipeline (stored in math_main table)
            math_data = self._get_math_main_data(int(self.conversation_id))
            if not math_data:
                logger.warning(f"No math data found in math_main for conversation {self.conversation_id}")
                return None
            
            # Extract pre-calculated metrics from Clojure math pipeline
            tids = math_data.get('tids', [])
            extremity_array = math_data.get('pca', {}).get('comment-extremity', [])
            consensus_object = math_data.get('group-aware-consensus', {})
            
            logger.info(f"Retrieved {len(tids)} comment IDs with pre-calculated metrics from Clojure math pipeline")
            
            # Create lookup maps for the pre-calculated values
            extremity_map = {}
            consensus_map = {}
            
            for i, tid in enumerate(tids):
                if i < len(extremity_array):
                    extremity_map[str(tid)] = extremity_array[i]
                if str(tid) in consensus_object:
                    consensus_map[str(tid)] = consensus_object[str(tid)]
            
            # Get basic comment and vote data (without recalculating metrics)
            export_data = self.group_processor.get_export_data(int(self.conversation_id), self.include_moderation)
            processed_comments = export_data.get('comments', [])
            
            # Enrich comments with pre-calculated Clojure metrics
            for comment in processed_comments:
                comment_id = str(comment.get('comment_id', ''))
                # Use pre-calculated values from Clojure math pipeline
                comment['comment_extremity'] = extremity_map.get(comment_id, 0)
                comment['group_aware_consensus'] = consensus_map.get(comment_id, 0)
                # Keep the calculated num_groups from GroupDataProcessor
                # (this is just a count, not a complex calculation)
            
            logger.info(f"Enriched {len(processed_comments)} comments with Clojure-calculated metrics")
            
            # Load cluster assignments from DynamoDB
            cluster_map = self.load_comment_clusters_from_dynamodb(self.conversation_id)
            
            # Enrich comments with cluster assignments from all layers
            enriched_count = 0
            total_assignments = 0
            for comment in processed_comments:
                comment_id = str(comment.get('comment_id', ''))
                if comment_id in cluster_map:
                    # Add cluster assignments for all layers
                    for layer_id, cluster_id in cluster_map[comment_id].items():
                        comment[f'layer{layer_id}_cluster_id'] = cluster_id
                        total_assignments += 1
                    enriched_count += 1
            
            # Log cluster assignment results
            if enriched_count > 0:
                logger.info(f"Enriched {enriched_count} comments with {total_assignments} total cluster assignments across all layers")
            else:
                logger.warning("No comments could be enriched with cluster assignments")
            
            return {
                "conversation": conversation,
                "comments": comments,
                "processed_comments": processed_comments,
                "math_data": math_data
            }
        except Exception as e:
            logger.error(f"Error getting conversation data: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return None
        finally:
            # Clean up connection
            self.postgres_client.shutdown()
    
    # (Inside the BatchReportGenerator class)
    def load_comment_clusters_from_dynamodb(self, conversation_id):
        """
        Load cluster assignments for comments from DynamoDB using an efficient Query.
        Returns a nested structure: {comment_id: {layer_id: cluster_id, ...}}
        """
        try:
            clusters_table = self.dynamodb.Table('Delphi_CommentHierarchicalClusterAssignments')
            cluster_map = {}
            
            logger.info(f"Querying for cluster assignments for conversation_id: {conversation_id}")
            last_evaluated_key = None
            available_layers = set()
            
            while True:
                query_kwargs = {
                    'KeyConditionExpression': boto3.dynamodb.conditions.Key('conversation_id').eq(str(conversation_id))
                }
                if last_evaluated_key:
                    query_kwargs['ExclusiveStartKey'] = last_evaluated_key

                response = clusters_table.query(**query_kwargs)
                
                for item in response.get('Items', []):
                    comment_id = item.get('comment_id')
                    if comment_id is not None:
                        comment_id_str = str(comment_id)
                        if comment_id_str not in cluster_map:
                            cluster_map[comment_id_str] = {}
                        
                        # Extract all layer cluster assignments
                        for key, value in item.items():
                            if key.startswith('layer') and key.endswith('_cluster_id') and value is not None:
                                # Extract layer number from key like 'layer0_cluster_id'
                                layer_num_str = key.replace('layer', '').replace('_cluster_id', '')
                                try:
                                    layer_num = int(layer_num_str)
                                    cluster_map[comment_id_str][layer_num] = value
                                    available_layers.add(layer_num)
                                except ValueError:
                                    # Skip invalid layer keys
                                    continue
                
                last_evaluated_key = response.get('LastEvaluatedKey')
                if not last_evaluated_key:
                    break

            logger.info(f"Loaded {len(cluster_map)} comment cluster assignments across {len(available_layers)} layers: {sorted(available_layers)}")
            return cluster_map
        except Exception as e:
            logger.error(f"Error loading cluster assignments from DynamoDB: {e}")
            return {}

    async def get_topics(self):
        """
        Gets all topics for the conversation from DynamoDB, efficiently fetching
        all necessary data with a minimal number of queries.
        """
        try:
            # Fetch all topic names for the conversation
            logger.info(f"Fetching all topic names for conversation {self.conversation_id}...")
            topic_names_table = self.dynamodb.Table('Delphi_CommentClustersLLMTopicNames')
            topic_names_items = []
            last_key = None
            while True:
                query_kwargs = {
                    'KeyConditionExpression': boto3.dynamodb.conditions.Key('conversation_id').eq(self.conversation_id)
                }
                if last_key:
                    query_kwargs['ExclusiveStartKey'] = last_key
                response = topic_names_table.query(**query_kwargs)
                topic_names_items.extend(response.get('Items', []))
                last_key = response.get('LastEvaluatedKey')
                if not last_key:
                    break
            logger.info(f"Fetched {len(topic_names_items)} total topic name entries.")

            # Fetch all cluster structure/keyword data for the conversation at once
            logger.info(f"Fetching all structure/keyword data for conversation {self.conversation_id}...")
            keywords_table = self.dynamodb.Table('Delphi_CommentClustersStructureKeywords')
            keyword_items = []
            last_key = None
            while True:
                query_kwargs = {
                    'KeyConditionExpression': boto3.dynamodb.conditions.Key('conversation_id').eq(self.conversation_id)
                }
                if last_key:
                    query_kwargs['ExclusiveStartKey'] = last_key
                response = keywords_table.query(**query_kwargs)
                keyword_items.extend(response.get('Items', []))
                last_key = response.get('LastEvaluatedKey')
                if not last_key:
                    break
            
            # Create a fast, in-memory lookup map for keywords
            keywords_lookup = {item['cluster_key']: item for item in keyword_items}
            logger.info(f"Created lookup map for {len(keywords_lookup)} keyword entries.")
            
            # Load all cluster assignments for all comments
            all_clusters = await asyncio.to_thread(self.load_comment_clusters_from_dynamodb, self.conversation_id)
            
            # --- Step 2: Process the fetched data ---
            
            available_layers = set(layer for clusters in all_clusters.values() for layer in clusters.keys())
            layers_to_process = sorted(list(available_layers))
            if self.layers is not None:
                layers_to_process = [layer for layer in layers_to_process if layer in self.layers]
            
            logger.info(f"Preparing to process topics for layers: {layers_to_process}")
            
            all_topics = []
            for layer_id in layers_to_process:
                logger.info(f"Processing layer {layer_id}")
                
                # Filter topic names for the current layer
                layer_topic_names = [item for item in topic_names_items if int(item.get('layer_id', -1)) == layer_id]
                
                # Build a map of {cluster_id: [comment_ids]} for the current layer
                topic_comments = defaultdict(list)
                for comment_id, comment_clusters in all_clusters.items():
                    if layer_id in comment_clusters:
                        cluster_id = comment_clusters[layer_id]
                        topic_comments[cluster_id].append(int(comment_id))

                # Process each topic within the current layer
                for topic_item in layer_topic_names:
                    cluster_id = topic_item.get('cluster_id')
                    topic_key = topic_item.get('topic_key')

                    if cluster_id is None or not topic_key:
                        logger.warning(f"Skipping invalid topic item: {topic_item}")
                        continue

                    # Use the pre-fetched keyword data
                    cluster_lookup_key = f'layer{layer_id}_{cluster_id}'
                    cluster_structure_item = keywords_lookup.get(cluster_lookup_key, {})
                    
                    # Extract sample comments safely from the retrieved item
                    sample_comments = []
                    raw_samples = cluster_structure_item.get('sample_comments', [])
                    if isinstance(raw_samples, list):
                        sample_comments = [str(s) for s in raw_samples]

                    topic = {
                        "layer_id": layer_id,
                        "cluster_id": cluster_id,
                        "name": topic_item.get('topic_name', f"Topic {cluster_id}"),
                        "topic_key": topic_key,
                        "citations": topic_comments.get(cluster_id, []),
                        "sample_comments": sample_comments
                    }
                    all_topics.append(topic)

            # --- Step 3: Add global sections ---
            if not self.job_id:
                raise ValueError("job_id is required for versioned topic keys but is missing or empty")
            
            global_topic_prefix = f"{self.job_id}_global"
            global_sections = [
                {"section_type": "global", "name": "groups", "topic_key": f"{global_topic_prefix}_groups", "filter_type": "comment_extremity", "filter_threshold": 1.0},
                {"section_type": "global", "name": "group_informed_consensus", "topic_key": f"{global_topic_prefix}_group_informed_consensus", "filter_type": "group_aware_consensus", "filter_threshold": "dynamic"},
                {"section_type": "global", "name": "uncertainty", "topic_key": f"{global_topic_prefix}_uncertainty", "filter_type": "uncertainty_ratio", "filter_threshold": 0.2}
            ]
            for section in global_sections: # Ensure placeholder keys exist
                section.setdefault('citations', [])
                section.setdefault('sample_comments', [])

            all_topics.extend(global_sections)
            logger.info(f"Created {len(all_topics)} sections total: {len(all_topics) - len(global_sections)} layer topics + {len(global_sections)} global sections")
            
            # Sort topics for processing
            all_topics.sort(key=lambda x: (0 if x.get('section_type') == 'global' else 1, x.get('layer_id', -1), -len(x.get('citations', []))))
            
            return all_topics
        
        except Exception as e:
            logger.error(f"A critical error occurred in get_topics: {str(e)}", exc_info=True)
            return []
        
    def filter_topics(self, comment, topic_cluster_id=None, topic_layer_id=None, topic_citations=None, sample_comments=None, filter_type=None, filter_threshold=None):
        """Filter for comments that are part of a specific topic or meet global section criteria."""
        # Get comment ID
        comment_id = comment.get('comment_id')
        if not comment_id:
            return False
        
        # Handle global section filtering
        if filter_type is not None:
            return self._apply_global_filter(comment, filter_type, filter_threshold)
        
        # Handle layer-specific topic filtering (existing logic)
        if topic_cluster_id is not None and topic_layer_id is not None:
            # Get the cluster ID for the specified layer
            layer_cluster_key = f'layer{topic_layer_id}_cluster_id'
            comment_cluster_id = comment.get(layer_cluster_key)
            if comment_cluster_id is not None:
                # Debug logging for cluster 0
                if str(topic_cluster_id) == "0" and comment_id in [1, 2, 3]:  # Log first few comments
                    logger.info(f"DEBUG: Checking comment {comment_id} - layer{topic_layer_id}_cluster_id={comment_cluster_id}, topic_cluster_id={topic_cluster_id}")
                    logger.info(f"DEBUG: String comparison: '{str(comment_cluster_id)}' == '{str(topic_cluster_id)}' = {str(comment_cluster_id) == str(topic_cluster_id)}")
                
                # Simple string comparison is more reliable across different numeric types
                if str(comment_cluster_id) == str(topic_cluster_id):
                    return True
                
        # Check if this comment ID is in our topic citations
        if topic_citations and str(comment_id) in [str(c) for c in topic_citations]:
            return True
            
        # If we have sample comments and not enough filtered comments,
        # try to match based on text similarity
        if sample_comments and len(sample_comments) > 0:
            comment_text = comment.get('comment', '')
            if not comment_text:
                return False
                
            # Check if this comment text matches any sample comment
            for sample in sample_comments:
                # Skip non-string samples
                if not isinstance(sample, str) or not sample:
                    continue
                    
                # Simple substring match rather than complex word comparison
                if sample.lower() in comment_text.lower() or comment_text.lower() in sample.lower():
                    return True
        
        return False
    
    def _apply_global_filter(self, comment, filter_type, filter_threshold):
        """
        Apply global section filtering based on Polis statistical metrics.
        
        Args:
            comment: Comment data dictionary
            filter_type: Type of filter ('comment_extremity', 'group_aware_consensus', 'uncertainty_ratio')
            filter_threshold: Threshold value for filtering (or 'dynamic' for group_aware_consensus)
            
        Returns:
            Boolean indicating whether comment passes the filter
        """
        try:
            if filter_type == "comment_extremity":
                # Filter for comments that divide opinion groups (extremity > 1.0)
                extremity = comment.get('comment_extremity', 0)
                return extremity > filter_threshold
                
            elif filter_type == "group_aware_consensus":
                # Filter for comments with broad cross-group agreement
                # Uses dynamic thresholds based on number of groups
                consensus = comment.get('group_aware_consensus', 0)
                num_groups = comment.get('num_groups', 2)
                
                # Get dynamic threshold based on group count (matches Node.js logic)
                if filter_threshold == "dynamic":
                    if num_groups == 2:
                        threshold = 0.7
                    elif num_groups == 3:
                        threshold = 0.47
                    elif num_groups == 4:
                        threshold = 0.32
                    else:  # 5+ groups
                        threshold = 0.24
                else:
                    threshold = filter_threshold
                    
                return consensus > threshold
                
            elif filter_type == "uncertainty_ratio":
                # Filter for comments with high uncertainty/unsure responses (>= 20% pass votes)
                passes = comment.get('passes', 0)
                votes = comment.get('votes', 0)
                
                if votes == 0:
                    return False
                    
                uncertainty_ratio = passes / votes
                return uncertainty_ratio >= filter_threshold
                
            else:
                logger.warning(f"Unknown filter type: {filter_type}")
                return False
                
        except Exception as e:
            logger.error(f"Error applying global filter {filter_type}: {str(e)}")
            return False
    
    def _get_dynamic_comment_limit(self, layer_id=None, total_layers=None, comment_count=None, filter_type=None):
        """
        Calculate dynamic comment limit based on layer granularity and conversation size.
        Implements the fractal approach where coarse layers get fewer, higher quality comments.
        
        Args:
            layer_id: Current layer ID (None for global sections)
            total_layers: Total number of available layers  
            comment_count: Total number of comments in conversation
            filter_type: Type of filter (for global sections)
            
        Returns:
            Integer comment limit for this section
        """
        try:
            # Base limits for different categories
            base_limits = {
                "global_sections": 50,   # Fixed limit for global sections
                "fine_layers": 100,      # More comments for specific topics (layer 0)
                "medium_layers": 75,     # Balanced approach (middle layers)
                "coarse_layers": 50      # Fewer, highest quality comments (top layer)
            }
            
            # Determine category
            if filter_type is not None:
                # This is a global section
                category = "global_sections"
            elif layer_id is not None and total_layers is not None:
                # This is a layer-specific topic
                if layer_id == 0:
                    category = "fine_layers"  # Most specific layer
                elif layer_id == total_layers - 1:
                    category = "coarse_layers"  # Most general layer
                else:
                    category = "medium_layers"  # Middle layers
            else:
                # Fallback to medium limit
                category = "medium_layers"
            
            # Get base limit
            limit = base_limits[category]
            
            # Scale down for very large conversations to manage token usage
            if comment_count is not None:
                if comment_count > 10000:
                    # Halve limits for huge conversations (>10k comments)
                    limit = int(limit * 0.5)
                elif comment_count > 5000:
                    # Reduce by 25% for large conversations (5k-10k comments)
                    limit = int(limit * 0.75)
                elif comment_count > 2000:
                    # Reduce by 10% for medium-large conversations (2k-5k comments)
                    limit = int(limit * 0.9)
            
            # Ensure minimum limit
            limit = max(limit, 10)
            
            logger.debug(f"Dynamic comment limit: category={category}, base={base_limits[category]}, "
                        f"final={limit}, comment_count={comment_count}, layer_id={layer_id}")
            
            return limit
            
        except Exception as e:
            logger.error(f"Error calculating dynamic comment limit: {str(e)}")
            # Fallback to conservative limit
            return 50
    
    def _select_high_quality_comments(self, comments, limit, filter_type=None):
        """
        Select the highest quality comments based on Polis statistical metrics.
        
        Args:
            comments: List of comment dictionaries
            limit: Maximum number of comments to select
            filter_type: Type of filter being applied (affects sorting priority)
            
        Returns:
            List of selected high-quality comments
        """
        if len(comments) <= limit:
            return comments
            
        try:
            # Create sorting key based on filter type and available metrics
            def get_sort_key(comment):
                # Base score starts with vote count (engagement indicator)
                votes = comment.get('votes', 0)
                vote_score = int(votes) if isinstance(votes, (int, float)) else 0
                
                # Add metric-specific scoring
                if filter_type == "comment_extremity":
                    # For extremity filtering, prioritize highly divisive comments
                    extremity = comment.get('comment_extremity', 0)
                    metric_score = extremity * 1000  # Scale up for sorting
                elif filter_type == "group_aware_consensus":
                    # For consensus filtering, prioritize high agreement comments
                    consensus = comment.get('group_aware_consensus', 0)
                    metric_score = consensus * 1000  # Scale up for sorting
                elif filter_type == "uncertainty_ratio":
                    # For uncertainty filtering, prioritize comments with high pass rates
                    passes = comment.get('passes', 0)
                    total_votes = comment.get('votes', 1)
                    uncertainty = passes / max(total_votes, 1)
                    metric_score = uncertainty * 1000  # Scale up for sorting
                else:
                    # For topic filtering, use a combination of votes and engagement
                    agrees = comment.get('agrees', 0)
                    disagrees = comment.get('disagrees', 0)
                    total_engagement = int(agrees) + int(disagrees) if isinstance(agrees, (int, float)) and isinstance(disagrees, (int, float)) else 0
                    metric_score = total_engagement
                
                # Combine scores (metric score is primary, vote count is secondary)
                return (metric_score, vote_score)
            
            # Sort comments by quality score (descending)
            sorted_comments = sorted(comments, key=get_sort_key, reverse=True)
            
            # Select top comments up to limit
            selected = sorted_comments[:limit]
            
            logger.info(f"Selected {len(selected)} high-quality comments from {len(comments)} "
                       f"(filter_type={filter_type}, limit={limit})")
            
            return selected
            
        except Exception as e:
            logger.error(f"Error selecting high-quality comments: {str(e)}")
            # Fallback to simple vote-based selection
            try:
                sorted_comments = sorted(comments, 
                                       key=lambda c: int(c.get('votes', 0)) if isinstance(c.get('votes'), (int, float)) else 0, 
                                       reverse=True)
                return sorted_comments[:limit]
            except Exception:
                # Last resort: return first N comments
                return comments[:limit]
    
    async def get_comments_as_xml(self, conversation_data: dict, filter_func=None, filter_args=None):
        """Get comments as XML from pre-fetched data."""
        try:
            # Use the data passed as an argument
            data = conversation_data
            
            if not data:
                logger.error("Received empty conversation data.")
                return ""
            
            # Apply filter if provided
            filtered_comments = data["processed_comments"]
            
            if filter_func:
                if filter_args:
                    filtered_comments = [c for c in filtered_comments if filter_func(c, **filter_args)]
                else:
                    filtered_comments = [c for c in filtered_comments if filter_func(c)]
            
            # Apply dynamic comment limiting with intelligent selection
            if filter_func == self.filter_topics and len(filtered_comments) > 0:
                # Get context for dynamic limit calculation
                total_comment_count = len(data["processed_comments"])
                
                # Extract layer and filter information from filter_args
                layer_id = None
                total_layers = None
                filter_type = None
                
                if filter_args:
                    layer_id = filter_args.get('topic_layer_id')
                    filter_type = filter_args.get('filter_type')
                    
                    # Estimate total layers from conversation data (could be improved)
                    # For now, we'll determine this dynamically or use a reasonable default
                    if layer_id is not None:
                        # Try to determine total layers from available cluster data
                        # This is a heuristic - in practice you might want to pass this explicitly
                        total_layers = max(layer_id + 1, 3)  # Assume at least 3 layers if we have layer data
                
                # Calculate dynamic limit
                comment_limit = self._get_dynamic_comment_limit(
                    layer_id=layer_id,
                    total_layers=total_layers, 
                    comment_count=total_comment_count,
                    filter_type=filter_type
                )
                
                # Apply intelligent comment selection if we exceed the limit
                if len(filtered_comments) > comment_limit:
                    logger.info(f"Applying dynamic comment limit: {len(filtered_comments)} -> {comment_limit} "
                               f"(layer_id={layer_id}, filter_type={filter_type}, total_comments={total_comment_count})")
                    
                    # Use intelligent selection based on Polis metrics
                    filtered_comments = self._select_high_quality_comments(
                        filtered_comments, 
                        comment_limit, 
                        filter_type=filter_type
                    )
                else:
                    logger.info(f"No limiting needed: {len(filtered_comments)} comments <= limit of {comment_limit}")
            else:
                # For non-topic filtering, use a conservative limit to avoid token issues
                max_comments = 100
                if len(filtered_comments) > max_comments:
                    logger.info(f"Applying conservative limit: {len(filtered_comments)} -> {max_comments}")
                    filtered_comments = self._select_high_quality_comments(filtered_comments, max_comments)
            
            # Convert to XML
            xml = PolisConverter.convert_to_xml(filtered_comments)
            
            return xml
        except Exception as e:
            logger.error(f"Error in get_comments_as_xml: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return ""
    
    async def prepare_batch_requests(self):
        """Prepare batch requests for all topics."""
        logger.info("Fetching all conversation data ONCE...")
        conversation_data = await self.get_conversation_data()
        if not conversation_data:
            logger.error("Failed to fetch conversation data. Cannot prepare batch requests.")
            return []
        
        topics = await self.get_topics()
        
        logger.info(f"Preparing batch requests for {len(topics)} topics")
        
        # Read system lore
        system_path = self.prompt_base_path / 'system.xml'
        if not system_path.exists():
            logger.error(f"System file not found: {system_path}")
            return []
        
        with open(system_path, 'r') as f:
            system_lore = f.read()
        
        # Template content will be selected per topic based on section type
        
        # Initialize list for batch requests
        batch_requests = []
        
        # For each topic, prepare a prompt and add it to the batch
        for topic in topics:
            topic_name = topic['name']
            topic_key = topic['topic_key']  # Use the stable topic_key from DynamoDB
            
            # Convert topic_key to section_name format
            # Topic keys use # delimiters (uuid#layer#cluster) but section names use _ delimiters (uuid_layer_cluster)
            if '#' in topic_key:
                # Versioned format: convert uuid#layer#cluster -> uuid_layer_cluster
                section_name = topic_key.replace('#', '_')
            else:
                # Legacy format: use as-is (layer0_0, global_groups, etc.)
                section_name = topic_key
            
            # Check if this is a global section or layer-specific topic
            is_global_section = topic.get('section_type') == 'global'
            
            if is_global_section:
                # Global section - use filter_type and filter_threshold
                filter_type = topic.get('filter_type')
                filter_threshold = topic.get('filter_threshold')
                topic_cluster_id = None
                topic_layer_id = None
                
                # Create filter args for global section
                filter_args = {
                    'filter_type': filter_type,
                    'filter_threshold': filter_threshold
                }
                
                logger.info(f"Global section mapping - name: {topic_name}, filter_type: {filter_type}, "
                           f"filter_threshold: {filter_threshold}, topic_key: {topic_key}")
            else:
                # Layer-specific topic - use cluster_id and layer_id
                topic_cluster_id = topic['cluster_id']
                topic_layer_id = topic['layer_id']
                
                # Create filter args for layer-specific topic
                filter_args = {
                    'topic_cluster_id': topic_cluster_id,
                    'topic_layer_id': topic_layer_id,
                    'topic_citations': topic.get('citations', []),
                    'sample_comments': topic.get('sample_comments', [])
                }
                
                logger.info(f"Topic mapping - cluster_id: {topic_cluster_id}, layer_id: {topic_layer_id}, "
                           f"topic_name: {topic_name}, topic_key: {topic_key}")
            
            
            # Get comments as XML
            structured_comments = await self.get_comments_as_xml(conversation_data, self.filter_topics, filter_args)
            
            # Debug logging for topic 0
            if topic_cluster_id == 0 or str(topic_cluster_id) == "0":
                logger.info(f"DEBUG: Topic 0 filter_args: {filter_args}")
                logger.info(f"DEBUG: Topic 0 structured_comments length: {len(structured_comments) if structured_comments else 0}")
                logger.info(f"DEBUG: Topic 0 has content: {bool(structured_comments and structured_comments.strip())}")
            
            # Skip if no structured comments
            if not structured_comments.strip():
                logger.warning(f"No content after filter for topic {topic_name} (cluster_id={topic_cluster_id})")
                continue
            
            # Select appropriate template based on section type
            if is_global_section:
                # Map global section names to template files
                template_mapping = {
                    "groups": "groups.xml",
                    "group_informed_consensus": "group_informed_consensus.xml", 
                    "uncertainty": "uncertainty.xml"
                }
                
                # Extract the base name from the section_name (works with both old and new formats)
                # Old format: "global_groups" -> "groups"
                # New format: "batch_report_xxx_global_groups" -> "groups"
                if section_name.endswith("_groups"):
                    base_name = "groups"
                elif section_name.endswith("_group_informed_consensus"):
                    base_name = "group_informed_consensus"
                elif section_name.endswith("_uncertainty"):
                    base_name = "uncertainty"
                else:
                    # Fallback: try the old logic for backwards compatibility
                    base_name = topic_name.replace("global_", "")
                    logger.warning(f"Could not determine base name from section_name '{section_name}', using fallback: '{base_name}'")
                
                template_filename = template_mapping.get(base_name, "topics.xml")
                template_path = self.prompt_base_path / f"subtaskPrompts/{template_filename}"
                
                logger.info(f"Using template {template_filename} for global section {section_name} (base_name: {base_name})")
            else:
                # Use topics template for layer-specific topics
                template_path = self.prompt_base_path / "subtaskPrompts/topics.xml"
                logger.info(f"Using topics.xml template for topic {topic_name}")
            
            if not template_path.exists():
                logger.error(f"Template file not found: {template_path}")
                continue
                
            with open(template_path, 'r') as f:
                template_content = f.read()
            
            # Insert structured comments into template
            try:
                template_dict = xmltodict.parse(template_content)
                
                # Find the data element and replace its content
                template_dict['polisAnalysisPrompt']['data'] = {"content": {"structured_comments": structured_comments}}
                
                # Add topic name to prompt
                if 'context' in template_dict['polisAnalysisPrompt']:
                    if isinstance(template_dict['polisAnalysisPrompt']['context'], dict):
                        template_dict['polisAnalysisPrompt']['context']['topic_name'] = topic_name
                
                # Convert back to XML
                prompt_xml = xmltodict.unparse(template_dict, pretty=True)
                
                # Add model prompt formatting
                model_prompt = f"""
                    {prompt_xml}

                    You MUST respond with a JSON object that follows this EXACT structure for topic analysis. 
                    IMPORTANT: Do NOT simply repeat the comments verbatim. Instead, analyze the underlying themes, values,
                    and perspectives reflected in the comments. Identify patterns in how different groups view the topic.

                    ```json
                    {{
                    "id": "topic_overview_and_consensus",
                    "title": "Overview of Topic and Consensus",
                    "paragraphs": [
                        {{
                        "id": "topic_overview",
                        "title": "Overview of Topic",
                        "sentences": [
                            {{
                            "clauses": [
                                {{
                                "text": "This topic reveals patterns of participant views on economic development, community identity, and resource priorities.",
                                "citations": [190, 191, 1142]
                                }},
                                {{
                                "text": "Analysis of what the comments reveal about underlying values and priorities in the community.",
                                "citations": [1245, 1256]
                                }}
                            ]
                            }}
                        ]
                        }},
                        {{
                        "id": "topic_by_groups",
                        "title": "Group Perspectives on Topic",
                        "sentences": [
                            {{
                            "clauses": [
                                {{
                                "text": "Comparison of how different groups approached this topic, with analysis of the values that drive their different perspectives.",
                                "citations": [190, 191]
                                }}
                            ]
                            }}
                        ]
                        }}
                    ]
                    }}
                    ```

                    Make sure the JSON is VALID, as defined at https://www.json.org/json-en.html:
                    - Begin with object '{{' and end with '}}'
                    - All keys MUST be enclosed in double quotes
                    - NO trailing commas should be included after the last element in any array or object
                    - Do NOT include any additional text outside of the JSON object
                    - Do not provide explanations, only the JSON
                    - Use the exact structure shown above with "id", "title", "paragraphs", etc.
                    - Include relevant citations to comment IDs in the data
                """
                
                # Add to batch requests
                batch_request = {
                    "system": system_lore,
                    "messages": [
                        {"role": "user", "content": model_prompt}
                    ],
                    "max_tokens": 4000,
                    "metadata": {
                        "topic_name": topic_name,
                        "topic_key": topic_key,
                        "cluster_id": topic_cluster_id,
                        "section_name": section_name,
                        "conversation_id": self.conversation_id
                    }
                }
                
                batch_requests.append(batch_request)
                
            except Exception as e:
                logger.error(f"Error preparing prompt for topic {topic_name}: {str(e)}")
                import traceback
                logger.error(traceback.format_exc())
                continue
        
        logger.info(f"Prepared {len(batch_requests)} batch requests")
        return batch_requests
    
    async def process_request(self, request):
        """Process a single topic report request."""
        try:
            # Extract metadata
            metadata = request.get('metadata', {})
            topic_name = metadata.get('topic_name', 'Unknown Topic')
            section_name = metadata.get('section_name', f"topic_{topic_name.lower().replace(' ', '_')}")

            logger.info(f"Processing request for topic: {topic_name}")

            # Create Anthropic provider
            anthropic_provider = get_model_provider("anthropic", self.model)

            # Get response from LLM
            response = await anthropic_provider.get_completion(
                system=request.get('system', ''),
                prompt=request.get('messages', [])[0].get('content', ''),
                max_tokens=request.get('max_tokens', 4000)
            )

            # Log response for debugging
            logger.info(f"Received response from LLM for topic {topic_name}")

            # Extract content from the response
            content = response.get('content', '{}')

            # Store the result in NarrativeReports table
            if self.report_id:
                self.report_storage.store_report(
                    report_id=self.report_id,
                    section=section_name,
                    model=self.model,
                    report_data=content,
                    job_id=self.job_id,
                    metadata={
                        'topic_name': topic_name,
                        'cluster_id': metadata.get('cluster_id')
                    }
                )
                logger.info(f"Stored report for section {section_name}")
            else:
                logger.warning(f"No report_id available, skipping storage for {section_name}")

            return {
                'topic_name': topic_name,
                'section_name': section_name,
                'response': response
            }
        except Exception as e:
            logger.error(f"Error processing request for topic {request.get('metadata', {}).get('topic_name', 'unknown')}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return None

    async def submit_batch(self):
        """Prepare and process a batch of topic report requests using Anthropic's Batch API."""
        logger.info("=== Starting batch submission process ===")

        # Prepare batch requests
        try:
            logger.info("Preparing batch requests for topics...")
            batch_requests = await self.prepare_batch_requests()

            if not batch_requests:
                logger.error("No batch requests to submit - prepare_batch_requests returned empty list")
                return None

            logger.info(f"Successfully prepared {len(batch_requests)} batch requests")
        except Exception as e:
            logger.error(f"Critical error during batch request preparation: {str(e)}")
            logger.error(traceback.format_exc())
            return None

        # Log job information
        logger.info(f"Processing batch of {len(batch_requests)} requests for conversation {self.conversation_id}")
        if self.job_id:
            logger.info(f"Job ID: {self.job_id}")
        if self.report_id:
            logger.info(f"Report ID: {self.report_id}")


        # Validate API key presence
        anthropic_api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not anthropic_api_key:
            logger.error("ERROR: ANTHROPIC_API_KEY environment variable is not set. Cannot submit batch.")
            if self.job_id:
                try:
                    job_table = self.dynamodb.Table('Delphi_JobQueue')
                    job_table.update_item(
                        Key={'job_id': self.job_id},
                        UpdateExpression="SET #s = :status, error_message = :error",
                        ExpressionAttributeNames={'#s': 'status'},
                        ExpressionAttributeValues={
                            ':status': 'FAILED',
                            ':error': 'Missing ANTHROPIC_API_KEY environment variable'
                        }
                    )
                    logger.info(f"Updated job {self.job_id} status to FAILED due to missing API key")
                except Exception as e:
                    logger.error(f"Failed to update job status: {str(e)}")
            return None

        # Main try block for API interaction
        try:
            # Import Anthropic SDK
            logger.info("Importing Anthropic SDK...")
            try:
                from anthropic import Anthropic, APIError, APIConnectionError, APIResponseValidationError, APIStatusError
                logger.info("Successfully imported Anthropic SDK")
            except ImportError as e:
                logger.error(f"Failed to import Anthropic SDK: {str(e)}")
                logger.error(f"System paths: {sys.path}")
                logger.error("Attempting to install Anthropic SDK...")
                try:
                    import subprocess
                    subprocess.check_call([sys.executable, "-m", "pip", "install", "anthropic"])
                    from anthropic import Anthropic, APIError, APIConnectionError, APIResponseValidationError, APIStatusError
                    logger.info("Successfully installed and imported Anthropic SDK")
                except Exception as e:
                    logger.error(f"Failed to install Anthropic SDK: {str(e)}")
                    logger.error(traceback.format_exc())
                    return None

            # Initialize Anthropic client
            logger.info("Initializing Anthropic client...")
            try:
                anthropic = Anthropic(api_key=anthropic_api_key)
                logger.info("Successfully initialized Anthropic client")
            except Exception as e:
                logger.error(f"Failed to initialize Anthropic client: {str(e)}")
                logger.error(traceback.format_exc())
                return None

            # Format requests for Anthropic Batch API
            logger.info("Formatting batch requests for Anthropic API...")
            formatted_batch_requests = []

            try:
                for i, request in enumerate(batch_requests):
                    # Extract metadata for custom_id
                    metadata = request.get('metadata', {})
                    section_name = metadata.get('section_name', 'unknown_section')

                    # Create a valid custom_id (only allow a-zA-Z0-9_-)
                    # For versioned section names, shorten the job_id portion to avoid long custom_ids
                    if self.job_id and self.job_id in section_name:
                        # Replace the full job_id with just the first 8 characters
                        short_job_id = self.job_id[:8]
                        shortened_section = section_name.replace(self.job_id, short_job_id)
                        custom_id = f"{self.conversation_id}_{shortened_section}"
                    else:
                        # Legacy format or no job_id in section name
                        custom_id = f"{self.conversation_id}_{section_name}"
                    
                    safe_custom_id = re.sub(r'[^a-zA-Z0-9_-]', '_', custom_id)
                    
                    # Debug logging to trace the custom_id construction
                    logger.info(f"Custom ID construction: conversation_id={self.conversation_id}, section_name='{section_name}', custom_id='{custom_id}', safe_custom_id='{safe_custom_id}'")

                    # Validate custom_id length (max 64 chars for Anthropic API)
                    if len(safe_custom_id) > 64:
                        safe_custom_id = safe_custom_id[:64]
                        logger.warning(f"Truncated custom_id to 64 chars: {safe_custom_id}")

                    # Make sure we have system and user messages
                    system_content = request.get('system', '')
                    if not system_content:
                        logger.warning(f"Empty system prompt for request {i}, using default")
                        system_content = "You are a helpful AI assistant analyzing survey data."

                    user_content = ''
                    if 'messages' in request and len(request.get('messages', [])) > 0:
                        user_content = request.get('messages', [])[0].get('content', '')

                    if not user_content:
                        logger.warning(f"Empty user prompt for request {i}, skipping")
                        continue

                    # Create a proper user message format following working example
                    user_message = {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": user_content
                            }
                        ]
                    }

                    # Format request for Anthropic Batch API following working example
                    formatted_request = {
                        "custom_id": safe_custom_id,
                        "params": {
                            "model": self.model,
                            "max_tokens": request.get('max_tokens', 4000),
                            "system": system_content,
                            "messages": [user_message]
                        }
                    }

                    formatted_batch_requests.append(formatted_request)

                logger.info(f"Successfully formatted {len(formatted_batch_requests)} batch requests")

                # Debug: log the first request structure (without full content)
                if formatted_batch_requests:
                    # CRITICAL BUG FIX: Must use deepcopy here! 
                    # Using shallow copy causes the debug truncation to modify the actual request sent to Anthropic
                    # This was causing the first batch item to fail with "Report data is not in the expected JSON format"
                    import copy
                    debug_request = copy.deepcopy(formatted_batch_requests[0])
                    if 'params' in debug_request:
                        # Truncate system content
                        if 'system' in debug_request['params'] and isinstance(debug_request['params']['system'], str) and len(debug_request['params']['system']) > 100:
                            debug_request['params']['system'] = debug_request['params']['system'][:100] + "... [content truncated for log]"

                        # Truncate message content
                        if 'messages' in debug_request['params']:
                            for msg in debug_request['params']['messages']:
                                if 'content' in msg and isinstance(msg['content'], list):
                                    for content_item in msg['content']:
                                        if 'text' in content_item and isinstance(content_item['text'], str) and len(content_item['text']) > 100:
                                            content_item['text'] = content_item['text'][:100] + "... [content truncated for log]"

                    logger.info(f"Sample batch request structure: {json.dumps(debug_request, indent=2)}")
                    logger.info(f"Using format that matches working example from other project")

            except Exception as e:
                logger.error(f"Error formatting batch requests: {str(e)}")
                logger.error(traceback.format_exc())
                return None

            if not formatted_batch_requests:
                logger.error("No valid formatted batch requests to submit")
                return None

            logger.info(f"Submitting {len(formatted_batch_requests)} requests to Anthropic Batch API")

            # Submit the batch to Anthropic with detailed error handling
            try:
                batch = anthropic.beta.messages.batches.create(requests=formatted_batch_requests)
                logger.info("Successfully submitted batch to Anthropic API")
                logger.info(f"Batch ID: {batch.id}")
                logger.info(f"Batch status: {batch.processing_status}")
                logger.info(f"FULL BATCH OBJECT: {batch}")
            except APIStatusError as e:
                logger.error(f"Anthropic API Status Error: {str(e)}")
                logger.error(f"Status: {e.status_code}")
                logger.error(f"Response: {e.response}")
                return None
            except APIConnectionError as e:
                logger.error(f"Anthropic API Connection Error: {str(e)}")
                return None
            except APIResponseValidationError as e:
                logger.error(f"Anthropic API Response Validation Error: {str(e)}")
                logger.error(f"Response: {e.response}")
                return None
            except APIError as e:
                logger.error(f"Anthropic API Error: {str(e)}")
                return None
            except Exception as e:
                logger.error(f"Unexpected error submitting batch to Anthropic API: {str(e)}")
                logger.error(traceback.format_exc())
                return None

            # Store batch information in DynamoDB if we have a job ID
            if self.job_id:
                logger.info(f"Updating job {self.job_id} with batch information in DynamoDB...")
                try:
                    job_table = self.dynamodb.Table('Delphi_JobQueue') 

                    # Check if the table exists
                    try:
                        job_table.table_status
                        logger.info("Successfully connected to Delphi_JobQueue table")
                    except Exception as e:
                        logger.error(f"Failed to connect to Delphi_JobQueue table: {str(e)}")
                        logger.error("Available tables:")
                        try:
                            tables = list(dynamodb.tables.all())
                            for table in tables:
                                logger.info(f"- {table.name}")
                        except Exception as e:
                            logger.error(f"Failed to list tables: {str(e)}")
                        return batch.id  # Still return batch ID even if we can't update DynamoDB

                    # Simplify the update - just focus on getting batch_id stored
                    batch_id_str = str(batch.id)  # Convert to string to ensure compatibility
                    logger.info(f"Attempting to store batch_id as string: {batch_id_str}")

                    # Update the job with batch information - fixed version with ExpressionAttributeNames
                    update_response = job_table.update_item(
                        Key={'job_id': self.job_id},
                        UpdateExpression="SET batch_id = :batch_id, #s = :job_status, model = :model",
                        ExpressionAttributeNames={
                            '#s': 'status'  # Use ExpressionAttributeNames to avoid 'status' reserved keyword
                        },
                        ExpressionAttributeValues={
                            ':batch_id': batch_id_str,
                            ':job_status': 'PROCESSING',  # Set job status to PROCESSING so poller knows to check batch status
                            ':model': self.model  # Store the model name
                        },
                        ReturnValues="UPDATED_NEW"
                    )

                    # Verify update took effect
                    verify_job = job_table.get_item(Key={'job_id': self.job_id})
                    if 'Item' in verify_job:
                        job_item = verify_job['Item']
                        if 'batch_id' in job_item:
                            logger.info(f"VERIFICATION SUCCESS: batch_id found in job record: {job_item['batch_id']}")
                        else:
                            logger.error(f"VERIFICATION FAILED: batch_id not found in job record!")
                            logger.error(f"Job fields: {list(job_item.keys())}")
                    else:
                        logger.error(f"Could not verify update - job not found!")

                    logger.info(f"Successfully updated job {self.job_id} with batch information")
                    logger.info(f"Batch ID: {batch.id} stored in job record")
                    logger.info(f"DynamoDB update response: {update_response}")
                    logger.info(f"Job is now in PROCESSING state - poller will run batch status checks")

                    # Schedule a batch status check job to run in 60 seconds
                    try:
                        # Create a new job for checking batch status
                        status_check_job_id = f"batch_check_{self.job_id}_{int(time.time())}"

                        # Current timestamp
                        now = datetime.now().isoformat()

                        # Create the status check job with the new job type
                        status_job = {
                            'job_id': status_check_job_id,
                            'status': 'PENDING',
                            'job_type': 'AWAITING_NARRATIVE_BATCH',  # New job type for clearer state machine
                            'batch_job_id': self.job_id,
                            'batch_id': batch.id,
                            'conversation_id': self.conversation_id,
                            'report_id': self.report_id,
                            'created_at': now,
                            'updated_at': now,
                            'priority': 50,  # Medium priority
                            'version': 1,
                            'logs': json.dumps({'entries': []})
                        }

                        # Put the job in the queue
                        job_table.put_item(Item=status_job)

                        logger.info(f"Scheduled batch status check job {status_check_job_id} to run in 60 seconds")
                    except Exception as e:
                        logger.error(f"Failed to schedule batch status check job: {str(e)}")
                        logger.error(traceback.format_exc())
                        # Continue despite failure
                        logger.info("Continuing despite failure to schedule status check job")

                except Exception as e:
                    logger.error(f"Failed to update job with batch information: {str(e)}")
                    logger.error(traceback.format_exc())
                    # Continue despite DynamoDB update failure
                    logger.info("Continuing despite DynamoDB update failure")

            logger.info("=== Batch submission completed successfully ===")
            return batch.id

        except Exception as e:
            logger.error(f"Unhandled error in submit_batch: {str(e)}")
            logger.error(traceback.format_exc())

            # Try to update job status in DynamoDB
            if self.job_id:
                try:
                    job_table = self.dynamodb.Table('Delphi_JobQueue')
                    job_table.update_item(
                        Key={'job_id': self.job_id},
                        UpdateExpression="SET #s = :status, error_message = :error",
                        ExpressionAttributeNames={'#s': 'status'},
                        ExpressionAttributeValues={
                            ':status': 'FAILED',
                            ':error': f"Error in batch submission: {str(e)}"
                        }
                    )
                    logger.info(f"Updated job {self.job_id} status to FAILED due to error")
                except Exception as update_error:
                    logger.error(f"Failed to update job status after error: {str(update_error)}")

            return None

async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Generate narrative reports for Polis conversations')
    parser.add_argument('--conversation_id', '--zid', type=str, required=True,
                        help='Conversation ID to process')
    parser.add_argument('--model', type=str, default=None,
                        help='LLM model to use (defaults to ANTHROPIC_MODEL env var)')
    parser.add_argument('--no-cache', action='store_true',
                        help='Ignore cached report data')
    parser.add_argument('--max-batch-size', type=int, default=5,
                        help='Maximum number of topics to include in a single batch (default: 5)')
    parser.add_argument('--layers', type=int, nargs='+', default=None,
                        help='Specific layer numbers to process (e.g., --layers 0 1 2). If not specified, all layers will be processed.')
    parser.add_argument('--include_moderation', type=bool, default=False, help='Whether or not to include moderated comments in reports. If false, moderated comments will appear.')
    args = parser.parse_args()

    # Get environment variables for job
    job_id = os.environ.get('DELPHI_JOB_ID')
    report_id = os.environ.get('DELPHI_REPORT_ID')

    # Set up environment variables for database connections
    os.environ.setdefault('DATABASE_HOST', 'host.docker.internal')
    os.environ.setdefault('DATABASE_PORT', '5432')
    os.environ.setdefault('DATABASE_NAME', 'polisDB_prod_local_mar14')
    os.environ.setdefault('DATABASE_USER', 'postgres')
    os.environ.setdefault('DATABASE_PASSWORD', '')

    # Print database connection info
    logger.info(f"Database connection info:")
    logger.info(f"- HOST: {os.environ.get('DATABASE_HOST')}")
    logger.info(f"- PORT: {os.environ.get('DATABASE_PORT')}")
    logger.info(f"- DATABASE: {os.environ.get('DATABASE_NAME')}")
    logger.info(f"- USER: {os.environ.get('DATABASE_USER')}")

    # Print execution summary
    logger.info(f"Running narrative report generator with the following settings:")
    logger.info(f"- Conversation ID: {args.conversation_id}")
    logger.info(f"- Model: {args.model}")
    logger.info(f"- Cache: {'disabled' if args.no_cache else 'enabled'}")
    logger.info(f"- Max batch size: {args.max_batch_size}")
    if args.layers:
        logger.info(f"- Layers to process: {args.layers}")
    else:
        logger.info(f"- Layers to process: all available layers")
    if job_id:
        logger.info(f"- Job ID: {job_id}")
    if report_id:
        logger.info(f"- Report ID: {report_id}")

    # Create batch report generator
    generator = BatchReportGenerator(
        conversation_id=args.conversation_id,
        model=args.model,
        no_cache=args.no_cache,
        max_batch_size=args.max_batch_size,
        job_id=job_id,
        layers=args.layers,
        include_moderation=args.include_moderation
    )

    # Process reports
    result = await generator.submit_batch()

    if result:
        logger.info(f"Narrative reports generated successfully")
        print(f"Narrative reports generated successfully")
        if job_id:
            print(f"Job ID: {job_id}")
        if report_id:
            print(f"Reports stored for report_id: {report_id}")
    else:
        logger.error(f"Failed to generate narrative reports")
        print(f"Failed to generate narrative reports. See logs for details.")
        # Exit with error code
        sys.exit(1)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())