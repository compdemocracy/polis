#!/usr/bin/env python3
"""
Calculate and store comment extremity values for all comments in a conversation.

This script:
1. Uses the GroupDataProcessor to calculate comment extremity values
2. Stores the results in DynamoDB for use by visualization and reporting scripts
3. Can be run standalone or imported by other scripts

Usage:
    python 501_calculate_comment_extremity.py --zid=CONVERSATION_ID
"""

import os
import sys
import logging
import argparse
import traceback
import boto3
from typing import Dict, List, Any, Optional

# Add parent directory to path to import polismath modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import GroupDataProcessor for extremity calculation
from polismath_commentgraph.utils.storage import PostgresClient
from polismath_commentgraph.utils.group_data import GroupDataProcessor

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def calculate_and_store_extremity(conversation_id: int, force_recalculation: bool = False, include_moderation: bool = False) -> Dict[int, float]:
    """
    Calculate and store extremity values for all comments in a conversation.
    
    Args:
        conversation_id: Conversation ID
        force_recalculation: Whether to force recalculation of values
        
    Returns:
        Dictionary mapping comment IDs to extremity values
    """
    logger.info(f"Calculating comment extremity values for conversation {conversation_id}")
    
    # Initialize PostgreSQL client and GroupDataProcessor
    postgres_client = PostgresClient()
    group_processor = GroupDataProcessor(postgres_client)
    
    try:
        # Check if we already have extremity values in DynamoDB
        if not force_recalculation:
            logger.info("Checking for existing extremity values in DynamoDB")
            existing_values = check_existing_extremity_values(conversation_id)
            if existing_values:
                logger.info(f"Found {len(existing_values)} existing extremity values in DynamoDB")
                return existing_values
                
        # Process the conversation data - this will calculate comment extremity 
        # values and store them in DynamoDB
        export_data = group_processor.get_export_data(int(conversation_id), include_moderation)
        
        # Extract extremity values from the processed data
        extremity_values = {}
        for comment in export_data.get('comments', []):
            tid = comment.get('comment_id')
            if tid is not None:
                extremity_value = comment.get('comment_extremity', 0)
                extremity_values[tid] = extremity_value
                
        logger.info(f"Calculated and stored {len(extremity_values)} extremity values")
        
        # Log some statistics about the extremity distribution
        if extremity_values:
            values_list = list(extremity_values.values())
            min_extremity = min(values_list) if values_list else 0
            max_extremity = max(values_list) if values_list else 0
            mean_extremity = sum(values_list) / len(values_list) if values_list else 0
            
            # Count distribution
            low_count = sum(1 for v in values_list if v < 0.3)
            mid_count = sum(1 for v in values_list if 0.3 <= v < 0.7)
            high_count = sum(1 for v in values_list if v >= 0.7)
            
            logger.info(f"Extremity statistics:")
            logger.info(f"  Range: {min_extremity:.4f} to {max_extremity:.4f}")
            logger.info(f"  Mean: {mean_extremity:.4f}")
            logger.info(f"  Distribution: {low_count} low (<0.3), {mid_count} medium, {high_count} high (>=0.7)")
        
        return extremity_values
    
    except Exception as e:
        logger.error(f"Error calculating extremity values: {e}")
        logger.error(traceback.format_exc())
        return {}
    finally:
        # Clean up PostgreSQL connection
        postgres_client.shutdown()

def check_existing_extremity_values(conversation_id: int) -> Dict[int, float]:
    """
    Check if extremity values already exist in DynamoDB using GroupDataProcessor.
    
    Args:
        conversation_id: Conversation ID
        
    Returns:
        Dictionary mapping comment IDs to extremity values
    """
    try:
        # Initialize PostgreSQL client and GroupDataProcessor
        postgres_client = PostgresClient()
        group_processor = GroupDataProcessor(postgres_client)
        
        # Get all extremity values for this conversation
        extremity_values = group_processor.get_all_comment_extremity_values(conversation_id)
        
        # Clean up PostgreSQL connection
        postgres_client.shutdown()
        
        return extremity_values
    
    except Exception as e:
        logger.error(f"Error checking existing extremity values: {e}")
        logger.error(traceback.format_exc())
        return {}

def print_extremity_report(extremity_values: Dict[int, float]):
    """
    Print a report of the extremity values.
    
    Args:
        extremity_values: Dictionary mapping comment IDs to extremity values
    """
    if not extremity_values:
        print("No extremity values found.")
        return
        
    values_list = list(extremity_values.values())
    
    print("\n===== Comment Extremity Report =====")
    print(f"Total comments: {len(extremity_values)}")
    print(f"Extremity range: {min(values_list):.4f} to {max(values_list):.4f}")
    print(f"Mean extremity: {sum(values_list) / len(values_list):.4f}")
    
    # Count distribution
    low_count = sum(1 for v in values_list if v < 0.3)
    mid_count = sum(1 for v in values_list if 0.3 <= v < 0.7)
    high_count = sum(1 for v in values_list if v >= 0.7)
    
    print("\nExtremity distribution:")
    print(f"  Low (<0.3): {low_count} comments ({low_count/len(values_list)*100:.1f}%)")
    print(f"  Medium (0.3-0.7): {mid_count} comments ({mid_count/len(values_list)*100:.1f}%)")
    print(f"  High (>0.7): {high_count} comments ({high_count/len(values_list)*100:.1f}%)")
    
    # Most extreme comments
    if values_list:
        sorted_items = sorted(extremity_values.items(), key=lambda x: x[1], reverse=True)
        print("\nMost divisive comments (top 5):")
        for i, (tid, value) in enumerate(sorted_items[:5]):
            print(f"  {i+1}. Comment {tid}: {value:.4f}")

def main():
    """Main entry point for script when run directly."""
    parser = argparse.ArgumentParser(description='Calculate comment extremity values')
    parser.add_argument('--zid', type=int, required=True, help='Conversation ID')
    parser.add_argument('--force', action='store_true', help='Force recalculation of values')
    parser.add_argument('--verbose', action='store_true', help='Show detailed output')
    parser.add_argument('--include_moderation', type=bool, default=False, help='Whether or not to include moderated comments in reports. If false, moderated comments will appear.')
    args = parser.parse_args()
    args = parser.parse_args()
    
    # Set log level based on verbosity
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    # Calculate and store extremity values
    extremity_values = calculate_and_store_extremity(args.zid, args.force, args.include_moderation)
    
    # Print report
    print_extremity_report(extremity_values)
    
    if extremity_values:
        print(f"\nSuccessfully calculated and stored extremity values for {len(extremity_values)} comments.")
    else:
        print("\nNo extremity values were calculated. Check logs for errors.")

if __name__ == "__main__":
    main()