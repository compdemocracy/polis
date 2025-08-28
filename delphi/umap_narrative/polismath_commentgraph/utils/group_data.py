"""
Group data utilities for the Polis report system.
Provides functionality to retrieve and process group and vote data 
from PostgreSQL for report generation.
"""

import json
import logging
import boto3
import os
from typing import Dict, List, Any, Optional
from collections import defaultdict
from datetime import datetime
from decimal import Decimal

logger = logging.getLogger(__name__)

class GroupDataProcessor:
    """
    Processes group and vote data for report generation.
    """
    
    def __init__(self, postgres_client):
        """
        Initialize the group data processor.
        
        Args:
            postgres_client: PostgreSQL client for database access
        """
        self.postgres_client = postgres_client
        
        # Initialize DynamoDB connection
        self.dynamodb = None
        self.extremity_table = None
        self.init_dynamodb()
        
    def init_dynamodb(self):
        """Initialize DynamoDB connection for storing extremity values."""
        try:
            # If DYNAMODB_ENDPOINT is an empty string, treat it as None
            endpoint_url = os.environ.get('DYNAMODB_ENDPOINT') or None
            region = os.environ.get('AWS_REGION', 'us-east-1')
            
            logger.info("Initializing DynamoDB client...")
            logger.info(f"  Region: {region}")
            logger.info(f"  Endpoint URL: {endpoint_url if endpoint_url else 'Default AWS DynamoDB'}")

            # Set up DynamoDB client WITHOUT explicit credentials.
            # Boto3 will use its default credential provider chain (env vars -> IAM role).
            self.dynamodb = boto3.resource(
                'dynamodb',
                endpoint_url=endpoint_url,
                region_name=region
            )
            
            self.extremity_table = self.dynamodb.Table('Delphi_CommentExtremity')
            # This check verifies the connection and table access.
            self.extremity_table.load() 
            logger.info(f"Successfully initialized DynamoDB connection and accessed table '{self.extremity_table.name}'")

        except Exception as e:
            logger.error(f"Failed to initialize DynamoDB connection: {e}")
            self.dynamodb = None
            self.extremity_table = None

    def get_math_main_by_conversation(self, zid: int) -> Dict[str, Any]:
        """
        Get math main data (group assignments) for a conversation.
        
        Args:
            zid: Conversation ID
            
        Returns:
            Math data dictionary including group assignments
        """
        try:
            # Attempt to retrieve group assignments from math_main table
            sql = """
            SELECT 
                data
            FROM 
                math_main
            WHERE 
                zid = :zid
            ORDER BY 
                modified DESC
            LIMIT 1
            """
            
            results = self.postgres_client.query(sql, {"zid": zid})
            
            if results and 'data' in results[0]:
                # Parse JSON data if it's a string, or use as is if it's already parsed
                try:
                    data_value = results[0]['data']
                    if isinstance(data_value, str):
                        data = json.loads(data_value)
                    else:
                        # Already parsed or in dict form
                        data = data_value
                        
                    # Log the structure of the data to help debug
                    top_level_keys = list(data.keys()) if isinstance(data, dict) else "not a dict"
                    logger.debug(f"Successfully retrieved math data for conversation {zid} with keys: {top_level_keys}")
                    
                    # Examine the structure deeper to find group assignments
                    if isinstance(data, dict) and 'consensus' in data:
                        consensus_keys = list(data['consensus'].keys()) if isinstance(data['consensus'], dict) else "not a dict"
                        logger.debug(f"Math data consensus section has keys: {consensus_keys}")
                    
                    if isinstance(data, dict) and 'group-clusters' in data:
                        group_clusters = data['group-clusters']
                        logger.debug(f"Found group-clusters with type: {type(group_clusters)}")
                        if isinstance(group_clusters, list) and len(group_clusters) > 0:
                            logger.debug(f"First group-cluster has {len(group_clusters[0])} items")
                    
                    if isinstance(data, dict) and 'group-stats' in data:
                        group_stats = data['group-stats']
                        logger.info(f"Found group-stats with type: {type(group_stats)}")
                        if isinstance(group_stats, dict):
                            logger.info(f"Group-stats has keys: {list(group_stats.keys())}")
                    
                    if isinstance(data, dict) and 'group_votes' in data:
                        logger.info(f"Found group_votes with type: {type(data['group_votes'])}")
                    
                    if isinstance(data, dict) and 'participation' in data:
                        participation = data['participation']
                        if isinstance(participation, dict) and 'ptptogroup' in participation:
                            ptptogroup = participation['ptptogroup']
                            logger.info(f"Found ptptogroup with type: {type(ptptogroup)} and {len(ptptogroup)} items if dict/list")
                    
                    return data
                except (json.JSONDecodeError, TypeError) as e:
                    logger.error(f"Error parsing math data JSON for conversation {zid}: {e}")
            
            # If we can't get from math_main table, try to get it from Postgres votes
            # to recreate the basic structure needed for report generation
            logger.warning(f"No math data found in math_main for conversation {zid}, generating from votes")
            
            group_assignments = {}
            
            # Get votes and count how many of each type per participant
            votes_data = self.postgres_client.get_votes_by_conversation(zid)
            
            # Get unique participants from votes
            participant_ids = set(v['pid'] for v in votes_data if v.get('pid') is not None)
            
            # Assign groups based on voting patterns
            # In a real implementation this would be based on PCA or similar clustering
            
            # Count agree/disagree patterns
            voting_patterns = defaultdict(lambda: {'agree': 0, 'disagree': 0, 'pass': 0})
            
            for vote in votes_data:
                pid = vote.get('pid')
                vote_val = vote.get('vote')
                if pid is not None and vote_val is not None:
                    if vote_val == 1:
                        voting_patterns[pid]['agree'] += 1
                    elif vote_val == -1:
                        voting_patterns[pid]['disagree'] += 1
                    elif vote_val == 0:
                        voting_patterns[pid]['pass'] += 1
            
            # Simplistic grouping based on voting patterns
            # This is a placeholder - not a real clustering algorithm
            for pid in participant_ids:
                pattern = voting_patterns[pid]
                total_votes = pattern['agree'] + pattern['disagree'] + pattern['pass']
                if total_votes > 0:
                    agree_ratio = pattern['agree'] / max(1, pattern['agree'] + pattern['disagree'])
                    
                    # Simple heuristic to assign groups - just for demonstration
                    if agree_ratio > 0.7:
                        group_assignments[str(pid)] = 0
                    elif agree_ratio < 0.3:
                        group_assignments[str(pid)] = 1
                    else:
                        group_assignments[str(pid)] = 2
            
            # Create simplified math_main structure
            math_data = {
                'group_assignments': group_assignments,
                'n_groups': 3  # We created a max of 3 groups above
            }
            
            logger.info(f"Generated simplified group assignments for {len(group_assignments)} participants")
            
            return math_data
            
        except Exception as e:
            logger.error(f"Error getting math data for conversation {zid}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            
            # Return minimal structure to avoid errors downstream
            return {
                'group_assignments': {},
                'n_groups': 0
            }
    
    def get_vote_data_by_groups(self, zid: int) -> Dict[str, Any]:
        """
        Get vote data organized by groups for reporting.
        
        Args:
            zid: Conversation ID
            
        Returns:
            Dictionary with vote data organized by comment and group
        """
        try:
            # Get math data for group assignments
            math_data = self.get_math_main_by_conversation(zid)
            
            # Try various possible formats for group assignments
            group_assignments = {}
            
            # Check the most common keys where group assignments might be stored
            possible_keys = ['group_assignments', 'group_assignment', 'groupAssignments']
            for key in possible_keys:
                if key in math_data and math_data[key]:
                    group_assignments = math_data[key]
                    logger.info(f"Found group assignments under key: {key}")
                    break
            
            # Check for ptogroup in the participation section
            if not group_assignments and isinstance(math_data, dict) and 'participation' in math_data:
                participation = math_data['participation']
                if isinstance(participation, dict) and 'ptptogroup' in participation:
                    ptptogroup = participation['ptptogroup']
                    if ptptogroup:
                        group_assignments = ptptogroup
                        logger.info(f"Found group assignments in participation.ptptogroup")
                        
            # Check for group-clusters which has group membership information
            if not group_assignments and isinstance(math_data, dict) and 'group-clusters' in math_data:
                group_clusters = math_data['group-clusters']
                if isinstance(group_clusters, list) and len(group_clusters) > 0:
                    try:
                        # Group clusters may contain membership info
                        logger.debug(f"Group-clusters list has {len(group_clusters)} items")
                        
                        # The data might be in various formats depending on the algorithm used
                        # Let's log some debug info to see the structure
                        if len(group_clusters) > 0:
                            first_cluster = group_clusters[0]
                            logger.debug(f"First cluster type: {type(first_cluster)}")
                            
                            # Check if it's a list of lists (direct group memberships)
                            if isinstance(first_cluster, list) and len(first_cluster) > 0:
                                # This may be a list of group IDs
                                # Let's try to generate group assignments
                                temp_assignments = {}
                                
                                # Interpret group-clusters as a list of groups, with each entry being a list of participant IDs
                                for group_id, group_members in enumerate(group_clusters):
                                    if isinstance(group_members, list):
                                        for pid in group_members:
                                            temp_assignments[str(pid)] = group_id
                                            
                                if temp_assignments:
                                    group_assignments = temp_assignments
                                    logger.info(f"Extracted {len(group_assignments)} group assignments from group-clusters list")
                            
                            # Check if it's a list of dictionaries (more complex structure)
                            elif isinstance(first_cluster, dict):
                                logger.debug(f"First cluster keys: {list(first_cluster.keys()) if first_cluster else 'empty'}")
                                
                                # Try to extract members if available
                                temp_assignments = {}
                                
                                for group_id, cluster_info in enumerate(group_clusters):
                                    if isinstance(cluster_info, dict):
                                        # Check various possible keys for member information
                                        for key in ['members', 'ids', 'pids', 'participants']:
                                            if key in cluster_info and isinstance(cluster_info[key], list):
                                                for pid in cluster_info[key]:
                                                    temp_assignments[str(pid)] = group_id
                                
                                if temp_assignments:
                                    group_assignments = temp_assignments
                                    logger.debug(f"Extracted {len(group_assignments)} group assignments from group-clusters dictionaries")
                            
                    except Exception as e:
                        logger.error(f"Error extracting group assignments from group-clusters: {e}")
                        import traceback
                        logger.error(traceback.format_exc())
            
            # Last resort - check if there's a 'group-stats' that might have participant info
            if not group_assignments and isinstance(math_data, dict) and 'group-stats' in math_data:
                group_stats = math_data['group-stats']
                if isinstance(group_stats, dict) and len(group_stats) > 0:
                    # Try to extract participant group assignments from group stats
                    # This is just a basic approach - might need refinement 
                    try:
                        # Usually there are group_X keys with participant data
                        # We'll look for these and try to extract participant groups
                        temp_assignments = {}
                        for key, value in group_stats.items():
                            if key.startswith('group_') and isinstance(value, dict) and 'members' in value:
                                group_id = key.replace('group_', '')
                                for pid in value['members']:
                                    temp_assignments[str(pid)] = int(group_id)
                        
                        if temp_assignments:
                            group_assignments = temp_assignments
                            logger.info(f"Extracted {len(group_assignments)} group assignments from group-stats")
                    except Exception as e:
                        logger.error(f"Error extracting group assignments from group-stats: {e}")
                        
            # If no group assignments found anywhere, generate them
            if not group_assignments:
                logger.warning("No group assignments found in math data, generating synthetic groups based on voting patterns")
                    
            logger.debug(f"Found {len(group_assignments)} group assignments in math data")
            
            # Get all votes
            votes = self.postgres_client.get_votes_by_conversation(zid)
            
            # Get all comments to ensure we include ones with no votes
            comments = self.postgres_client.get_comments_by_conversation(zid)
            
            # Organize vote data by comment and group
            
            # Initialize structure
            vote_data = {}
            for comment in comments:
                tid = comment.get('tid')
                if tid is not None:
                    vote_data[tid] = {
                        'total_votes': 0,
                        'total_agrees': 0,
                        'total_disagrees': 0,
                        'total_passes': 0,
                        'groups': defaultdict(lambda: {
                            'votes': 0,
                            'agrees': 0,
                            'disagrees': 0,
                            'passes': 0
                        })
                    }
            
            # Process votes
            for vote in votes:
                tid = vote.get('tid')
                pid = vote.get('pid')
                vote_val = vote.get('vote')
                
                if tid is not None and pid is not None and vote_val is not None:
                    # Initialize comment data if not exists
                    if tid not in vote_data:
                        vote_data[tid] = {
                            'total_votes': 0,
                            'total_agrees': 0,
                            'total_disagrees': 0,
                            'total_passes': 0,
                            'groups': defaultdict(lambda: {
                                'votes': 0,
                                'agrees': 0,
                                'disagrees': 0,
                                'passes': 0
                            })
                        }
                    
                    # Get group assignment
                    group_id = group_assignments.get(str(pid), -1)
                    
                    # Update total votes
                    vote_data[tid]['total_votes'] += 1
                    
                    # Update vote counts
                    if vote_val == 1:
                        vote_data[tid]['total_agrees'] += 1
                        vote_data[tid]['groups'][group_id]['agrees'] += 1
                    elif vote_val == -1:
                        vote_data[tid]['total_disagrees'] += 1
                        vote_data[tid]['groups'][group_id]['disagrees'] += 1
                    elif vote_val == 0:
                        vote_data[tid]['total_passes'] += 1
                        vote_data[tid]['groups'][group_id]['passes'] += 1
                    
                    # Update group vote count
                    vote_data[tid]['groups'][group_id]['votes'] += 1
            
            # Calculate group statistics for each comment
            for tid, data in vote_data.items():
                groups_data = data['groups']
                
                # Calculate percentages for each type of vote in each group
                group_vote_pcts = {}
                for group_id, group_data in groups_data.items():
                    total_votes = group_data['votes']
                    if total_votes > 0:
                        agree_pct = group_data['agrees'] / total_votes
                        disagree_pct = group_data['disagrees'] / total_votes
                        pass_pct = group_data['passes'] / total_votes
                    else:
                        agree_pct = disagree_pct = pass_pct = 0
                    
                    group_vote_pcts[group_id] = {
                        'agree': agree_pct,
                        'disagree': disagree_pct,
                        'pass': pass_pct
                    }
                
                # Calculate disagreement between groups (group extremity)
                if len(group_vote_pcts) > 1:
                    diffs = []
                    component_diffs = {'agree_diff': 0, 'disagree_diff': 0, 'pass_diff': 0}
                    group_ids = list(group_vote_pcts.keys())
                    for i in range(len(group_ids)):
                        for j in range(i+1, len(group_ids)):
                            group_i = group_ids[i]
                            group_j = group_ids[j]
                            
                            # Only include groups with valid data
                            if group_i != -1 and group_j != -1:
                                # Calculate differences for all vote types
                                agree_diff = abs(group_vote_pcts[group_i]['agree'] - group_vote_pcts[group_j]['agree'])
                                disagree_diff = abs(group_vote_pcts[group_i]['disagree'] - group_vote_pcts[group_j]['disagree'])
                                pass_diff = abs(group_vote_pcts[group_i]['pass'] - group_vote_pcts[group_j]['pass'])
                                
                                # Capture the maximum component differences
                                component_diffs['agree_diff'] = max(component_diffs['agree_diff'], agree_diff)
                                component_diffs['disagree_diff'] = max(component_diffs['disagree_diff'], disagree_diff)
                                component_diffs['pass_diff'] = max(component_diffs['pass_diff'], pass_diff)
                                
                                # Use the maximum difference across all voting types
                                diff = max(agree_diff, disagree_diff, pass_diff)
                                diffs.append(diff)
                    
                    if diffs:
                        avg_diff = sum(diffs) / len(diffs)
                        data['comment_extremity'] = avg_diff
                        
                        # Calculate proper group-aware consensus using Laplace-smoothed probability multiplication
                        # This matches the Node.js implementation
                        consensus_value = 1.0
                        valid_groups = [gid for gid in group_ids if gid != -1]
                        
                        if valid_groups:
                            for group_id in valid_groups:
                                group_data = groups_data[group_id]
                                agrees = group_data['agrees']
                                total_votes = group_data['votes']
                                
                                # Laplace smoothing: (agrees + 1) / (total + 2)
                                prob = (agrees + 1.0) / (total_votes + 2.0)
                                consensus_value *= prob
                                
                            data['group_aware_consensus'] = consensus_value
                        else:
                            data['group_aware_consensus'] = 0
                        
                        # Store extremity values in DynamoDB
                        try:
                            self.store_comment_extremity(
                                zid, 
                                tid, 
                                avg_diff, 
                                "max_vote_diff", 
                                component_diffs
                            )
                        except Exception as e:
                            logger.error(f"Failed to store extremity value for comment {tid}: {str(e)}")
                            # Continue processing - failure to store shouldn't stop the overall process
                    else:
                        data['group_aware_consensus'] = 0
                        data['comment_extremity'] = 0
                else:
                    data['group_aware_consensus'] = 0
                    data['comment_extremity'] = 0
                
                # Include group count
                data['num_groups'] = len([g for g in groups_data.keys() if g != -1])
            
            logger.debug(f"Processed vote data for {len(vote_data)} comments with group information")
            
            return {
                'vote_data': vote_data,
                'group_assignments': group_assignments,
                'n_groups': math_data.get('n_groups', 0)
            }
            
        except Exception as e:
            logger.error(f"Error getting vote data by groups for conversation {zid}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            
            # Return empty structure to avoid errors downstream
            return {
                'vote_data': {},
                'group_assignments': {},
                'n_groups': 0
            }

    def store_comment_extremity(self, conversation_id: int, comment_id: int, 
                              extremity_value: float, calculation_method: str,
                              component_values: Dict[str, float]) -> bool:
        """
        Store comment extremity values in DynamoDB.
        
        Args:
            conversation_id: Conversation ID
            comment_id: Comment ID
            extremity_value: The calculated extremity value
            calculation_method: Method used to calculate extremity
            component_values: Component values used in calculation
            
        Returns:
            Boolean indicating success
        """
        if not self.extremity_table:
            logger.warning("DynamoDB not initialized, skipping extremity storage")
            return False
            
        try:
            # Convert float values to Decimal for DynamoDB compatibility
            decimal_extremity = Decimal(str(extremity_value))
            
            # Convert component values to Decimal
            decimal_components = {}
            for key, value in component_values.items():
                decimal_components[key] = Decimal(str(value))
            
            # Prepare item for DynamoDB
            item = {
                'conversation_id': str(conversation_id),
                'comment_id': str(comment_id),
                'extremity_value': decimal_extremity,
                'calculation_method': calculation_method,
                'calculation_timestamp': datetime.now().isoformat(),
                'component_values': decimal_components
            }
            
            # Put item in DynamoDB
            self.extremity_table.put_item(Item=item)
            logger.debug(f"Stored extremity value {extremity_value} for comment {comment_id}")
            return True
        except Exception as e:
            logger.error(f"Error storing comment extremity in DynamoDB: {str(e)}")
            return False
            
    def get_comment_extremity(self, conversation_id: int, comment_id: int) -> Optional[Dict[str, Any]]:
        """
        Retrieve comment extremity values from DynamoDB.
        
        Args:
            conversation_id: Conversation ID
            comment_id: Comment ID
            
        Returns:
            Dictionary with extremity data or None if not found
        """
        if not self.extremity_table:
            logger.warning("DynamoDB not initialized, skipping extremity retrieval")
            return None
            
        try:
            response = self.extremity_table.get_item(
                Key={
                    'conversation_id': str(conversation_id),
                    'comment_id': str(comment_id)
                }
            )
            
            if 'Item' in response:
                item = response['Item']
                # Convert Decimal objects back to floats for internal use
                if 'extremity_value' in item and isinstance(item['extremity_value'], Decimal):
                    item['extremity_value'] = float(item['extremity_value'])
                
                # Convert component values back to floats
                if 'component_values' in item and isinstance(item['component_values'], dict):
                    for key, value in item['component_values'].items():
                        if isinstance(value, Decimal):
                            item['component_values'][key] = float(value)
                
                return item
            else:
                logger.debug(f"No extremity data found for comment {comment_id}")
                return None
        except Exception as e:
            logger.error(f"Error retrieving comment extremity from DynamoDB: {str(e)}")
            return None
            
    def get_all_comment_extremity_values(self, conversation_id: int) -> Dict[int, float]:
        """
        Get all extremity values for comments in a conversation.
        
        Args:
            conversation_id: Conversation ID
            
        Returns:
            Dictionary mapping comment IDs to extremity values
        """
        if not self.extremity_table:
            logger.warning("DynamoDB not initialized, skipping extremity retrieval")
            return {}
            
        try:
            # Query for all extremity values for this conversation
            response = self.extremity_table.query(
                KeyConditionExpression=boto3.dynamodb.conditions.Key('conversation_id').eq(str(conversation_id))
            )
            
            # Process results
            extremity_values = {}
            for item in response.get('Items', []):
                try:
                    comment_id = int(item.get('comment_id'))
                    # Convert Decimal back to float for internal use
                    extremity_value = float(item.get('extremity_value', 0))
                    extremity_values[comment_id] = extremity_value
                except (TypeError, ValueError) as e:
                    logger.warning(f"Error converting extremity value for comment {item.get('comment_id')}: {e}")
                
            # Handle pagination if there are many results
            while 'LastEvaluatedKey' in response:
                response = self.extremity_table.query(
                    KeyConditionExpression=boto3.dynamodb.conditions.Key('conversation_id').eq(str(conversation_id)),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                
                for item in response.get('Items', []):
                    try:
                        comment_id = int(item.get('comment_id'))
                        # Convert Decimal back to float for internal use
                        extremity_value = float(item.get('extremity_value', 0))
                        extremity_values[comment_id] = extremity_value
                    except (TypeError, ValueError) as e:
                        logger.warning(f"Error converting extremity value for comment {item.get('comment_id')}: {e}")
            
            logger.info(f"Retrieved {len(extremity_values)} extremity values for conversation {conversation_id}")
            return extremity_values
        except Exception as e:
            logger.error(f"Error retrieving extremity values: {str(e)}")
            return {}
            
    def get_export_data(self, zid: int, include_moderation: bool) -> Dict[str, Any]:
        """
        Get vote and comment data in the export format expected by the report generator.
        This simulates the format of the data from the export endpoint.
        
        Args:
            zid: Conversation ID
            
        Returns:
            Dictionary with comment and vote data in export format
        """
        try:
            # Get group and vote data
            group_vote_data = self.get_vote_data_by_groups(zid)
            vote_data = group_vote_data['vote_data']
            group_assignments = group_vote_data['group_assignments']
            
            # Get comments
            comments = self.postgres_client.get_comments_by_conversation(zid)
            if include_moderation:
                comments = [comment for comment in comments if comment['mod'] > -1]
            
            # Format data for export
            comment_data = []
            
            for comment in comments:
                tid = comment.get('tid')
                
                if tid in vote_data:
                    record = {
                        "comment-id": tid,
                        "comment": comment.get('txt', ''),
                    }
                    
                    # Add vote data
                    comment_votes = vote_data[tid]
                    record["total-votes"] = comment_votes['total_votes']
                    record["total-agrees"] = comment_votes['total_agrees'] 
                    record["total-disagrees"] = comment_votes['total_disagrees']
                    record["total-passes"] = comment_votes['total_passes']
                    
                    # Add calculated metrics
                    record["comment_id"] = tid
                    record["votes"] = comment_votes['total_votes']
                    record["agrees"] = comment_votes['total_agrees']
                    record["disagrees"] = comment_votes['total_disagrees']
                    record["passes"] = comment_votes['total_passes']
                    record["group_aware_consensus"] = comment_votes.get('group_aware_consensus', 0)
                    record["comment_extremity"] = comment_votes.get('comment_extremity', 0)
                    record["num_groups"] = comment_votes.get('num_groups', 0)
                    
                    # Add group data
                    for group_id, group_data in comment_votes['groups'].items():
                        if group_id != -1:  # Skip unassigned participants
                            record[f"group-{group_id}-votes"] = group_data['votes']
                            record[f"group-{group_id}-agrees"] = group_data['agrees']
                            record[f"group-{group_id}-disagrees"] = group_data['disagrees']
                            record[f"group-{group_id}-passes"] = group_data['passes']
                    
                    comment_data.append(record)
            
            logger.debug(f"Prepared export data for {len(comment_data)} comments with group information")
            
            return {
                'comments': comment_data,
                'math_result': {
                    'group_assignments': group_assignments,
                    'n_groups': group_vote_data['n_groups']
                }
            }
            
        except Exception as e:
            logger.error(f"Error getting export data for conversation {zid}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            
            # Return empty structure to avoid errors downstream
            return {
                'comments': [],
                'math_result': {
                    'group_assignments': {},
                    'n_groups': 0
                }
            }