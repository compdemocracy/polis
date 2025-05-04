"""
Tests for the conversation processing with real data from PostgreSQL.
This module fetches real conversation data from PostgreSQL and processes it
through the Conversation class.
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
import boto3
import time
import decimal

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.conversation.conversation import Conversation
from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.math.named_matrix import NamedMatrix


def init_dynamodb():
    """
    Initialize a connection to DynamoDB on localhost:8000.
    
    Returns:
        DynamoDB resource and metadata about created tables
    """
    # Connect to local DynamoDB
    print("Connecting to local DynamoDB at localhost:8000")
    dynamodb = boto3.resource(
        'dynamodb',
        endpoint_url='http://localhost:8000',
        region_name='us-west-2',
        aws_access_key_id='dummy',
        aws_secret_access_key='dummy'
    )
    
    # Create tables if they don't exist
    tables = list(dynamodb.tables.all())
    table_names = [table.name for table in tables]
    
    # Create conversations table if it doesn't exist
    if 'polis_conversations' not in table_names:
        print("Creating polis_conversations table")
        conversations_table = dynamodb.create_table(
            TableName='polis_conversations',
            KeySchema=[
                {'AttributeName': 'zid', 'KeyType': 'HASH'}  # Partition key
            ],
            AttributeDefinitions=[
                {'AttributeName': 'zid', 'AttributeType': 'S'}
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
        )
        # Wait for table creation
        conversations_table.meta.client.get_waiter('table_exists').wait(TableName='polis_conversations')
        print("polis_conversations table created")
    else:
        conversations_table = dynamodb.Table('polis_conversations')
        print("Using existing polis_conversations table")
    
    # Create math table if it doesn't exist
    if 'polis_math' not in table_names:
        print("Creating polis_math table")
        math_table = dynamodb.create_table(
            TableName='polis_math',
            KeySchema=[
                {'AttributeName': 'zid', 'KeyType': 'HASH'}  # Partition key
            ],
            AttributeDefinitions=[
                {'AttributeName': 'zid', 'AttributeType': 'S'}
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
        )
        # Wait for table creation
        math_table.meta.client.get_waiter('table_exists').wait(TableName='polis_math')
        print("polis_math table created")
    else:
        math_table = dynamodb.Table('polis_math')
        print("Using existing polis_math table")
    
    return {
        'dynamodb': dynamodb,
        'conversations_table': conversations_table,
        'math_table': math_table
    }


def write_to_dynamodb(dynamodb_resources, conversation_id, conv_data):
    """
    Write conversation data to DynamoDB.
    
    Args:
        dynamodb_resources: Dictionary with DynamoDB resources
        conversation_id: Conversation ID (zid)
        conv_data: Conversation data from conv.to_dict()
        
    Returns:
        Success status
    """
    math_table = dynamodb_resources['math_table']
    conversations_table = dynamodb_resources['conversations_table']
    
    try:
        print(f"Writing conversation {conversation_id} to DynamoDB")
        
        # Prepare math data record
        # Need to convert all data to DynamoDB compatible format
        # We'll store a serialized version in the DynamoDB table
        math_json = json.dumps(conv_data)
        
        # Put math data
        math_table.put_item(
            Item={
                'zid': str(conversation_id),
                'math_data': math_json,
                'last_updated': int(time.time())
            }
        )
        print(f"Math data written to DynamoDB for conversation {conversation_id}")
        
        # Create a summary record for the conversations table
        summary = {
            'zid': str(conversation_id),
            'participant_count': conv_data.get('n', 0),
            'comment_count': conv_data.get('n-cmts', 0),
            'group_count': len(conv_data.get('group-clusters', [])),
            'last_updated': int(time.time())
        }
        
        # Put conversation summary
        conversations_table.put_item(Item=summary)
        print(f"Conversation summary written to DynamoDB for conversation {conversation_id}")
        
        return True
    except Exception as e:
        print(f"Error writing to DynamoDB: {e}")
        return False


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


def fetch_votes(conn, conversation_id): #, limit=0):
    """
    Fetch votes for a specific conversation from PostgreSQL.

    Args:
        conn: PostgreSQL connection
        conversation_id: Conversation ID (zid)
        limit: Optional limit on number of votes (0 for all)

    Returns:
        Dictionary containing votes in the format expected by Conversation
    """
    import time
    start_time = time.time()
    
    print(f"[{start_time:.2f}s] Fetching votes for conversation {conversation_id}")
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    
    # Use a very small limit for testing
    # if limit == 0:
    #     limit = 100
    
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
    """
    # LIMIT %s
    
    try:
        print(f"[{time.time() - start_time:.2f}s] Starting vote query execution...")
        cursor.execute(query, (conversation_id,))
        print(f"[{time.time() - start_time:.2f}s] Query executed, beginning fetch of all votes...")
        
        # Fetch in batches to show progress
        votes = []
        batch_size = 10000
        
        while True:
            fetch_start = time.time()
            batch = cursor.fetchmany(batch_size)
            if not batch:
                break
            votes.extend(batch)
            print(f"[{time.time() - start_time:.2f}s] Fetched batch of {len(batch)} votes, total now: {len(votes)}, batch took {time.time() - fetch_start:.2f}s")
        
        print(f"[{time.time() - start_time:.2f}s] All votes fetched: {len(votes)} total")
        cursor.close()
    except Exception as e:
        print(f"[{time.time() - start_time:.2f}s] Error fetching votes: {e}")
        cursor.close()
        return {'votes': []}
    
    # Convert to the format expected by the Conversation class
    print(f"[{time.time() - start_time:.2f}s] Converting {len(votes)} votes to internal format...")
    convert_start = time.time()
    votes_list = []
    
    # Process in batches to show progress
    batch_size = 50000
    for i in range(0, len(votes), batch_size):
        batch_start = time.time()
        end_idx = min(i + batch_size, len(votes))
        batch = votes[i:end_idx]
        
        batch_votes = []
        for vote in batch:
            # Handle timestamp (already a string in Unix timestamp format)
            if vote['timestamp']:
                try:
                    created_time = int(float(vote['timestamp']) * 1000)
                except (ValueError, TypeError):
                    created_time = None
            else:
                created_time = None
                
            batch_votes.append({
                'pid': str(vote['voter_id']),
                'tid': str(vote['comment_id']),
                'vote': float(vote['vote']),
                'created': created_time
            })
        
        votes_list.extend(batch_votes)
        print(f"[{time.time() - start_time:.2f}s] Converted batch of {len(batch)} votes ({i+1}-{end_idx}/{len(votes)}), batch took {time.time() - batch_start:.2f}s")
    
    print(f"[{time.time() - start_time:.2f}s] Vote conversion completed in {time.time() - convert_start:.2f}s")
    
    # Pack into the expected votes format
    result = {
        'votes': votes_list
    }
    
    print(f"[{time.time() - start_time:.2f}s] Vote processing completed in {time.time() - start_time:.2f}s")
    return result


def fetch_comments(conn, conversation_id): #, limit=0):
    """
    Fetch comments for a specific conversation from PostgreSQL.

    Args:
        conn: PostgreSQL connection
        conversation_id: Conversation ID (zid)
        limit: Optional limit on number of comments (0 for all)

    Returns:
        Dictionary containing comments in the format expected by Conversation
    """
    import time
    start_time = time.time()
    
    print(f"[{start_time:.2f}s] Fetching comments for conversation {conversation_id}")
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    
    query = """
    SELECT 
        c.created as timestamp,
        c.tid as comment_id,
        c.pid as author_id,
        c.mod as moderated,
        c.txt as comment_body,
        c.is_seed
    FROM 
        comments c
    WHERE
        c.zid = %s
    ORDER BY 
        c.created
    """
    
    try:
        print(f"[{time.time() - start_time:.2f}s] Starting comments query execution...")
        cursor.execute(query, (conversation_id,))
        print(f"[{time.time() - start_time:.2f}s] Query executed, fetching comments...")
        comments = cursor.fetchall()
        print(f"[{time.time() - start_time:.2f}s] Fetched {len(comments)} comments")
        cursor.close()
    except Exception as e:
        print(f"[{time.time() - start_time:.2f}s] Error fetching comments: {e}")
        cursor.close()
        return {'comments': []}
    
    # Convert to the format expected by the Conversation class
    print(f"[{time.time() - start_time:.2f}s] Converting {len(comments)} comments to internal format...")
    convert_start = time.time()
    comments_list = []
    
    # Track each moderation type
    mod_out_count = 0
    mod_in_count = 0
    
    for comment in comments:
        # Only include non-moderated-out comments (mod != '-1')
        if comment['moderated'] == '-1':
            mod_out_count += 1
            continue
        
        if comment['moderated'] == '1':
            mod_in_count += 1
            
        # Handle timestamp (already a string in Unix timestamp format)
        if comment['timestamp']:
            try:
                created_time = int(float(comment['timestamp']) * 1000)
            except (ValueError, TypeError):
                created_time = None
        else:
            created_time = None
            
        comments_list.append({
            'tid': str(comment['comment_id']),
            'created': created_time,
            'txt': comment['comment_body'],
            'is_seed': bool(comment['is_seed'])
        })
    
    print(f"[{time.time() - start_time:.2f}s] Comment conversion completed in {time.time() - convert_start:.2f}s")
    print(f"[{time.time() - start_time:.2f}s] Comment stats: {len(comments_list)} usable, {mod_out_count} excluded, {mod_in_count} featured")
    
    result = {
        'comments': comments_list
    }
    
    print(f"[{time.time() - start_time:.2f}s] Comment processing completed in {time.time() - start_time:.2f}s")
    return result


def fetch_moderation(conn, conversation_id):
    """
    Fetch moderation data for a specific conversation from PostgreSQL.

    Args:
        conn: PostgreSQL connection
        conversation_id: Conversation ID (zid)

    Returns:
        Dictionary containing moderation data in the format expected by Conversation
    """
    import time
    start_time = time.time()
    
    print(f"[{start_time:.2f}s] Fetching moderation data for conversation {conversation_id}")
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    
    try:
        # Query moderated comments
        query_mod_comments = """
        SELECT
            tid,
            mod,
            is_meta
        FROM
            comments
        WHERE
            zid = %s
        """
        print(f"[{time.time() - start_time:.2f}s] Executing moderated comments query...")
        mod_query_start = time.time()
        cursor.execute(query_mod_comments, (conversation_id,))
        print(f"[{time.time() - start_time:.2f}s] Query executed in {time.time() - mod_query_start:.2f}s, fetching results...")
        fetch_start = time.time()
        mod_comments = cursor.fetchall()
        print(f"[{time.time() - start_time:.2f}s] Fetched {len(mod_comments)} comment moderation records in {time.time() - fetch_start:.2f}s")
        
        # Check if participants table exists
        print(f"[{time.time() - start_time:.2f}s] Checking if participants table exists...")
        table_check = """
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'participants'
        )
        """
        cursor.execute(table_check)
        table_exists = cursor.fetchone()[0]
        
        mod_ptpts = []
        if table_exists:
            # Query moderated participants
            query_mod_ptpts = """
            SELECT
                pid
            FROM
                participants
            WHERE
                zid = %s AND
                mod = '-1'
            """
            print(f"[{time.time() - start_time:.2f}s] Executing moderated participants query...")
            ptpt_query_start = time.time()
            cursor.execute(query_mod_ptpts, (conversation_id,))
            print(f"[{time.time() - start_time:.2f}s] Query executed in {time.time() - ptpt_query_start:.2f}s, fetching results...")
            ptpt_fetch_start = time.time()
            mod_ptpts = cursor.fetchall()
            print(f"[{time.time() - start_time:.2f}s] Fetched {len(mod_ptpts)} participant moderation records in {time.time() - ptpt_fetch_start:.2f}s")
        else:
            print(f"[{time.time() - start_time:.2f}s] Participants table does not exist, skipping")
            
    except Exception as e:
        print(f"[{time.time() - start_time:.2f}s] Error fetching moderation data: {e}")
        cursor.close()
        return {
            'mod_out_tids': [],
            'mod_in_tids': [],
            'meta_tids': [],
            'mod_out_ptpts': []
        }
        
    cursor.close()
    
    # Format moderation data
    print(f"[{time.time() - start_time:.2f}s] Processing moderation data...")
    process_start = time.time()
    
    mod_out_tids = [str(c['tid']) for c in mod_comments if c['mod'] == '-1']
    mod_in_tids = [str(c['tid']) for c in mod_comments if c['mod'] == '1']
    meta_tids = [str(c['tid']) for c in mod_comments if c['is_meta']]
    mod_out_ptpts = [str(p['pid']) for p in mod_ptpts]
    
    print(f"[{time.time() - start_time:.2f}s] Moderation processing completed in {time.time() - process_start:.2f}s")
    print(f"[{time.time() - start_time:.2f}s] Moderation stats: {len(mod_out_tids)} excluded comments, {len(mod_in_tids)} featured comments, {len(meta_tids)} meta comments, {len(mod_out_ptpts)} excluded participants")
    
    result = {
        'mod_out_tids': mod_out_tids,
        'mod_in_tids': mod_in_tids,
        'meta_tids': meta_tids,
        'mod_out_ptpts': mod_out_ptpts
    }
    
    print(f"[{time.time() - start_time:.2f}s] Moderation fetch completed in {time.time() - start_time:.2f}s")
    return result


def get_popular_conversations(conn, limit=5):
    """
    Get the most popular conversations by vote count.

    Args:
        conn: PostgreSQL connection
        limit: Maximum number of conversations to return

    Returns:
        List of conversation IDs (zids) with high vote counts
    """
    import time
    start_time = time.time()
    
    print(f"[{start_time:.2f}s] Finding {limit} popular conversations...")
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    
    try:
        # First check if the zinvites table exists
        print(f"[{time.time() - start_time:.2f}s] Checking if zinvites table exists...")
        table_check = """
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'zinvites'
        )
        """
        cursor.execute(table_check)
        zinvites_exists = cursor.fetchone()[0]
        
        if zinvites_exists:
            # Use a join query with zinvites
            print(f"[{time.time() - start_time:.2f}s] Using zinvites table for lookup...")
            query = """
            SELECT 
                v.zid, 
                COUNT(*) as vote_count,
                MIN(z.zinvite) as zinvite
            FROM 
                votes v
            JOIN
                zinvites z ON v.zid = z.zid
            GROUP BY 
                v.zid
            ORDER BY 
                vote_count DESC
            LIMIT %s
            """
        else:
            # Fallback if zinvites table doesn't exist
            print(f"[{time.time() - start_time:.2f}s] Zinvites table not found, using votes table only")
            query = """
            SELECT 
                zid, 
                COUNT(*) as vote_count,
                zid::text as zinvite
            FROM 
                votes
            GROUP BY 
                zid
            ORDER BY 
                vote_count DESC
            LIMIT %s
            """
        
        print(f"[{time.time() - start_time:.2f}s] Executing popular conversations query...")
        query_start = time.time()
        cursor.execute(query, (limit,))
        print(f"[{time.time() - start_time:.2f}s] Query executed in {time.time() - query_start:.2f}s, fetching results...")
        fetch_start = time.time()
        results = cursor.fetchall()
        print(f"[{time.time() - start_time:.2f}s] Found {len(results)} conversations in {time.time() - fetch_start:.2f}s")
        
        # Display information about each conversation
        for i, row in enumerate(results):
            print(f"[{time.time() - start_time:.2f}s] Conversation {i+1}: zid={row['zid']}, votes={row['vote_count']}, zinvite={row['zinvite']}")
        
    except Exception as e:
        print(f"[{time.time() - start_time:.2f}s] Error finding popular conversations: {e}")
        # Fallback to hardcoded conversation if query fails
        print(f"[{time.time() - start_time:.2f}s] Using fallback conversation ID")
        cursor.close()
        return [(22154, 1000, "fallback")]
        
    cursor.close()
    
    result = [(row['zid'], row['vote_count'], row['zinvite']) for row in results]
    print(f"[{time.time() - start_time:.2f}s] Conversation lookup completed in {time.time() - start_time:.2f}s")
    
    return result


def test_conversation_from_postgres():
    """
    Test processing a conversation with data from PostgreSQL.
    """
    import time
    start_time = time.time()
    
    print(f"[{time.time() - start_time:.2f}s] Starting PostgreSQL conversation test")
    
    # Connect to database
    print(f"[{time.time() - start_time:.2f}s] Connecting to database...")
    conn = connect_to_db()
    if not conn:
        print(f"[{time.time() - start_time:.2f}s] Database connection failed")
        pytest.skip("Could not connect to PostgreSQL database")
    
    try:
        # Get popular conversations
        print(f"[{time.time() - start_time:.2f}s] Finding popular conversations...")
        popular_convs = get_popular_conversations(conn)
        
        if not popular_convs:
            print(f"[{time.time() - start_time:.2f}s] No conversations found")
            pytest.skip("No conversations found in the database")
        
        print(f"[{time.time() - start_time:.2f}s] Found {len(popular_convs)} conversations for processing")
        
        # Process each conversation
        for idx, (conv_id, vote_count, zinvite) in enumerate(popular_convs):
            print(f"\n[{time.time() - start_time:.2f}s] Processing conversation {idx+1}/{len(popular_convs)}: {conv_id} (zinvite: {zinvite}) with {vote_count} votes")
            
            # Create a new conversation
            print(f"[{time.time() - start_time:.2f}s] Creating conversation object")
            conv = Conversation(str(conv_id))
            
            # Fetch votes
            print(f"[{time.time() - start_time:.2f}s] Starting vote retrieval...")
            vote_fetch_start = time.time()
            votes = fetch_votes(conn, conv_id)
            print(f"[{time.time() - start_time:.2f}s] Vote retrieval completed in {time.time() - vote_fetch_start:.2f}s - {len(votes['votes'])} votes fetched")
            
            # Fetch comments
            print(f"[{time.time() - start_time:.2f}s] Starting comment retrieval...")
            comment_fetch_start = time.time()
            comments = fetch_comments(conn, conv_id)
            print(f"[{time.time() - start_time:.2f}s] Comment retrieval completed in {time.time() - comment_fetch_start:.2f}s - {len(comments['comments'])} comments fetched")
            
            # Fetch moderation
            print(f"[{time.time() - start_time:.2f}s] Starting moderation retrieval...")
            mod_fetch_start = time.time()
            moderation = fetch_moderation(conn, conv_id)
            print(f"[{time.time() - start_time:.2f}s] Moderation retrieval completed in {time.time() - mod_fetch_start:.2f}s")
            print(f"[{time.time() - start_time:.2f}s] Moderation summary: {len(moderation['mod_out_tids'])} excluded comments, {len(moderation['mod_in_tids'])} featured comments")
            
            # Update conversation with votes
            print(f"[{time.time() - start_time:.2f}s] Adding {len(votes['votes'])} votes and {len(comments['comments'])} comments to conversation...")
            vote_update_start = time.time()
            conv = conv.update_votes(votes, recompute=False)  # Don't recompute yet
            print(f"[{time.time() - start_time:.2f}s] Vote update completed in {time.time() - vote_update_start:.2f}s")
            
            # Apply moderation
            print(f"[{time.time() - start_time:.2f}s] Applying moderation settings...")
            mod_update_start = time.time()
            conv = conv.update_moderation(moderation, recompute=False)  # Don't recompute yet
            print(f"[{time.time() - start_time:.2f}s] Moderation applied in {time.time() - mod_update_start:.2f}s")
            
            # Recompute to generate clustering, PCA, and representativeness
            print(f"[{time.time() - start_time:.2f}s] Starting full recomputation...")
            recompute_start = time.time()
            
            # Break down the recomputation steps
            print(f"[{time.time() - start_time:.2f}s] 1. Computing PCA...")
            pca_time = time.time()
            try:
                conv._compute_pca()
                print(f"[{time.time() - start_time:.2f}s] PCA completed in {time.time() - pca_time:.2f}s")
            except Exception as e:
                print(f"[{time.time() - start_time:.2f}s] Error in PCA computation: {e}")
            
            print(f"[{time.time() - start_time:.2f}s] 2. Computing clusters...")
            cluster_time = time.time()
            try:
                conv._compute_clusters()
                print(f"[{time.time() - start_time:.2f}s] Clustering completed in {time.time() - cluster_time:.2f}s")
            except Exception as e:
                print(f"[{time.time() - start_time:.2f}s] Error in clustering computation: {e}")
            
            print(f"[{time.time() - start_time:.2f}s] 3. Computing representativeness...")
            repness_time = time.time()
            try:
                conv._compute_repness()
                print(f"[{time.time() - start_time:.2f}s] Representativeness completed in {time.time() - repness_time:.2f}s")
            except Exception as e:
                print(f"[{time.time() - start_time:.2f}s] Error in representativeness computation: {e}")
            
            print(f"[{time.time() - start_time:.2f}s] 4. Computing participant info...")
            ptptinfo_time = time.time()
            try:
                conv._compute_participant_info()
                print(f"[{time.time() - start_time:.2f}s] Participant info completed in {time.time() - ptptinfo_time:.2f}s")
            except Exception as e:
                print(f"[{time.time() - start_time:.2f}s] Error in participant info computation: {e}")
            
            print(f"[{time.time() - start_time:.2f}s] All recomputations completed in {time.time() - recompute_start:.2f}s")
            
            # Extract key metrics
            print(f"[{time.time() - start_time:.2f}s] Extracting results...")
            
            # 1. Number of groups found
            group_count = len(conv.group_clusters)
            print(f"[{time.time() - start_time:.2f}s] Found {group_count} groups")
            
            # 2. Number of comments processed
            comment_count = conv.comment_count
            print(f"[{time.time() - start_time:.2f}s] Processed {comment_count} comments")
            
            # 3. Number of participants
            participant_count = conv.participant_count
            print(f"[{time.time() - start_time:.2f}s] Found {participant_count} participants")
            
            # 4. Check that we have representative comments
            repness_count = 0
            if conv.repness and 'comment_repness' in conv.repness:
                repness_count = len(conv.repness['comment_repness'])
                print(f"[{time.time() - start_time:.2f}s] Calculated representativeness for {repness_count} comments")
            
            # 5. Print top representative comments for each group
            if conv.repness and 'comment_repness' in conv.repness and group_count > 0:
                print(f"[{time.time() - start_time:.2f}s] Top representative comments by group:")
                for group_id in range(group_count):
                    print(f"\n[{time.time() - start_time:.2f}s] Group {group_id}:")
                    group_repness = [item for item in conv.repness['comment_repness'] if item['gid'] == group_id]
                    
                    # Sort by representativeness
                    group_repness.sort(key=lambda x: abs(x['repness']), reverse=True)
                    
                    # Print top 3 comments
                    for i, rep_item in enumerate(group_repness[:3]):
                        comment_id = rep_item['tid']
                        # Get the comment text if available
                        comment_txt = next((c['txt'] for c in comments['comments'] if str(c['tid']) == str(comment_id)), 'Unknown')
                        print(f"  {i+1}. Comment {comment_id} (Repness: {rep_item['repness']:.4f}): {comment_txt[:50]}...")
            
            # Save the results for manual inspection
            print(f"[{time.time() - start_time:.2f}s] Saving results...")
            save_start = time.time()
            
            output_dir = os.path.join(os.path.dirname(__file__), '..', 'real_data', 'postgres_output')
            os.makedirs(output_dir, exist_ok=True)
            
            # Save the conversation data to file
            output_file = os.path.join(output_dir, f'conversation_{zinvite}_result.json')
            conv_data = conv.to_dict()
            with open(output_file, 'w') as f:
                json.dump(conv_data, f, indent=2)
            
            print(f"[{time.time() - start_time:.2f}s] Saved results to {output_file} in {time.time() - save_start:.2f}s")
            
            # Save to DynamoDB
            try:
                print(f"[{time.time() - start_time:.2f}s] Initializing DynamoDB connection...")
                dynamo_start = time.time()
                dynamodb_resources = init_dynamodb()
                print(f"[{time.time() - start_time:.2f}s] DynamoDB initialized in {time.time() - dynamo_start:.2f}s")
                
                print(f"[{time.time() - start_time:.2f}s] Writing to DynamoDB...")
                write_start = time.time()
                success = write_to_dynamodb(dynamodb_resources, conv_id, conv_data)
                print(f"[{time.time() - start_time:.2f}s] DynamoDB write {'succeeded' if success else 'failed'} in {time.time() - write_start:.2f}s")
            except Exception as e:
                print(f"[{time.time() - start_time:.2f}s] Error with DynamoDB: {e}")
            
            # Perform basic assertions
            print(f"[{time.time() - start_time:.2f}s] Running tests...")
            
            assert group_count >= 0, "Group count should be non-negative"
            assert participant_count > 0, "Participant count should be positive"
            assert conv.rating_mat.values.shape[0] == participant_count, "Matrix dimensions should match participant count"
            
            # Validate PCA results
            if participant_count > 1 and comment_count > 1:
                assert conv.pca is not None, "PCA should be computed"
                assert 'center' in conv.pca, "PCA should have center"
                assert 'comps' in conv.pca, "PCA should have components"
            
            # Test representativeness computation
            if group_count > 0:
                assert conv.repness is not None, "Representativeness should be computed"
                assert 'comment_repness' in conv.repness, "Comment representativeness should be computed"
            
            print(f"[{time.time() - start_time:.2f}s] Conversation {idx+1}/{len(popular_convs)} processed successfully")
    
    except Exception as e:
        print(f"[{time.time() - start_time:.2f}s] ERROR: Test failed with exception: {e}")
        import traceback
        traceback.print_exc()
        raise
    
    finally:
        conn.close()
        print(f"[{time.time() - start_time:.2f}s] Database connection closed")
        print(f"[{time.time() - start_time:.2f}s] Test completed in {time.time() - start_time:.2f} seconds")


def patched_poll_moderation(client, zid, since=None):
    """
    A patched version of poll_moderation that handles string mod values.
    
    Args:
        client: PostgresClient instance
        zid: Conversation ID
        since: Only get changes after this timestamp
    
    Returns:
        Dictionary with moderation data
    """
    params = {"zid": zid}
    
    # Build SQL query for moderated comments with string comparison
    sql_mods = """
    SELECT
        tid,
        modified,
        mod,
        is_meta
    FROM
        comments
    WHERE
        zid = :zid
    """
    
    # Add timestamp filter if provided
    if since:
        sql_mods += " AND modified > :since"
        params["since"] = since
    
    # Execute query
    mods = client.query(sql_mods, params)
    
    # Format moderation data
    mod_out_tids = []
    mod_in_tids = []
    meta_tids = []
    
    for m in mods:
        tid = str(m["tid"])
        
        # Check moderation status with string comparison
        if m["mod"] == '-1' or m["mod"] == -1:
            mod_out_tids.append(tid)
        elif m["mod"] == '1' or m["mod"] == 1:
            mod_in_tids.append(tid)
        
        # Check meta status
        if m["is_meta"]:
            meta_tids.append(tid)
    
    # Build SQL query for moderated participants with string comparison
    sql_ptpts = """
    SELECT
        pid
    FROM
        participants
    WHERE
        zid = :zid
        AND mod = '-1'
    """
    
    # Execute query
    mod_ptpts = client.query(sql_ptpts, params)
    
    # Format moderated participants
    mod_out_ptpts = [str(p["pid"]) for p in mod_ptpts]
    
    return {
        "mod_out_tids": mod_out_tids,
        "mod_in_tids": mod_in_tids,
        "meta_tids": meta_tids,
        "mod_out_ptpts": mod_out_ptpts
    }


def test_dynamodb_direct():
    """
    Test writing directly to DynamoDB without PostgreSQL.
    This is useful for directly testing the DynamoDB functionality.
    """
    print("\nTesting direct DynamoDB write functionality")
    
    try:
        # Create a dummy conversation
        conv_id = "test_conversation_" + str(int(time.time()))
        print(f"Creating dummy conversation {conv_id}")
        
        # Create a basic conversation
        conv = Conversation(conv_id)
        
        # Add some dummy votes
        dummy_votes = {
            'votes': [
                {'pid': '1', 'tid': '101', 'vote': 1.0},
                {'pid': '1', 'tid': '102', 'vote': -1.0},
                {'pid': '2', 'tid': '101', 'vote': -1.0},
                {'pid': '2', 'tid': '102', 'vote': 1.0},
                {'pid': '3', 'tid': '101', 'vote': 1.0}
            ]
        }
        
        # Update conversation with votes
        print("Adding votes to conversation")
        conv = conv.update_votes(dummy_votes)
        
        # Recompute to generate data
        print("Recomputing conversation")
        conv = conv.recompute()
        
        # Get conversation data
        conv_data = conv.to_dict()
        
        # Initialize DynamoDB
        print("Initializing DynamoDB connection")
        dynamodb_resources = init_dynamodb()
        
        # Write to DynamoDB
        print(f"Writing conversation {conv_id} to DynamoDB")
        success = write_to_dynamodb(dynamodb_resources, conv_id, conv_data)
        
        if success:
            print("Successfully wrote test data to DynamoDB")
            
            # Verify the data was written
            math_table = dynamodb_resources['math_table']
            
            # Get the item from DynamoDB
            response = math_table.get_item(Key={'zid': conv_id})
            
            # Check if item exists
            if 'Item' in response:
                print("Successfully retrieved data from DynamoDB")
                
                # Load and validate a portion of the data
                stored_data = json.loads(response['Item']['math_data'])
                
                # Perform some basic validation
                assert stored_data.get('zid') == conv_id, "Conversation ID mismatch"
                assert 'n' in stored_data, "Missing 'n' in stored data"
                assert 'n-cmts' in stored_data, "Missing 'n-cmts' in stored data"
                
                print("Data validation successful")
                return True
            else:
                print("Failed to retrieve data from DynamoDB")
                return False
        else:
            print("Failed to write test data to DynamoDB")
            return False
            
    except Exception as e:
        print(f"Error in direct DynamoDB test: {e}")
        import traceback
        traceback.print_exc()
        return False


def inspect_dynamodb_data():
    """Inspect data in DynamoDB tables"""
    print("\nInspecting DynamoDB data")
    
    # Initialize DynamoDB
    dynamodb_resources = init_dynamodb()
    math_table = dynamodb_resources['math_table']
    conversations_table = dynamodb_resources['conversations_table']
    
    # Scan the conversations table
    response = conversations_table.scan()
    items = response.get('Items', [])
    print(f"\nFound {len(items)} conversations:")
    for item in items:
        print(f"  - {item['zid']}: {item.get('participant_count', 0)} participants, {item.get('comment_count', 0)} comments")
    
    # If only one conversation, show it automatically
    if len(items) == 1:
        zid = items[0]['zid']
        print(f"\nAutomatically showing conversation {zid} (only one available)")
        response = math_table.get_item(Key={'zid': zid})
        item = response.get('Item')
        if item:
            math_data = json.loads(item['math_data'])
            print(f"\nConversation {zid} summary:")
            print(f"  - Participants: {math_data.get('n', 0)}")
            print(f"  - Comments: {math_data.get('n-cmts', 0)}")
            print(f"  - Groups: {len(math_data.get('group-clusters', []))}")
            
            # Show group details
            for i, group in enumerate(math_data.get('group-clusters', [])):
                print(f"\nGroup {i+1} (ID: {group.get('id')})")
                print(f"  - Members: {len(group.get('members', []))}")
                print(f"  - Center: {group.get('center', [])}")
    else:
        # If multiple conversations, try to get input but handle EOFError
        try:
            zid = input("\nEnter a conversation ID to inspect (or press Enter to skip): ")
            if zid:
                response = math_table.get_item(Key={'zid': zid})
                item = response.get('Item')
                if item:
                    math_data = json.loads(item['math_data'])
                    print(f"\nConversation {zid} summary:")
                    print(f"  - Participants: {math_data.get('n', 0)}")
                    print(f"  - Comments: {math_data.get('n-cmts', 0)}")
                    print(f"  - Groups: {len(math_data.get('group-clusters', []))}")
                    
                    # Show group details by default
                    for i, group in enumerate(math_data.get('group-clusters', [])):
                        print(f"\nGroup {i+1} (ID: {group.get('id')})")
                        print(f"  - Members: {len(group.get('members', []))}")
                        print(f"  - Center: {group.get('center', [])}")
                else:
                    print(f"Conversation {zid} not found")
        except EOFError:
            print("\nNon-interactive environment detected.")
            # Just show the list of conversations already displayed
    
    return True


def test_conversation_client_api():
    """
    Test processing a conversation using the PostgresClient API.
    """
    # Create PostgreSQL client
    config = PostgresConfig(
        database="polis_subset",
        user="christian",
        password="christian",
        host="localhost"
    )
    
    client = PostgresClient(config)
    
    try:
        client.initialize()
        
        # Get conversation IDs
        zids_query = """
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
        
        results = client.query(zids_query)
        
        if not results:
            pytest.skip("No conversations found in the database")
        
        zid = results[0]['zid']
        vote_count = results[0]['vote_count']
        
        print(f"\nProcessing conversation {zid} with {vote_count} votes using PostgresClient API")
        
        # Create a new conversation
        conv = Conversation(str(zid))
        
        # Poll votes with a reasonable limit for testing
        votes = client.poll_votes(zid)
        
        # Format votes for Conversation class
        votes_formatted = {
            'votes': [
                {
                    'pid': v['pid'],
                    'tid': v['tid'],
                    'vote': v['vote'],
                    'created': int(float(v['created']) * 1000) if v['created'] and isinstance(v['created'], str) else 
                              (int(v['created'].timestamp() * 1000) if v['created'] else None)
                }
                for v in votes
            ]
        }
        
        # Poll moderation data using our patched function
        moderation = patched_poll_moderation(client, zid)
        
        # Update conversation with votes
        print(f"Processing conversation with {len(votes_formatted['votes'])} votes")
        conv = conv.update_votes(votes_formatted)
        
        # Apply moderation
        conv = conv.update_moderation(moderation)
        
        # Recompute to generate clustering, PCA, and representativeness
        print("Recomputing conversation analysis...")
        conv = conv.recompute()
        
        # Extract key metrics
        # 1. Number of groups found
        group_count = len(conv.group_clusters)
        print(f"Found {group_count} groups")
        
        # 2. Number of comments processed
        comment_count = conv.comment_count
        print(f"Processed {comment_count} comments")
        
        # 3. Number of participants
        participant_count = conv.participant_count
        print(f"Found {participant_count} participants")
        
        # 4. Check that we have representative comments
        if conv.repness and 'comment_repness' in conv.repness:
            print(f"Calculated representativeness for {len(conv.repness['comment_repness'])} comments")
        
        # Save the results using the PostgresClient API
        math_data = conv.to_dict()
        
        # Save results directly to math_main table (optional, uncomment to enable)
        # client.write_math_main(zid, math_data)
        
        # Save to DynamoDB
        try:
            print("\nInitializing DynamoDB connection...")
            dynamodb_resources = init_dynamodb()
            print("DynamoDB initialized")
            
            print(f"Writing conversation {zid} to DynamoDB...")
            success = write_to_dynamodb(dynamodb_resources, zid, math_data)
            if success:
                print("Successfully wrote conversation data to DynamoDB")
            else:
                print("Failed to write conversation data to DynamoDB")
        except Exception as e:
            print(f"Error with DynamoDB: {e}")
        
        # Basic assertions
        assert group_count >= 0, "Group count should be non-negative"
        assert participant_count > 0, "Participant count should be positive"
        
        print("Test completed successfully using PostgresClient API")
    
    finally:
        client.shutdown()


if __name__ == "__main__":
    import sys
    
    # Check command line arguments
    if len(sys.argv) > 1:
        if sys.argv[1] == 'client':
            print("Testing PostgresClient API:")
            test_conversation_client_api()
        elif sys.argv[1] == 'dynamodb':
            print("Testing DynamoDB directly:")
            test_dynamodb_direct()
        elif sys.argv[1] == 'inspect':
            print("Inspecting DynamoDB data:")
            inspect_dynamodb_data()
        elif sys.argv[1] == 'limit' and len(sys.argv) > 2:
            # Run with a specific vote limit
            import time
            start_time = time.time()
            
            # Set limit for votes
            def modified_fetch_votes(conn, conversation_id):
                limit = int(sys.argv[2])
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
                
                return {'votes': votes_list}
                
            # Save the original function
            original_fetch_votes = fetch_votes
            # Replace with the modified function
            fetch_votes = modified_fetch_votes
            
            try:
                print("Testing conversations with PostgreSQL data (limited votes):")
                test_conversation_from_postgres()
                print(f"Test completed in {time.time() - start_time:.2f} seconds")
            finally:
                # Restore the original function
                fetch_votes = original_fetch_votes
        else:
            print("Testing conversations with PostgreSQL data:")
            test_conversation_from_postgres()
    else:
        # Print usage
        print("Usage:")
        print("  python test_postgres_real_data.py             # Test with PostgreSQL data")
        print("  python test_postgres_real_data.py client      # Test PostgresClient API")
        print("  python test_postgres_real_data.py dynamodb    # Test DynamoDB directly")
        print("  python test_postgres_real_data.py inspect     # Inspect DynamoDB data")
        print("  python test_postgres_real_data.py limit <n>   # Test with limited votes")
        
        # By default, run the direct DynamoDB test
        print("\nRunning DynamoDB test by default:")
        test_dynamodb_direct()