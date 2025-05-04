"""
Profile the conversation processing with real data from PostgreSQL.
This version uses detailed profiling to identify bottlenecks.
"""

import pytest
import os
import sys
import pandas as pd
import numpy as np
import json
from datetime import datetime
import psycopg2
from psycopg2 import extras
import time
import cProfile
import pstats
from io import StringIO

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Import the profiler before any other polismath imports
from tests.conversation_profiler import instrument_conversation_class, restore_original_methods, print_profiling_summary

# Apply instrumentation to the Conversation class
instrument_conversation_class()

# Now import polismath modules
from polismath.conversation.conversation import Conversation
from polismath.database.postgres import PostgresClient, PostgresConfig

def connect_to_db():
    """Connect to PostgreSQL database."""
    try:
        conn = psycopg2.connect(
            dbname="polis_subset",
            user="christian",
            password="christian",
            host="localhost"
        )
        print("Connected to database successfully")
        return conn
    except Exception as e:
        print(f"Error connecting to database: {e}")
        return None

def fetch_votes(conn, conversation_id, limit=1000):
    """
    Fetch votes for a specific conversation from PostgreSQL.
    
    Args:
        conn: PostgreSQL connection
        conversation_id: Conversation ID (zid)
        limit: Optional limit on number of votes (use for profiling)
        
    Returns:
        Dictionary containing votes in the format expected by Conversation
    """
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    
    query = """
    SELECT 
        v.created as timestamp,
        v.tid as comment_id,
        v.pid as voter_id,
        v.vote
    FROM 
        votes v
    WHERE
        v.zid = %s
    ORDER BY 
        v.created
    LIMIT %s
    """
    
    try:
        print(f"Fetching up to {limit} votes for conversation {conversation_id}...")
        cursor.execute(query, (conversation_id, limit))
        votes = cursor.fetchall()
        print(f"Fetched {len(votes)} votes")
        cursor.close()
    except Exception as e:
        print(f"Error fetching votes: {e}")
        cursor.close()
        return {'votes': []}
    
    # Convert to the format expected by the Conversation class
    print(f"Converting votes to required format...")
    votes_list = []
    
    for vote in votes:
        # Handle timestamp (already a string in Unix timestamp format)
        if vote['timestamp']:
            try:
                created_time = int(float(vote['timestamp']) * 1000)
            except (ValueError, TypeError):
                created_time = None
        else:
            created_time = None
            
        votes_list.append({
            'pid': str(vote['voter_id']),
            'tid': str(vote['comment_id']),
            'vote': float(vote['vote']),
            'created': created_time
        })
    
    # Pack into the expected votes format
    return {
        'votes': votes_list
    }

def get_specific_conversation(conn, zid=None):
    """Get a specific conversation or the most popular one."""
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    
    if zid is None:
        # Get the most popular conversation
        query = """
        SELECT 
            zid, 
            COUNT(*) as vote_count
        FROM 
            votes
        GROUP BY 
            zid
        ORDER BY 
            vote_count DESC
        LIMIT 1
        """
        cursor.execute(query)
    else:
        # Get the specified conversation
        query = """
        SELECT 
            zid,
            (SELECT COUNT(*) FROM votes WHERE zid = %s) as vote_count
        FROM 
            votes
        WHERE
            zid = %s
        LIMIT 1
        """
        cursor.execute(query, (zid, zid))
    
    result = cursor.fetchone()
    cursor.close()
    
    if result:
        return result['zid'], result['vote_count']
    else:
        return None, 0

def profile_conversation(conn, zid=None, vote_limit=1000):
    """
    Profile the Conversation class with PostgreSQL data.
    
    Args:
        conn: PostgreSQL connection
        zid: Optional specific conversation ID
        vote_limit: Maximum number of votes to process
    """
    # Get conversation ID
    conversation_id, vote_count = get_specific_conversation(conn, zid)
    if not conversation_id:
        print("No conversations found in the database")
        return
    
    print(f"Profiling conversation {conversation_id} with up to {vote_limit} votes (total votes: {vote_count})")
    
    # Fetch votes
    votes = fetch_votes(conn, conversation_id, limit=vote_limit)
    print(f"Processing conversation with {len(votes['votes'])} votes")
    
    # Create a new conversation
    conv = Conversation(str(conversation_id))
    
    # Profile the update_votes method
    profiler = cProfile.Profile()
    profiler.enable()
    
    # Run update_votes with the votes
    start_time = time.time()
    try:
        conv = conv.update_votes(votes)
        end_time = time.time()
        print(f"update_votes completed in {end_time - start_time:.2f} seconds")
    except Exception as e:
        print(f"Error during update_votes: {e}")
    
    profiler.disable()
    
    # Print cProfile results
    print("\ncProfile Results (top 30 functions by cumulative time):")
    s = StringIO()
    ps = pstats.Stats(profiler, stream=s).sort_stats('cumtime')
    ps.print_stats(30)
    print(s.getvalue())
    
    # Print our custom profiling summary
    print_profiling_summary()
    
    # Return the conv object for further analysis if needed
    return conv

def main():
    """Main function to run the profiling."""
    import argparse
    
    parser = argparse.ArgumentParser(description='Profile Conversation class with PostgreSQL data.')
    parser.add_argument('--zid', type=int, help='Specific conversation ID to profile')
    parser.add_argument('--limit', type=int, default=1000, help='Maximum number of votes to process')
    args = parser.parse_args()
    
    try:
        # Connect to database
        conn = connect_to_db()
        if not conn:
            print("Could not connect to PostgreSQL database")
            return
        
        # Run profiling
        profile_conversation(conn, args.zid, args.limit)
    finally:
        # Restore original methods
        restore_original_methods()

if __name__ == "__main__":
    main()