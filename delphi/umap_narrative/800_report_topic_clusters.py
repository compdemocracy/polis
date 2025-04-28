#!/usr/bin/env python3
"""
Generate reports for Polis conversations using LLM analysis of clusters and topics.

This script:
1. Connects to PostgreSQL for conversation and comment data
2. Connects to DynamoDB for cluster data and to store reports
3. Uses Gemma3:8b (via Ollama) to generate reports
4. Supports multiple report sections similar to the Polis report system

Usage:
    python 800_report_topic_clusters.py --conversation_id CONVERSATION_ID [--model MODEL] [--no-cache]

Args:
    --conversation_id: Conversation ID/zid
    --model: LLM model to use (default: gemma)
    --no-cache: Ignore cached report data
"""

import os
import sys
import json
import time
import logging
import argparse
import boto3
import numpy as np
import pandas as pd
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Union, Tuple
import xml.etree.ElementTree as ET
from xml.dom.minidom import parseString
import csv
import io
import xmltodict
from collections import defaultdict

# Import the model provider
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from umap_narrative.llm_factory_constructor import get_model_provider

# Import from local modules
from polismath_commentgraph.utils.storage import PostgresClient, DynamoDBStorage
from polismath_commentgraph.utils.group_data import GroupDataProcessor

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ReportStorageService:
    """Storage service for report data in DynamoDB."""
    
    def __init__(self, table_name="Delphi_NarrativeReports", disable_cache=False):
        """Initialize the report storage service.
        
        Args:
            table_name: Name of the DynamoDB table to use
            disable_cache: Whether to disable cache usage
        """
        # Set up DynamoDB connection
        self.table_name = table_name
        self.disable_cache = disable_cache
        
        # Set up DynamoDB client
        self.dynamodb = boto3.resource(
            'dynamodb',
            endpoint_url=os.environ.get('DYNAMODB_ENDPOINT'),
            region_name=os.environ.get('AWS_DEFAULT_REGION', 'us-west-2'),
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', 'fakeMyKeyId'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', 'fakeSecretAccessKey')
        )
        
        # Get the table
        self.table = self.dynamodb.Table(self.table_name)
    
    def init_table(self):
        """Check if the table exists, and create it if it doesn't."""
        try:
            self.table.table_status
            logger.info(f"Table {self.table_name} exists and is accessible.")
        except Exception as e:
            logger.error(f"Error checking table {self.table_name}: {str(e)}")
            logger.info(f"Creating table {self.table_name}...")
            
            # Create the table
            self.dynamodb.create_table(
                TableName=self.table_name,
                KeySchema=[
                    {'AttributeName': 'rid_section_model', 'KeyType': 'HASH'},
                    {'AttributeName': 'timestamp', 'KeyType': 'RANGE'}
                ],
                AttributeDefinitions=[
                    {'AttributeName': 'rid_section_model', 'AttributeType': 'S'},
                    {'AttributeName': 'timestamp', 'AttributeType': 'S'}
                ],
                ProvisionedThroughput={
                    'ReadCapacityUnits': 5,
                    'WriteCapacityUnits': 5
                }
            )
            
            # Wait for the table to be created
            waiter = boto3.client('dynamodb').get_waiter('table_exists')
            waiter.wait(TableName=self.table_name)
            
            logger.info(f"Table {self.table_name} created successfully.")
    
    def put_item(self, item):
        """Store an item in DynamoDB.
        
        Args:
            item: Dictionary with the item data
        """
        try:
            response = self.table.put_item(Item=item)
            logger.info(f"Item stored successfully: {response}")
            return response
        except Exception as e:
            logger.error(f"Error storing item: {str(e)}")
            return None
    
    def query_by_rid_section_model(self, rid_section_model):
        """Query items by rid_section_model.
        
        Args:
            rid_section_model: The rid_section_model key to query
            
        Returns:
            List of items matching the query
        """
        if self.disable_cache:
            return []
        
        try:
            response = self.table.query(
                KeyConditionExpression=boto3.dynamodb.conditions.Key('rid_section_model').eq(rid_section_model)
            )
            return response.get('Items', [])
        except Exception as e:
            logger.error(f"Error querying items: {str(e)}")
            return []
    
    def get_all_by_report_id(self, report_id_prefix):
        """Get all items for a report by ID prefix.
        
        Args:
            report_id_prefix: Prefix of the report ID (usually the conversation ID)
            
        Returns:
            List of items matching the prefix
        """
        if not report_id_prefix:
            logger.error("report_id_prefix cannot be empty")
            return []
        
        try:
            response = self.table.scan(
                FilterExpression=boto3.dynamodb.conditions.Attr('rid_section_model').begins_with(report_id_prefix)
            )
            items = response.get('Items', [])
            
            # Handle pagination
            while 'LastEvaluatedKey' in response:
                response = self.table.scan(
                    FilterExpression=boto3.dynamodb.conditions.Attr('rid_section_model').begins_with(report_id_prefix),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                items.extend(response.get('Items', []))
            
            logger.info(f"Found {len(items)} items with report ID prefix: {report_id_prefix}")
            return items
        except Exception as e:
            logger.error(f"Error scanning for items: {str(e)}")
            return []
    
    def delete_all_by_report_id(self, report_id_prefix):
        """Delete all items for a report by ID prefix.
        
        Args:
            report_id_prefix: Prefix of the report ID (usually the conversation ID)
        """
        if not report_id_prefix:
            logger.error("report_id_prefix cannot be empty")
            return
        
        try:
            items = self.get_all_by_report_id(report_id_prefix)
            
            for item in items:
                self.table.delete_item(
                    Key={
                        'rid_section_model': item['rid_section_model'],
                        'timestamp': item['timestamp']
                    }
                )
                logger.info(f"Deleted item: {item['rid_section_model']}")
            
            logger.info(f"Deleted {len(items)} items for report ID: {report_id_prefix}")
        except Exception as e:
            logger.error(f"Error deleting items: {str(e)}")

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

class ReportGenerator:
    """Generate reports for Polis conversations."""
    
    def __init__(self, conversation_id, model="gemma", no_cache=False, cluster_id=None):
        """Initialize the report generator.
        
        Args:
            conversation_id: ID of the conversation to generate reports for
            model: Name of the LLM model to use
            no_cache: Whether to ignore cached report data
            cluster_id: Optional specific cluster ID to process
        """
        self.conversation_id = str(conversation_id)
        self.model = model
        self.no_cache = no_cache
        self.cluster_id = cluster_id
        
        # Initialize PostgreSQL client
        self.postgres_client = PostgresClient()
        
        # Initialize DynamoDB storage
        self.storage = ReportStorageService(disable_cache=no_cache)
        self.storage.init_table()
        
        # Initialize group data processor
        self.group_processor = GroupDataProcessor(self.postgres_client)
        
        # Set up base path for prompt templates
        # Get the current script's directory and use it as base for prompt templates
        current_dir = Path(__file__).parent
        self.prompt_base_path = current_dir / "report_experimental"
        
        # Set up sections with their templates and filters
        self.sections = {
            "group_informed_consensus": {
                "template_path": "subtaskPrompts/group_informed_consensus.xml",
                "filter": self.filter_group_informed_consensus
            },
            "uncertainty": {
                "template_path": "subtaskPrompts/uncertainty.xml",
                "filter": self.filter_uncertainty
            },
            "groups": {
                "template_path": "subtaskPrompts/groups.xml",
                "filter": self.filter_groups
            },
            # Topics are handled differently
        }
    
    def get_gac_threshold_by_group_count(self, num_groups):
        """Get group-aware consensus threshold based on number of groups."""
        thresholds = {
            2: 0.7,
            3: 0.47,
            4: 0.32,
            5: 0.24,
        }
        return thresholds.get(num_groups, 0.24)
    
    def filter_group_informed_consensus(self, comment):
        """Filter for group-informed consensus comments."""
        group_aware_consensus = comment.get('group_aware_consensus', 0)
        num_groups = comment.get('num_groups', 0)
        threshold = self.get_gac_threshold_by_group_count(num_groups)
        return group_aware_consensus > threshold
    
    def filter_uncertainty(self, comment):
        """Filter for comments with high uncertainty (pass rate)."""
        passes = comment.get('passes', 0)
        votes = comment.get('votes', 0)
        if votes == 0:
            return False
        return (passes / votes) >= 0.2
    
    def filter_groups(self, comment):
        """Filter for comments that show group differences."""
        comment_extremity = comment.get('comment_extremity', 0)
        return comment_extremity > 1
    
    def filter_topics(self, comment, topic_citations=None, sample_comments=None):
        """Filter for comments that are part of a specific topic."""
        # Check if this comment ID is in our topic citations
        if topic_citations and comment.get('comment_id') in topic_citations:
            return True
            
        # If we have sample comments and not enough filtered comments,
        # try to match based on text similarity
        if sample_comments and len(sample_comments) > 0:
            comment_text = comment.get('comment', '')
            if comment_text:
                # Check if this comment text matches any sample comment
                for sample in sample_comments:
                    # Simple text matching - if the comment contains significant words from the sample
                    sample_words = set(w.lower() for w in sample.split() if len(w) > 3)
                    comment_words = set(w.lower() for w in comment_text.split() if len(w) > 3)
                    common_words = sample_words.intersection(comment_words)
                    
                    # If there's significant overlap, consider it a match
                    if len(common_words) >= min(2, len(sample_words)):
                        return True
        
        return False
        
    async def handle_section_with_wrapper(self, section_name, section):
        """Handle a section that needs a standard wrapper around its output.
        Used for sections like 'groups' that often have JSON format issues.
        
        Args:
            section_name: Name of the section
            section: Section configuration with template and filter
            
        Returns:
            Results with properly formatted JSON
        """
        # Check for cached response
        rid_section_model = f"{self.conversation_id}#{section_name}#{self.model}"
        cached_response = self.storage.query_by_rid_section_model(rid_section_model)
        
        # Get comments for this section using the section's filter
        structured_comments = await self.get_comments_as_xml(section['filter'])
        
        # If we have a cached response, return it
        if cached_response and not self.no_cache:
            logger.info(f"Using cached response for {section_name}")
            return {
                section_name: {
                    "modelResponse": cached_response[0].get('report_data', '{}'),
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
                }
            }
        
        # If no structured comments, return early with error
        if not structured_comments.strip():
            logger.warning(f"No content after filter for {section_name}")
            return {
                section_name: {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "No Content After Filter",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "No Content After Filter",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"No content matched the criteria for the '{section_name}' section.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER"
                }
            }
        
        # Read template file
        template_path = self.prompt_base_path / section['template_path']
        if not template_path.exists():
            logger.error(f"Template file not found: {template_path}")
            return {
                section_name: {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "Template Not Found",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Template Not Found",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"The template file for section '{section_name}' was not found.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": "TEMPLATE_NOT_FOUND"
                }
            }
        
        try:
            with open(template_path, 'r') as f:
                template_content = f.read()
            
            # Read system lore
            system_path = self.prompt_base_path / 'system.xml'
            if not system_path.exists():
                logger.error(f"System file not found: {system_path}")
                return {
                    section_name: {
                        "modelResponse": json.dumps({
                            "id": "polis_narrative_error_message",
                            "title": "System File Not Found",
                            "paragraphs": [
                                {
                                    "id": "polis_narrative_error_message",
                                    "title": "System File Not Found",
                                    "sentences": [
                                        {
                                            "clauses": [
                                                {
                                                    "text": "The system file was not found.",
                                                    "citations": []
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }),
                        "model": self.model,
                        "errors": "SYSTEM_FILE_NOT_FOUND"
                    }
                }
            
            with open(system_path, 'r') as f:
                system_lore = f.read()
            
            # Insert structured comments into template
            template_dict = xmltodict.parse(template_content)
            
            # Find the data element and replace its content
            template_dict['polisAnalysisPrompt']['data'] = {"content": {"structured_comments": structured_comments}}
            
            # Convert back to XML
            prompt_xml = xmltodict.unparse(template_dict, pretty=True)
            
            # Get model response
            resp = self.get_model_response(system_lore, prompt_xml)
            
            # For groups section, add a standard wrapper if needed
            try:
                # Try to parse the response
                parsed = json.loads(resp)
                
                # Check if we need to wrap it in a standard format
                if section_name == 'groups' and 'group_differences' not in parsed:
                    # We need to wrap it in a standard format
                    if 'paragraphs' in parsed:
                        # If it has paragraphs as a top level, wrap in group_differences
                        resp = json.dumps({
                            "group_differences": parsed
                        })
                    else:
                        # Just wrap whatever we have
                        resp = json.dumps({
                            "group_differences": {
                                "paragraphs": parsed.get('paragraphs', parsed)
                            }
                        })
                    logger.info(f"Added standard wrapper to {section_name} response")
            except json.JSONDecodeError:
                # If it can't be parsed, we'll use it as is
                logger.error(f"Could not parse {section_name} response for adding wrapper")
            
            # Store response in DynamoDB
            report_item = {
                "rid_section_model": rid_section_model,
                "timestamp": datetime.now().isoformat(),
                "report_data": resp,
                "model": self.model,
                "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
            }
            
            self.storage.put_item(report_item)
            
            return {
                section_name: {
                    "modelResponse": resp,
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
                }
            }
        
        except Exception as e:
            logger.error(f"Error handling section {section_name}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            
            return {
                section_name: {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "Error Processing Section",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Error Processing Section",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"There was an error processing the '{section_name}' section: {str(e)}",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": f"ERROR: {str(e)}"
                }
            }
    
    async def get_conversation_data(self):
        """Get conversation data from PostgreSQL."""
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
            
            # Get processed group and vote data using the group processor
            export_data = self.group_processor.get_export_data(int(self.conversation_id))
            logger.info(f"Retrieved processed vote and group data for conversation {self.conversation_id}")
            
            # Get math data with group assignments
            math_data = export_data.get('math_result', {})
            if math_data and math_data.get('group_assignments'):
                logger.info(f"Retrieved math data with {len(math_data.get('group_assignments', {}))} group assignments")
            else:
                logger.warning(f"No group assignments found in math data")
            
            # Use the processed comments from the export data
            processed_comments = export_data.get('comments', [])
            
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
    
    # Old processing method has been replaced by the GroupDataProcessor
    # which handles all the comment and vote processing
    
    async def get_comments_as_xml(self, filter_func=None, filter_args=None):
        """Get comments as XML, optionally filtered."""
        try:
            # Get conversation data
            data = await self.get_conversation_data()
            
            if not data:
                logger.error("Failed to get conversation data.")
                return ""
            
            # Apply filter if provided
            filtered_comments = data["processed_comments"]
            
            # Debug log to see what we're working with
            if len(filtered_comments) > 0:
                logger.info(f"Sample processed comment format: {filtered_comments[0]}")
            
            if filter_func:
                if filter_args:
                    filtered_comments = [c for c in filtered_comments if filter_func(c, **filter_args)]
                else:
                    filtered_comments = [c for c in filtered_comments if filter_func(c)]
            
            # Debug log filtered comments
            logger.info(f"Filtered comment count: {len(filtered_comments)}")
            if len(filtered_comments) > 0:
                logger.info(f"First filtered comment: {filtered_comments[0]}")
            
            # Convert to XML
            xml = PolisConverter.convert_to_xml(filtered_comments)
            
            if not xml.strip():
                logger.error("No data returned after conversion to XML")
            else:
                # Debug log to see XML format (truncated)
                xml_preview = xml[:500] + "..." if len(xml) > 500 else xml
                logger.info(f"XML preview: {xml_preview}")
            
            return xml
        except Exception as e:
            logger.error(f"Error in get_comments_as_xml: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return ""
    
    def get_model_response(self, system_lore, prompt_xml, model_version=None, is_topic=False):
        """Get response from the LLM model."""
        try:
            # Check if prompt is too large for topics
            if is_topic and len(prompt_xml) > 40000:  # Conservative estimate
                return json.dumps({
                    "id": "polis_narrative_error_message",
                    "title": "Too many comments",
                    "paragraphs": [
                        {
                            "id": "polis_narrative_error_message",
                            "title": "Too many comments",
                            "sentences": [
                                {
                                    "clauses": [
                                        {
                                            "text": "There are currently too many comments in this conversation for our AI to generate a topic response",
                                            "citations": []
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                })
            
            # Prepare the model prompt
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
            
            # Use Claude 3.5 Sonnet for high quality report generation
            model_name = model_version or os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")
            
            # Log which model we're using
            logger.info(f"Using Claude model: {model_name}")
            
            try:
                # Get the model provider for Claude
                provider = get_model_provider("anthropic", model_name)
                logger.info(f"Successfully initialized Anthropic provider")
                
                # Generate report with Claude
                response_text = provider.get_response(system_lore, model_prompt)
                result = response_text.strip()
                
                # Log success
                logger.info(f"Successfully generated report with Claude ({len(result)} characters)")
                
            except Exception as e:
                logger.error(f"Error using Claude: {e}")
                import traceback
                logger.error(traceback.format_exc())
                
                # Return a meaningful error message
                error_msg = f"Failed to generate report with Claude: {str(e)}"
                logger.error(error_msg)
                
                # Return an error JSON
                result = json.dumps({
                    "id": "polis_narrative_error_message",
                    "title": "Error Generating Report",
                    "paragraphs": [
                        {
                            "id": "polis_narrative_error_message",
                            "title": "Model Access Error",
                            "sentences": [
                                {
                                    "clauses": [
                                        {
                                            "text": error_msg,
                                            "citations": []
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                })
                
                # We still want to continue, so we don't re-raise the exception
            
            # Ensure it starts with a valid JSON object
            if not result.startswith('{'):
                result = '{' + result.split('{', 1)[1]
            
            # Extract JSON from the response
            # Look for JSON object pattern in the content
            if '```json' in result:
                # Extract JSON from code block
                json_text = result.split('```json', 1)[1].split('```', 1)[0].strip()
                result = json_text
            
            # If we still have trailing backticks or text, remove them
            if result.endswith('```'):
                result = result[:result.rfind('```')].strip()
                
            # Ensure it starts and ends with curly braces, removing any trailing text
            if '{' in result and '}' in result:
                start_idx = result.find('{')
                end_idx = result.rfind('}') + 1 
                result = result[start_idx:end_idx]
            
            # Validate JSON
            try:
                json.loads(result)
            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON response: {e}")
                logger.error(f"Attempting to fix JSON...")
                logger.error(f"Original JSON: {result}")
                
                # More advanced JSON fixing
                # Remove trailing commas in objects
                result = result.replace(',\n}', '\n}').replace(',\n]', '\n]')
                result = result.replace(',}', '}').replace(',]', ']')
                
                # Add missing closing braces/brackets
                open_braces = result.count('{')
                close_braces = result.count('}')
                open_brackets = result.count('[')
                close_brackets = result.count(']')
                
                # Add missing closing braces
                if open_braces > close_braces:
                    for _ in range(open_braces - close_braces):
                        result += '}'
                        
                # Add missing closing brackets
                if open_brackets > close_brackets:
                    for _ in range(open_brackets - close_brackets):
                        result += ']'
                
                # Ensure property names are quoted
                import re
                # Find unquoted keys (word before colon)
                unquoted_props = re.findall(r'(\s*)(\w+)(\s*):(\s*)', result)
                for match in unquoted_props:
                    spacing, key, pre_colon, post_colon = match
                    quoted_form = f'{spacing}"{key}"{pre_colon}:{post_colon}'
                    result = result.replace(f'{spacing}{key}{pre_colon}:{post_colon}', quoted_form)
                
                # Check for trailing text after JSON
                if '{' in result and '}' in result:
                    start_idx = result.find('{')
                    end_idx = result.rfind('}') + 1
                    if end_idx < len(result):
                        logger.info(f"Trimming trailing content after JSON: {result[end_idx:]}")
                        result = result[start_idx:end_idx]
                
                # Fix issues with missing commas between properties
                # Look for pattern of } followed by " (missing comma)
                result = re.sub(r'}\s*"', '}, "', result)
                # Look for pattern of ] followed by " (missing comma)
                result = re.sub(r']\s*"', '], "', result)
                
                # Special case for groups section which often has just 'paragraphs' without a top-level object
                if result.strip().startswith('"paragraphs"') or result.strip().startswith('{\n"paragraphs"'):
                    result = '{' + result + '}'
                elif result.strip().startswith('paragraphs') or result.strip().startswith('{\nparagraphs'):
                    result = '{"paragraphs"' + result[9:] + '}'
                elif result.strip().startswith('"id"') or result.strip().startswith('{\n"id"'):
                    # For topic responses without a top-level object
                    result = '{' + result + '}'
                
                # Try parsing again
                try:
                    json.loads(result)
                    logger.info("Successfully fixed JSON")
                except json.JSONDecodeError as e:
                    logger.error(f"Could not fix JSON: {e}")
                    # Provide a simpler, valid JSON as the fallback
                    return json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "Response Format Error",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Response Format Error",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": "There was an error generating the narrative due to response format issues.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    })
            
            return result
        
        except Exception as e:
            logger.error(f"Error in get_model_response: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            
            return json.dumps({
                "id": "polis_narrative_error_message",
                "title": "Narrative Error Message",
                "paragraphs": [
                    {
                        "id": "polis_narrative_error_message",
                        "title": "Narrative Error Message",
                        "sentences": [
                            {
                                "clauses": [
                                    {
                                        "text": "There was an error generating the narrative. Please refresh the page once all sections have been generated. It may also be a problem with this model, especially if your content discussed sensitive topics.",
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })
    
    async def get_topics(self):
        """Get topics for the conversation from DynamoDB."""
        # Get topics from ClusterTopics table
        dynamo_storage = DynamoDBStorage(
            endpoint_url=os.environ.get('DYNAMODB_ENDPOINT')
        )
        
        # Get topic data from DynamoDB
        topics = []
        
        try:
            # If a specific cluster ID is provided, focus only on that cluster
            if self.cluster_id is not None:
                logger.info(f"Processing specific cluster {self.cluster_id} for conversation {self.conversation_id}")
                
                # Get comment IDs for this specific cluster
                clusters_table = dynamo_storage.dynamodb.Table('Delphi_CommentHierarchicalClusterAssignments')
                response = clusters_table.scan(
                    FilterExpression=boto3.dynamodb.conditions.Attr('conversation_id').eq(self.conversation_id) &
                                     boto3.dynamodb.conditions.Attr('layer0_cluster_id').eq(int(self.cluster_id))
                )
                
                # Collect comment IDs
                comment_ids = []
                for item in response.get('Items', []):
                    comment_id = item.get('comment_id')
                    if comment_id:
                        comment_ids.append(int(comment_id))
                
                # Get cluster topic information from ClusterTopics
                cluster_table = dynamo_storage.dynamodb.Table('Delphi_CommentClustersStructureKeywords')
                cluster_key = f'layer0_{self.cluster_id}'
                cluster_response = cluster_table.query(
                    KeyConditionExpression=boto3.dynamodb.conditions.Key('conversation_id').eq(self.conversation_id) &
                                         boto3.dynamodb.conditions.Key('cluster_key').eq(cluster_key)
                )
                
                # Create topic entry
                cluster_items = cluster_response.get('Items', [])
                if cluster_items:
                    cluster_item = cluster_items[0]
                    topic_label = f"Cluster {self.cluster_id}"
                    
                    if 'topic_label' in cluster_item:
                        if isinstance(cluster_item['topic_label'], dict) and 'S' in cluster_item['topic_label']:
                            topic_label = cluster_item['topic_label']['S']
                        else:
                            topic_label = str(cluster_item['topic_label'])
                    
                    # Look up a more descriptive name in Delphi_CommentClustersLLMTopicNames if available
                    llm_table = dynamo_storage.dynamodb.Table('Delphi_CommentClustersLLMTopicNames')
                    logger.info(f"Looking for topic name for cluster {self.cluster_id} in layer 0")
                    
                    # Use scan instead of query with filter expression
                    llm_response = llm_table.scan(
                        FilterExpression=boto3.dynamodb.conditions.Attr('conversation_id').eq(self.conversation_id) &
                                         boto3.dynamodb.conditions.Attr('cluster_id').eq(int(self.cluster_id)) &
                                         boto3.dynamodb.conditions.Attr('layer_id').eq(0)
                    )
                    
                    llm_items = llm_response.get('Items', [])
                    logger.info(f"Found {len(llm_items)} LLMTopicNames entries for cluster {self.cluster_id}")
                    
                    if llm_items:
                        for item in llm_items:
                            logger.info(f"Topic name item: {item}")
                        
                        if 'topic_name' in llm_items[0]:
                            topic_label = llm_items[0]['topic_name']
                            logger.info(f"Using topic name from LLMTopicNames: {topic_label}")
                    
                    # Get sample comments
                    sample_comments = []
                    if 'sample_comments' in cluster_item:
                        if isinstance(cluster_item['sample_comments'], list):
                            sample_comments = cluster_item['sample_comments']
                        elif isinstance(cluster_item['sample_comments'], dict) and 'L' in cluster_item['sample_comments']:
                            for comment in cluster_item['sample_comments']['L']:
                                if 'S' in comment:
                                    sample_comments.append(comment['S'])
                        else:
                            logger.warning(f"Unexpected sample_comments format: {type(cluster_item['sample_comments'])}")
                    
                    # Create the topic structure
                    topic = {
                        "name": topic_label,
                        "citations": comment_ids,
                        "sample_comments": sample_comments
                    }
                    
                    # Log information about this topic
                    logger.info(f"Using specific cluster {self.cluster_id}: '{topic_label}' with {len(comment_ids)} comments")
                    if sample_comments:
                        for i, comment in enumerate(sample_comments[:2]):
                            short_comment = comment[:100] + '...' if len(comment) > 100 else comment
                            logger.info(f"Sample comment {i+1}: {short_comment}")
                    
                    return [topic]
                else:
                    logger.warning(f"No cluster information found for cluster ID {self.cluster_id}")
                    return []
            
            # Standard topic processing when no specific cluster ID is provided
            # Get all LLMTopicNames entries for layer 0
            table = dynamo_storage.dynamodb.Table('Delphi_CommentClustersLLMTopicNames')
            response = table.scan(
                FilterExpression=boto3.dynamodb.conditions.Attr('conversation_id').eq(self.conversation_id) &
                                 boto3.dynamodb.conditions.Attr('layer_id').eq(0)
            )
            
            topic_names_items = response.get('Items', [])
            logger.info(f"Found {len(topic_names_items)} layer 0 topic names in LLMTopicNames")
            
            # Get all comment clusters
            clusters_table = dynamo_storage.dynamodb.Table('Delphi_CommentHierarchicalClusterAssignments')
            response = clusters_table.scan(
                FilterExpression=boto3.dynamodb.conditions.Attr('conversation_id').eq(self.conversation_id)
            )
            
            clusters = response.get('Items', [])
            logger.info(f"Found {len(clusters)} comment cluster entries")
            
            # Process clusters to get comment IDs for each topic
            topic_comments = defaultdict(list)
            for item in clusters:
                # Look at layer0 clusters
                if 'layer0_cluster_id' in item:
                    cluster_id = item['layer0_cluster_id']
                    comment_id = item.get('comment_id')
                    if comment_id:
                        topic_comments[cluster_id].append(int(comment_id))
            
            logger.info(f"Collected comments for {len(topic_comments)} clusters")
            
            # Create topics data structure
            for topic_item in topic_names_items:
                cluster_id = topic_item.get('cluster_id')
                topic_name = topic_item.get('topic_name', f"Topic {cluster_id}")
                
                logger.info(f"Processing topic for cluster {cluster_id}: {topic_name}")
                
                if cluster_id is not None:
                    # Try to get sample comments for this topic
                    sample_comments = []
                    cluster_response = dynamo_storage.dynamodb.Table('Delphi_CommentClustersStructureKeywords').query(
                        KeyConditionExpression=boto3.dynamodb.conditions.Key('conversation_id').eq(self.conversation_id) &
                                             boto3.dynamodb.conditions.Key('cluster_key').eq(f'layer0_{cluster_id}')
                    )
                    
                    if cluster_response.get('Items'):
                        cluster_item = cluster_response.get('Items')[0]
                        if 'sample_comments' in cluster_item:
                            if isinstance(cluster_item['sample_comments'], list):
                                sample_comments = cluster_item['sample_comments']
                            elif isinstance(cluster_item['sample_comments'], dict) and 'L' in cluster_item['sample_comments']:
                                for comment in cluster_item['sample_comments']['L']:
                                    if 'S' in comment:
                                        sample_comments.append(comment['S'])
                    
                    # Create topic entry
                    topic = {
                        "name": topic_name,
                        "citations": topic_comments.get(cluster_id, []),
                        "sample_comments": sample_comments
                    }
                    topics.append(topic)
            
            logger.info(f"Created {len(topics)} topics for conversation {self.conversation_id}")
            
            # Sort topics by number of citations (descending)
            topics.sort(key=lambda x: len(x['citations']), reverse=True)
            
            # Limit to top 10 topics
            if len(topics) > 10:
                logger.info(f"Limiting from {len(topics)} to 10 topics")
                topics = topics[:10]
            
            return topics
        
        except Exception as e:
            logger.error(f"Error getting topics: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return []
    
    async def handle_section(self, section_name):
        """Handle a specific report section."""
        section = self.sections.get(section_name)
        if not section:
            logger.error(f"Unknown section: {section_name}")
            return {
                section_name: {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "Unknown Section",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Unknown Section",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"The section '{section_name}' is not recognized.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": "UNKNOWN_SECTION"
                }
            }
            
        # Special handling for groups section which often has JSON format issues
        special_section_handling = {
            'groups': self.handle_section_with_wrapper
        }
        
        # Use special handler if available
        if section_name in special_section_handling:
            return await special_section_handling[section_name](section_name, section)
            
        # Regular section handling
        
        # Check for cached response
        rid_section_model = f"{self.conversation_id}#{section_name}#{self.model}"
        cached_response = self.storage.query_by_rid_section_model(rid_section_model)
        
        # Get comments for this section using the section's filter
        structured_comments = await self.get_comments_as_xml(section['filter'])
        
        # If we have a cached response, return it
        if cached_response and not self.no_cache:
            logger.info(f"Using cached response for {section_name}")
            return {
                section_name: {
                    "modelResponse": cached_response[0].get('report_data', '{}'),
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
                }
            }
        
        # If no structured comments, return early with error
        if not structured_comments.strip():
            logger.warning(f"No content after filter for {section_name}")
            return {
                section_name: {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "No Content After Filter",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "No Content After Filter",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"No content matched the criteria for the '{section_name}' section.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER"
                }
            }
        
        # Read template file
        template_path = self.prompt_base_path / section['template_path']
        if not template_path.exists():
            logger.error(f"Template file not found: {template_path}")
            return {
                section_name: {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "Template Not Found",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Template Not Found",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"The template file for section '{section_name}' was not found.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": "TEMPLATE_NOT_FOUND"
                }
            }
        
        try:
            with open(template_path, 'r') as f:
                template_content = f.read()
            
            # Read system lore
            system_path = self.prompt_base_path / 'system.xml'
            if not system_path.exists():
                logger.error(f"System file not found: {system_path}")
                return {
                    section_name: {
                        "modelResponse": json.dumps({
                            "id": "polis_narrative_error_message",
                            "title": "System File Not Found",
                            "paragraphs": [
                                {
                                    "id": "polis_narrative_error_message",
                                    "title": "System File Not Found",
                                    "sentences": [
                                        {
                                            "clauses": [
                                                {
                                                    "text": "The system file was not found.",
                                                    "citations": []
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }),
                        "model": self.model,
                        "errors": "SYSTEM_FILE_NOT_FOUND"
                    }
                }
            
            with open(system_path, 'r') as f:
                system_lore = f.read()
            
            # Insert structured comments into template
            template_dict = xmltodict.parse(template_content)
            
            # Find the data element and replace its content
            template_dict['polisAnalysisPrompt']['data'] = {"content": {"structured_comments": structured_comments}}
            
            # Convert back to XML
            prompt_xml = xmltodict.unparse(template_dict, pretty=True)
            
            # Get model response
            resp = self.get_model_response(system_lore, prompt_xml)
            
            # Store response in DynamoDB
            report_item = {
                "rid_section_model": rid_section_model,
                "timestamp": datetime.now().isoformat(),
                "report_data": resp,
                "model": self.model,
                "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
            }
            
            self.storage.put_item(report_item)
            
            return {
                section_name: {
                    "modelResponse": resp,
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
                }
            }
        
        except Exception as e:
            logger.error(f"Error handling section {section_name}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            
            return {
                section_name: {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "Error Processing Section",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Error Processing Section",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"There was an error processing the '{section_name}' section: {str(e)}",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": f"ERROR: {str(e)}"
                }
            }
    
    async def handle_topics(self, limit_topics=3):
        """Handle the topics section.
        
        Args:
            limit_topics: Maximum number of topics to process (default: 3)
        """
        # Get topics
        topics = await self.get_topics()
        
        if not topics:
            logger.warning("No topics found")
            return {
                "topics": {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "No Topics Found",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "No Topics Found",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": "No topics were found for this conversation.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": "NO_TOPICS_FOUND"
                }
            }
            
        # Limit topics if requested
        if limit_topics and len(topics) > limit_topics:
            logger.info(f"Limiting topics from {len(topics)} to {limit_topics}")
            topics = topics[:limit_topics]
        
        # Store topics in DynamoDB
        topics_item = {
            "rid_section_model": f"{self.conversation_id}#topics",
            "timestamp": datetime.now().isoformat(),
            "model": self.model,
            "report_data": json.dumps(topics)
        }
        
        self.storage.put_item(topics_item)
        
        # Process each topic
        template_path = self.prompt_base_path / "subtaskPrompts/topics.xml"
        if not template_path.exists():
            logger.error(f"Template file not found: {template_path}")
            return {}
        
        with open(template_path, 'r') as f:
            template_content = f.read()
        
        # Read system lore
        system_path = self.prompt_base_path / 'system.xml'
        if not system_path.exists():
            logger.error(f"System file not found: {system_path}")
            return {}
        
        with open(system_path, 'r') as f:
            system_lore = f.read()
        
        # Process each topic
        results = {}
        
        for i, topic in enumerate(topics):
            topic_name = topic['name'].lower().replace(' ', '_')
            section_name = f"topic_{topic_name}"
            
            # Check for cached response
            rid_section_model = f"{self.conversation_id}#{section_name}#{self.model}"
            cached_response = self.storage.query_by_rid_section_model(rid_section_model)
            
            # Create filter for this topic
            # Include both citations and sample comments to increase our chances of finding related content
            filter_args = {
                'topic_citations': topic.get('citations', []),
                'sample_comments': topic.get('sample_comments', [])
            }
            structured_comments = await self.get_comments_as_xml(self.filter_topics, filter_args)
            
            # If we have a cached response, use it
            if cached_response and not self.no_cache:
                logger.info(f"Using cached response for {section_name}")
                results[section_name] = {
                    "modelResponse": cached_response[0].get('report_data', '{}'),
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
                }
                continue
            
            # If no structured comments, skip
            if not structured_comments.strip():
                logger.warning(f"No content after filter for {section_name}")
                results[section_name] = {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "No Content After Filter",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "No Content After Filter",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"No content matched the criteria for the '{section_name}' section.",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER"
                }
                continue
            
            try:
                # Insert structured comments into template
                template_dict = xmltodict.parse(template_content)
                
                # Find the data element and replace its content
                template_dict['polisAnalysisPrompt']['data'] = {"content": {"structured_comments": structured_comments}}
                
                # Add topic name to prompt
                if 'context' in template_dict['polisAnalysisPrompt']:
                    if isinstance(template_dict['polisAnalysisPrompt']['context'], dict):
                        template_dict['polisAnalysisPrompt']['context']['topic_name'] = topic['name']
                
                # Convert back to XML
                prompt_xml = xmltodict.unparse(template_dict, pretty=True)
                
                # Add delay to avoid rate limiting
                if i > 0:
                    time.sleep(1)
                
                # Log the topic size
                logger.info(f"Processing topic '{topic['name']}' with {len(topic['citations'])} comments")
                
                # Get model response
                resp = self.get_model_response(system_lore, prompt_xml, is_topic=True)
                
                # Store response in DynamoDB
                report_item = {
                    "rid_section_model": rid_section_model,
                    "timestamp": datetime.now().isoformat(),
                    "report_data": resp,
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
                }
                
                self.storage.put_item(report_item)
                
                results[section_name] = {
                    "modelResponse": resp,
                    "model": self.model,
                    "errors": "NO_CONTENT_AFTER_FILTER" if not structured_comments.strip() else None
                }
            
            except Exception as e:
                logger.error(f"Error handling topic {topic_name}: {str(e)}")
                import traceback
                logger.error(traceback.format_exc())
                
                results[section_name] = {
                    "modelResponse": json.dumps({
                        "id": "polis_narrative_error_message",
                        "title": "Error Processing Topic",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Error Processing Topic",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"There was an error processing the '{topic_name}' topic: {str(e)}",
                                                "citations": []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }),
                    "model": self.model,
                    "errors": f"ERROR: {str(e)}"
                }
        
        return results
    
    async def generate_report(self, topic_limit=3):
        """Generate the complete report for the conversation.
        
        Args:
            topic_limit: Maximum number of topics to process (default: 3)
        """
        # Check if cache should be deleted
        if self.no_cache:
            logger.info(f"Deleting cached report data for {self.conversation_id}")
            self.storage.delete_all_by_report_id(self.conversation_id)
        
        # Run all sections
        results = {}
        
        # Handle standard sections
        for section_name in self.sections:
            section_result = await self.handle_section(section_name)
            results.update(section_result)
        
        # Handle topics
        topic_results = await self.handle_topics(limit_topics=topic_limit)
        results.update(topic_results)
        
        return results

async def check_report_status(conversation_id, model, report_storage=None):
    """Check the status of existing reports for a conversation.
    
    Args:
        conversation_id: Conversation ID to check
        model: Model to check reports for
        report_storage: Optional ReportStorageService instance
        
    Returns:
        Dictionary mapping cluster_ids to report status
    """
    if report_storage is None:
        report_storage = ReportStorageService()
    
    # Get all reports for this conversation
    all_items = report_storage.get_all_by_report_id(conversation_id)
    
    # Filter for topic reports with the specified model
    topic_reports = {}
    
    for item in all_items:
        rid_section_model = item.get('rid_section_model', '')
        if not rid_section_model.startswith(f"{conversation_id}#topic_"):
            continue
            
        # Extract the model name
        parts = rid_section_model.split('#')
        if len(parts) != 3 or parts[2] != model:
            continue
            
        # Extract the topic/cluster name
        topic_part = parts[1].replace('topic_', '')
        
        # Try to extract JSON from the report data
        report_data = item.get('report_data', '{}')
        try:
            data = json.loads(report_data)
            
            # Check if this is an error response
            is_error = False
            if "title" in data and "paragraphs" in data:
                title = data.get("title", "")
                if "error" in title.lower() or "missing" in title.lower() or "too many" in title.lower():
                    is_error = True
                    
            # Store the status
            topic_reports[topic_part] = {
                "status": "error" if is_error else "valid",
                "timestamp": item.get('timestamp', ''),
                "error_title": data.get("title") if is_error else None
            }
            
        except json.JSONDecodeError:
            # Invalid JSON
            topic_reports[topic_part] = {
                "status": "invalid_json",
                "timestamp": item.get('timestamp', '')
            }
    
    return topic_reports

async def process_all_layer0_clusters(conversation_id, model, no_cache=False, only_errors=True):
    """Process all clusters in layer 0 for a specific conversation.
    
    Args:
        conversation_id: Conversation ID to process
        model: Model to use for generation
        no_cache: Whether to ignore cached results
        only_errors: Only regenerate reports that have errors or are missing
    """
    # Get all cluster IDs for layer 0
    dynamo_storage = DynamoDBStorage(
        endpoint_url=os.environ.get('DYNAMODB_ENDPOINT')
    )
    
    # Set up report storage
    report_storage = ReportStorageService(disable_cache=no_cache)
    
    # Check status of existing reports if only processing errors
    report_status = {}
    if only_errors:
        report_status = await check_report_status(conversation_id, model, report_storage)
        logger.info(f"Found {len(report_status)} existing topic reports")
        
        # Count report statuses
        valid_count = sum(1 for status in report_status.values() if status['status'] == 'valid')
        error_count = sum(1 for status in report_status.values() if status['status'] == 'error')
        logger.info(f"Valid reports: {valid_count}, Error reports: {error_count}")
    
    # Query Delphi_CommentClustersLLMTopicNames to get all layer 0 topics
    logger.info(f"Getting all layer 0 topics for conversation {conversation_id}")
    
    try:
        table = dynamo_storage.dynamodb.Table('Delphi_CommentClustersLLMTopicNames')
        response = table.scan(
            FilterExpression=boto3.dynamodb.conditions.Attr('conversation_id').eq(conversation_id) & 
                             boto3.dynamodb.conditions.Attr('layer_id').eq(0)
        )
        
        topics = response.get('Items', [])
        logger.info(f"Found {len(topics)} topics in layer 0")
        
        # Process each cluster
        processed_count = 0
        for topic in topics:
            cluster_id = topic.get('cluster_id')
            topic_name = topic.get('topic_name')
            
            if cluster_id is not None:
                # Check if we need to process this cluster
                topic_key = f"{topic_name.lower().replace(' ', '_')}"
                should_process = True
                
                if only_errors:
                    # Skip if report exists and is valid
                    if topic_key in report_status and report_status[topic_key]['status'] == 'valid':
                        logger.info(f"Skipping cluster {cluster_id}: '{topic_name}' - already has valid report")
                        should_process = False
                    else:
                        status = "missing" if topic_key not in report_status else report_status[topic_key]['status']
                        logger.info(f"Processing cluster {cluster_id}: '{topic_name}' - status: {status}")
                        
                if should_process:
                    # Create a report generator for this cluster
                    generator = ReportGenerator(
                        conversation_id=conversation_id,
                        model=model,
                        no_cache=no_cache,
                        cluster_id=cluster_id
                    )
                    
                    # Generate the topic report
                    topic_results = await generator.handle_topics(limit_topics=1)
                    
                    # Print the results for this topic
                    logger.info(f"Report for cluster {cluster_id} ({topic_name}) generated")
                    print(f"\n------- Cluster {cluster_id}: {topic_name} -------")
                    print(json.dumps(topic_results, indent=2))
                    
                    processed_count += 1
                    
                    # Add a delay to avoid rate limiting
                    await asyncio.sleep(1)
        
        logger.info(f"Processed {processed_count} of {len(topics)} topics in layer 0")
        return True
    
    except Exception as e:
        logger.error(f"Error processing all layer 0 clusters: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Generate reports for Polis conversations')
    parser.add_argument('--conversation_id', '--zid', type=str, required=True,
                        help='Conversation ID to process')
    parser.add_argument('--model', type=str, default='claude-3-5-sonnet-20241022',
                        help='LLM model to use (default: claude-3-5-sonnet-20241022)')
    parser.add_argument('--no-cache', action='store_true',
                        help='Ignore cached report data')
    parser.add_argument('--section', type=str, default=None,
                        help='Generate only a specific section (options: group_informed_consensus, uncertainty, groups, topics)')
    parser.add_argument('--topic-limit', type=int, default=3,
                        help='Limit number of topics to process (default: 3)')
    parser.add_argument('--cluster-id', type=str, default=None,
                        help='Process only a specific cluster ID (e.g., 109 for a specific layer 0 cluster)')
    parser.add_argument('--all-layer0', action='store_true',
                        help='Process all layer 0 clusters')
    parser.add_argument('--check-reports', action='store_true',
                        help='Check status of existing reports without generating new ones')
    parser.add_argument('--regenerate-all', action='store_true',
                        help='Regenerate reports for all clusters (not just error ones)')
    args = parser.parse_args()
    
    # Set up environment variables for database connections
    # Priority: POSTGRES_* variables over DATABASE_* variables over defaults
    
    # 1. For HOST
    if os.environ.get('POSTGRES_HOST'):
        os.environ['DATABASE_HOST'] = os.environ.get('POSTGRES_HOST')
    elif not os.environ.get('DATABASE_HOST'):
        os.environ['DATABASE_HOST'] = 'host.docker.internal'
        # Also set POSTGRES_HOST for consistency
        if not os.environ.get('POSTGRES_HOST'):
            os.environ['POSTGRES_HOST'] = 'host.docker.internal'
    
    # 2. For PORT
    if os.environ.get('POSTGRES_PORT'):
        os.environ['DATABASE_PORT'] = os.environ.get('POSTGRES_PORT')
    elif not os.environ.get('DATABASE_PORT'):
        os.environ['DATABASE_PORT'] = '5432'
        # Also set POSTGRES_PORT for consistency
        if not os.environ.get('POSTGRES_PORT'):
            os.environ['POSTGRES_PORT'] = '5432'
    
    # 3. For DATABASE NAME
    if os.environ.get('POSTGRES_DB'):
        os.environ['DATABASE_NAME'] = os.environ.get('POSTGRES_DB')
    elif not os.environ.get('DATABASE_NAME'):
        os.environ['DATABASE_NAME'] = 'polisDB_prod_local_mar14'
        # Also set POSTGRES_DB for consistency
        if not os.environ.get('POSTGRES_DB'):
            os.environ['POSTGRES_DB'] = 'polisDB_prod_local_mar14'
    
    # 4. For USER
    if os.environ.get('POSTGRES_USER'):
        os.environ['DATABASE_USER'] = os.environ.get('POSTGRES_USER')
    elif not os.environ.get('DATABASE_USER'):
        os.environ['DATABASE_USER'] = 'postgres'
        # Also set POSTGRES_USER for consistency
        if not os.environ.get('POSTGRES_USER'):
            os.environ['POSTGRES_USER'] = 'postgres'
    
    # 5. For PASSWORD
    if os.environ.get('POSTGRES_PASSWORD'):
        os.environ['DATABASE_PASSWORD'] = os.environ.get('POSTGRES_PASSWORD')
    elif not os.environ.get('DATABASE_PASSWORD'):
        os.environ['DATABASE_PASSWORD'] = ''
        # Also set POSTGRES_PASSWORD for consistency
        if not os.environ.get('POSTGRES_PASSWORD'):
            os.environ['POSTGRES_PASSWORD'] = ''
    
    # Ensure DATABASE_URL is set if not already - needed by some components
    if not os.environ.get('DATABASE_URL'):
        # Use POSTGRES_* variables if available, otherwise construct from DATABASE_* variables
        host = os.environ.get('POSTGRES_HOST') or os.environ.get('DATABASE_HOST')
        port = os.environ.get('POSTGRES_PORT') or os.environ.get('DATABASE_PORT')
        db = os.environ.get('POSTGRES_DB') or os.environ.get('DATABASE_NAME')
        user = os.environ.get('POSTGRES_USER') or os.environ.get('DATABASE_USER')
        password = os.environ.get('POSTGRES_PASSWORD') or os.environ.get('DATABASE_PASSWORD')
        
        # Construct DATABASE_URL
        if password:
            os.environ['DATABASE_URL'] = f"postgresql://{user}:{password}@{host}:{port}/{db}"
        else:
            os.environ['DATABASE_URL'] = f"postgresql://{user}@{host}:{port}/{db}"
    
    # Print database connection info
    logger.info(f"Database connection info:")
    logger.info(f"- HOST: {os.environ.get('POSTGRES_HOST') or os.environ.get('DATABASE_HOST')}")
    logger.info(f"- PORT: {os.environ.get('POSTGRES_PORT') or os.environ.get('DATABASE_PORT')}")
    logger.info(f"- DATABASE: {os.environ.get('POSTGRES_DB') or os.environ.get('DATABASE_NAME')}")
    logger.info(f"- USER: {os.environ.get('POSTGRES_USER') or os.environ.get('DATABASE_USER')}")
    # Print the DATABASE_URL with password masked
    db_url = os.environ.get('DATABASE_URL', '')
    if db_url:
        masked_url = db_url
        if os.environ.get('POSTGRES_PASSWORD') or os.environ.get('DATABASE_PASSWORD'):
            password = os.environ.get('POSTGRES_PASSWORD') or os.environ.get('DATABASE_PASSWORD')
            masked_url = db_url.replace(password, '******')
        logger.info(f"- DATABASE_URL: {masked_url}")
    
    # Print execution summary
    logger.info(f"Running report generator with the following settings:")
    logger.info(f"- Conversation ID: {args.conversation_id}")
    logger.info(f"- Model: {args.model}")
    logger.info(f"- Cache: {'disabled' if args.no_cache else 'enabled'}")
    
    # Special case for just checking report status
    if args.check_reports:
        logger.info(f"Checking report status for conversation {args.conversation_id}")
        report_status = await check_report_status(args.conversation_id, args.model)
        
        # Print report status summary
        print("\n===== Report Status Summary =====")
        valid_count = sum(1 for status in report_status.values() if status['status'] == 'valid')
        error_count = sum(1 for status in report_status.values() if status['status'] == 'error')
        invalid_count = sum(1 for status in report_status.values() if status['status'] == 'invalid_json')
        
        print(f"Total reports: {len(report_status)}")
        print(f"Valid reports: {valid_count}")
        print(f"Error reports: {error_count}")
        print(f"Invalid JSON: {invalid_count}")
        
        # Print details of error reports
        if error_count > 0:
            print("\n----- Error Reports -----")
            for topic, status in report_status.items():
                if status['status'] == 'error':
                    print(f"Topic: {topic}")
                    print(f"Error: {status.get('error_title', 'Unknown error')}")
                    print(f"Timestamp: {status['timestamp']}")
                    print("")
                    
        return
    
    # Special case for processing all layer 0 clusters
    if args.all_layer0:
        logger.info(f"Processing all layer 0 clusters for conversation {args.conversation_id}")
        await process_all_layer0_clusters(
            args.conversation_id, 
            args.model, 
            args.no_cache, 
            only_errors=not args.regenerate_all
        )
        return
    
    # Standard processing for a single section or cluster
    logger.info(f"- Section: {args.section or 'all sections'}")
    logger.info(f"- Topic limit: {args.topic_limit}")
    
    # Create report generator
    generator = ReportGenerator(
        conversation_id=args.conversation_id,
        model=args.model,
        no_cache=args.no_cache,
        cluster_id=args.cluster_id
    )
    
    # Generate report
    if args.section:
        # Generate only the requested section
        if args.section == "topics":
            results = await generator.handle_topics(limit_topics=args.topic_limit)
        else:
            results = await generator.handle_section(args.section)
    else:
        # Generate all sections
        results = await generator.generate_report(topic_limit=args.topic_limit)
    
    # Print results
    print(json.dumps(results, indent=2))

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())