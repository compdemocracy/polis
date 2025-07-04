#!/usr/bin/env python3
"""
502_calculate_priorities.py

Calculate comment priorities using group-based extremity values.

This script runs after extremity calculation (501_calculate_comment_extremity.py)
and computes final priority values using the group-based extremity data.
"""

import argparse
import boto3
import json
import logging
import os
import sys
import time
from boto3.dynamodb.conditions import Key
from decimal import Decimal
from typing import Dict, List, Optional, Any

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class PriorityCalculator:
    """Calculate comment priorities using group-based extremity values."""

    def __init__(self, conversation_id: int, endpoint_url: str = None):
        """
        Initialize the priority calculator.

        Args:
            conversation_id: The conversation ID to process
            endpoint_url: DynamoDB endpoint URL (optional)
        """
        self.conversation_id = conversation_id
        self.endpoint_url = endpoint_url

        # Initialize DynamoDB connection
        self.dynamodb = boto3.resource(
            'dynamodb',
            endpoint_url=endpoint_url,
            region_name='us-east-1',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', 'dummy'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', 'dummy')
        )

        # Get table references
        self.comment_routing_table = self.dynamodb.Table('Delphi_CommentRouting')
        self.comment_extremity_table = self.dynamodb.Table('Delphi_CommentExtremity')

        logger.info(f"Initialized priority calculator for conversation {conversation_id}")

    def _importance_metric(self, A: int, P: int, S: int, E: float) -> float:
        """
        Calculate importance metric (matches Clojure implementation).
        
        Args:
            A: Number of agree votes
            P: Number of pass votes  
            S: Total number of votes
            E: Extremity value
            
        Returns:
            Importance metric value
        """
        p = (P + 1) / (S + 2)
        a = (A + 1) / (S + 2)
        return (1 - p) * (E + 1) * a

    def _priority_metric(self, is_meta: bool, A: int, P: int, S: int, E: float) -> float:
        """
        Calculate priority metric (matches Clojure implementation).
        
        Args:
            is_meta: Whether the comment is a meta comment
            A: Number of agree votes
            P: Number of pass votes
            S: Total number of votes
            E: Extremity value
            
        Returns:
            Priority metric value
        """
        META_PRIORITY = 7.0
        if is_meta:
            return META_PRIORITY ** 2
        else:
            importance = self._importance_metric(A, P, S, E)
            scaling_factor = 1.0 + (8.0 * (2.0 ** (-S / 5.0)))
            return (importance * scaling_factor) ** 2

    def get_comment_extremity(self, comment_id: str) -> float:
        """
        Get extremity value for a comment from DynamoDB.
        
        Args:
            comment_id: The comment ID
            
        Returns:
            Extremity value (0.0 to 1.0) or 0.0 if not found
        """
        try:
            response = self.comment_extremity_table.get_item(
                Key={
                    'conversation_id': str(self.conversation_id),
                    'comment_id': str(comment_id)
                }
            )
            if 'Item' in response:
                return float(response['Item'].get('extremity_value', 0.0))
            else:
                logger.debug(f"No extremity data found for comment {comment_id}")
                return 0.0
        except Exception as e:
            logger.warning(f"Error retrieving extremity for comment {comment_id}: {e}")
            return 0.0

    def get_comment_routing_data(self) -> List[Dict[str, Any]]:
        """
        Get all comment routing data for the conversation.
        
        Returns:
            List of comment routing items
        """
        logger.info(f"Querying GSI 'zid-index' for conversation {self.conversation_id}...")
        all_items = []
        try:
            # Query the GSI where the partition key 'zid' matches the conversation_id
            response = self.comment_routing_table.query(
                IndexName='zid-index',
                KeyConditionExpression=Key('zid').eq(str(self.conversation_id))
            )
            all_items.extend(response.get('Items', []))

            # Handle pagination if the result set is large
            while 'LastEvaluatedKey' in response:
                logger.info("Paginating to fetch more comment routing data...")
                response = self.comment_routing_table.query(
                    IndexName='zid-index',
                    KeyConditionExpression=Key('zid').eq(str(self.conversation_id)),
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
                all_items.extend(response.get('Items', []))

            logger.info(f"Found {len(all_items)} comment routing entries via GSI query.")
            return all_items
            
        except Exception as e:
            logger.error(f"Error querying comment routing data from GSI: {e}")
            return []

    def calculate_comment_updates(self, comment_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Calculate priorities and return a list of items to be updated,
        including their primary keys.
        """
        updates = []
        for item in comment_data:
            try:
                comment_id = item.get('comment_id')
                zid_tick = item.get('zid_tick')  # The primary key we need for the update
                stats = item.get('stats', {})
                
                if not all([comment_id, zid_tick, stats]):
                    logger.warning(f"Skipping item due to missing data: {item}")
                    continue
                
                A = int(stats.get('agree', 0))
                D = int(stats.get('disagree', 0))
                S = int(stats.get('total', 0))
                P = S - (A + D)
                
                E = self.get_comment_extremity(comment_id)
                is_meta = False  # Assuming no meta comments for now
                
                priority = self._priority_metric(is_meta, A, P, S, E)
                
                # Prepare the update payload with the full key and the new priority
                updates.append({
                    'Key': {
                        'zid_tick': zid_tick,
                        'comment_id': comment_id
                    },
                    'UpdateExpression': 'SET priority = :p',
                    'ExpressionAttributeValues': {':p': int(priority)}
                })
                
                logger.debug(f"Comment {comment_id}: A={A}, P={P}, S={S}, E={E:.4f}, priority={int(priority)}")
                
            except Exception as e:
                logger.warning(f"Error preparing update for comment {item.get('comment_id', 'N/A')}: {e}")

        return updates

    def update_priorities_in_dynamodb(self, updates: List[Dict[str, Any]]) -> bool:
        """
        Update priority values in the comment routing table.
        
        Args:
            priorities: Dictionary mapping comment_id to priority value
            
        Returns:
            True if successful, False otherwise
        """
        logger.info(f"Updating {len(updates)} priority values in DynamoDB")
        try:
            # Use a BatchWriter to efficiently handle multiple updates.
            with self.comment_routing_table.batch_writer(overwrite_by_pkeys=['zid_tick', 'comment_id']) as batch:
                for item_update in updates:
                    # NOTE: BatchWriter does not support update_item. We must put the entire item.
                    # This requires fetching the full item first or knowing its structure.
                    # A loop of update_item is simpler and already a huge improvement.
                    self.comment_routing_table.update_item(**item_update)

            logger.info("Successfully updated all priorities in DynamoDB")
            return True
            
        except Exception as e:
            logger.error(f"Error updating priorities in DynamoDB: {e}")
            return False

    def run(self) -> bool:
        """
        Run the complete priority calculation and update process.
        """
        try:
            start_time = time.time()
            
            # 1. Get all necessary data efficiently
            comment_data = self.get_comment_routing_data()
            
            if not comment_data:
                logger.warning("No comment routing data found - conversation likely has no votes yet. This is normal.")
                return True

            # 2. Calculate priorities and prepare update payloads
            updates_to_perform = self.calculate_comment_updates(comment_data)
            
            if not updates_to_perform:
                logger.warning("No valid comments to update.")
                return True
            
            # 3. Update DynamoDB
            success = self.update_priorities_in_dynamodb(updates_to_perform)
            
            elapsed = time.time() - start_time
            if success:
                logger.info(f"Priority calculation and update completed successfully for {len(updates_to_perform)} comments in {elapsed:.2f}s")
                
                # Log some statistics (restored from original)
                priority_values = [item['ExpressionAttributeValues'][':p'] for item in updates_to_perform]
                if priority_values:
                    avg_priority = sum(priority_values) / len(priority_values)
                    max_priority = max(priority_values)
                    min_priority = min(priority_values)
                    logger.info(f"Priority statistics: min={min_priority}, max={max_priority}, avg={avg_priority:.2f}")
                
            else:
                logger.error(f"Priority update failed after {elapsed:.2f}s")
                
            return success
            
        except Exception as e:
            logger.critical(f"A critical error occurred in the run process: {e}", exc_info=True)
            return False

def main():
    """Main function."""
    parser = argparse.ArgumentParser(description='Calculate comment priorities using group-based extremity')
    parser.add_argument('--conversation_id', '--zid', type=int, required=True, help='Conversation ID to process')
    parser.add_argument('--endpoint-url', type=str, default=os.environ.get('DYNAMODB_ENDPOINT', 'http://host.docker.internal:8000'), help='DynamoDB endpoint URL')
    parser.add_argument('--verbose', '-v', action='store_true', help='Enable verbose logging')
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    calculator = PriorityCalculator(args.conversation_id, args.endpoint_url)
    success = calculator.run()
    
    if success:
        logger.info("Priority calculation completed successfully.")
        sys.exit(0)
    else:
        logger.error("Priority calculation failed.")
        sys.exit(1)

if __name__ == '__main__':
    main()