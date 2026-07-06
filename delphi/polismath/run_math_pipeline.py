#!/usr/bin/env python3
"""
Run the math pipeline for a Polis conversation using the polismath package.
This script is adapted from the Pakistan test and is suitable for direct invocation.
"""
import os
import sys
import time
import logging
import argparse
import json
import decimal
from datetime import datetime

from polismath.utils.general import postgres_vote_to_delphi

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Stage 1's vote reads are shared with the input-snapshot capture
# (delphi_storage/inputs.py) so the two can never diverge (design §4.4/P6).
from delphi_storage.inputs import VOTES_BATCH_SQL, VOTES_COUNT_SQL


def prepare_for_json(obj):
    import numpy as np

    if isinstance(obj, decimal.Decimal):
        return float(obj)
    elif hasattr(obj, 'tolist'):
        return obj.tolist()
    elif hasattr(obj, 'isoformat'):
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {k: prepare_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [prepare_for_json(item) for item in obj]
    elif isinstance(obj, set):
        return [prepare_for_json(item) for item in obj]
    elif isinstance(obj, (np.int64, np.int32, np.int16, np.int8)):
        return int(obj)
    elif isinstance(obj, (np.float64, np.float32, np.float16)):
        return float(obj)
    else:
        return obj


def connect_to_db():
    """Connect to PostgreSQL database using environment variables or defaults."""
    import psycopg2
    import urllib.parse

    # POSTGRES_CONNECT_TIMEOUT: same env var read by the SQLAlchemy PostgresClient.
    # Default 30s (production-safe; transient slowness, scale-up, network blips).
    # CI and example.env override to 5s for fail-fast behavior. See delphi/CLAUDE.md.
    connect_timeout = int(os.environ.get("POSTGRES_CONNECT_TIMEOUT", "30"))

    try:
        # Check if DATABASE_URL is set and use it if available
        database_url = os.environ.get("DATABASE_URL")
        if database_url:
            logger.info(f"Using DATABASE_URL: {database_url.split('@')[1] if '@' in database_url else '(hidden)'}")
            conn = psycopg2.connect(database_url, connect_timeout=connect_timeout)
        else:
            # Fall back to individual connection parameters
            conn = psycopg2.connect(
                dbname=os.environ.get("DATABASE_NAME", "polisDB_prod_local_mar14"),
                user=os.environ.get("DATABASE_USER", "colinmegill"),
                password=os.environ.get("DATABASE_PASSWORD", ""),
                host=os.environ.get("DATABASE_HOST", "localhost"),
                port=os.environ.get("DATABASE_PORT", 5432),
                connect_timeout=connect_timeout,
            )

        logger.info("Connected to database successfully")
        return conn
    except Exception as e:
        logger.error(f"Error connecting to database: {e}")
        return None


def fetch_votes(conn, conversation_id):
    """
    Fetch votes for a specific conversation from PostgreSQL.
    Returns a dictionary containing votes in the format expected by Conversation.

    Vote signs are flipped at this PostgreSQL boundary:
    - PostgreSQL stores: AGREE=-1, DISAGREE=+1
    - Delphi expects:    AGREE=+1, DISAGREE=-1
    """
    import time
    from psycopg2 import extras

    start_time = time.time()
    logger.info(f"[{start_time:.2f}s] Fetching votes for conversation {conversation_id}")
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    query = """
    SELECT v.created as timestamp, v.tid as comment_id, v.pid as voter_id, v.vote
    FROM votes v WHERE v.zid = %s ORDER BY v.created
    """
    try:
        cursor.execute(query, (conversation_id,))
        votes = cursor.fetchall()
        cursor.close()
    except Exception as e:
        logger.error(f"Error fetching votes: {e}")
        cursor.close()
        return {"votes": []}
    votes_list = []
    for vote in votes:
        if vote["timestamp"]:
            try:
                created_time = int(float(vote["timestamp"]) * 1000)
            except (ValueError, TypeError):
                created_time = None
        else:
            created_time = None
        votes_list.append(
            {
                "pid": str(vote["voter_id"]),
                "tid": str(vote["comment_id"]),
                "vote": postgres_vote_to_delphi(
                    float(vote["vote"])
                ),  # Flip at boundary
                "created": created_time,
            }
        )
    return {"votes": votes_list}


def fetch_comments(conn, conversation_id):
    """
    Fetch comments for a specific conversation from PostgreSQL.
    Returns a dictionary containing comments in the format expected by Conversation.
    """
    import time
    from psycopg2 import extras

    start_time = time.time()
    logger.info(f"[{start_time:.2f}s] Fetching comments for conversation {conversation_id}")
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    query = """
    SELECT c.created as timestamp, c.tid as comment_id, c.pid as author_id, c.mod as moderated, c.txt as comment_body, c.is_seed
    FROM comments c WHERE c.zid = %s ORDER BY c.created
    """
    try:
        cursor.execute(query, (conversation_id,))
        comments = cursor.fetchall()
        cursor.close()
    except Exception as e:
        logger.error(f"Error fetching comments: {e}")
        cursor.close()
        return {'comments': []}
    return _comment_rows_to_dicts(comments)


def _comment_rows_to_dicts(comments):
    """Shared row→dict transformation for stage-1 comments — used by both the
    live SQL path and the snapshot path (comments_from_snapshot), so the two
    can never diverge, INCLUDING the moderated == '-1' comparison below,
    which compares the INTEGER mod column to a STRING and therefore never
    matches. That quirk is production behavior; changing it would change
    math inputs (golden invariance + propose-then-wait apply)."""
    comments_list = []
    for comment in comments:
        if comment['moderated'] == '-1':
            continue
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
    return {'comments': comments_list}


def comments_from_snapshot(reader):
    """Stage-1 comments fed from a snapshot (--input-source seam, P6b)."""
    return _comment_rows_to_dicts(reader.stage1_comment_rows())

def fetch_moderation(conn, conversation_id):
    """
    Fetch moderation data for a specific conversation from PostgreSQL.
    Returns a dictionary containing moderation data in the format expected by Conversation.
    """
    import time
    from psycopg2 import extras

    start_time = time.time()
    logger.info(f"[{start_time:.2f}s] Fetching moderation data for conversation {conversation_id}")
    cursor = conn.cursor(cursor_factory=extras.DictCursor)
    try:
        query_mod_comments = """
        SELECT tid, mod, is_meta FROM comments WHERE zid = %s
        """
        cursor.execute(query_mod_comments, (conversation_id,))
        mod_comments = cursor.fetchall()
        table_check = """
        SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'participants')
        """
        cursor.execute(table_check)
        table_exists = cursor.fetchone()[0]
        mod_ptpts = []
        if table_exists:
            query_mod_ptpts = """
            SELECT pid FROM participants WHERE zid = %s AND mod = '-1'
            """
            cursor.execute(query_mod_ptpts, (conversation_id,))
            mod_ptpts = cursor.fetchall()
    except Exception as e:
        logger.error(f"Error fetching moderation data: {e}")
        cursor.close()
        return {
            'mod_out_tids': [],
            'mod_in_tids': [],
            'meta_tids': [],
            'mod_out_ptpts': []
        }
    cursor.close()
    return _moderation_rows_to_dict(mod_comments, mod_ptpts)


def _moderation_rows_to_dict(mod_comments, mod_ptpts):
    """Shared transformation for stage-1 moderation — live and snapshot paths
    both route through here. The mod == '-1' / mod == '1' comparisons match
    an INTEGER column against STRINGS and never fire; that is production
    behavior, reproduced deliberately (see _comment_rows_to_dicts)."""
    mod_out_tids = [str(c['tid']) for c in mod_comments if c['mod'] == '-1']
    mod_in_tids = [str(c['tid']) for c in mod_comments if c['mod'] == '1']
    meta_tids = [str(c['tid']) for c in mod_comments if c['is_meta']]
    mod_out_ptpts = [str(p['pid']) for p in mod_ptpts]
    return {
        'mod_out_tids': mod_out_tids,
        'mod_in_tids': mod_in_tids,
        'meta_tids': meta_tids,
        'mod_out_ptpts': mod_out_ptpts
    }


def moderation_from_snapshot(reader):
    """Stage-1 moderation fed from a snapshot (--input-source seam, P6b)."""
    mod_comments, mod_ptpts = reader.stage1_moderation_rows()
    return _moderation_rows_to_dict(mod_comments, mod_ptpts)


import sys


def memory_usage_mb(obj, seen=None):
    return memory_usage(obj) / (1024 * 1024)


def memory_usage(obj, seen=None):
    """Recursively calculate size of objects"""
    size = sys.getsizeof(obj)
    if seen is None:
        seen = set()

    obj_id = id(obj)
    if obj_id in seen:
        return 0

    # Mark as seen to avoid counting duplicates
    seen.add(obj_id)

    # Handle different types
    if isinstance(obj, dict):
        size += sum(memory_usage(v, seen) for v in obj.values())
        size += sum(memory_usage(k, seen) for k in obj.keys())
    elif hasattr(obj, "__dict__"):
        size += memory_usage(obj.__dict__, seen)
    elif hasattr(obj, '__iter__') and not isinstance(obj, (str, bytes, bytearray)):
        size += sum(memory_usage(i, seen) for i in obj)

    return size


def main():
    parser = argparse.ArgumentParser(description='Run math pipeline for a Polis conversation')
    parser.add_argument('--zid', type=int, required=True, help='Conversation ID to process')
    parser.add_argument('--max-votes', type=int, default=None, 
                        help='Maximum number of votes to process (for testing)')
    parser.add_argument('--batch-size', type=int, default=50000, 
                        help='Batch size for vote processing (default: 50000)')
    parser.add_argument('--job-id', dest='job_id', default=None,
                        help='Pipeline job id (Storage V2 provenance, design §4.4); defaults to DELPHI_JOB_ID env, else auto local-<uuid4>')
    parser.add_argument('--input-source', dest='input_source', default=None,
                        help='Read inputs from a recorded snapshot instead of live PG: '
                             'store://<job_id> (Storage V2 P6b seam; used by replay)')
    args = parser.parse_args()

    from delphi_storage.job_id import resolve_job_id
    job_id = resolve_job_id(args.job_id)
    logger.info(f"Pipeline job id: {job_id}")

    zid = args.zid
    start_time = time.time()
    logger.info(f"[{time.time() - start_time:.2f}s] Starting math pipeline for conversation {zid}")

    # Import polismath modules
    from polismath.conversation.conversation import Conversation

    # Input source: live PG (production) or a recorded snapshot (replay seam)
    snapshot_reader = None
    conn = None
    if args.input_source:
        from delphi_storage import get_store
        from delphi_storage.inputs import SnapshotReader, parse_input_source
        source_job_id = parse_input_source(args.input_source)
        logger.info(f"[{time.time() - start_time:.2f}s] Reading inputs from snapshot of job {source_job_id} (no live PG)")
        snapshot_reader = SnapshotReader(get_store(), source_job_id)
    else:
        # Connect to database
        logger.info(f"[{time.time() - start_time:.2f}s] Connecting to database...")
        conn = connect_to_db()
        if not conn:
            logger.error(f"[{time.time() - start_time:.2f}s] Database connection failed")
            sys.exit(1)

    try:
        logger.info(f"[{time.time() - start_time:.2f}s] Creating conversation object for zid: {zid}")
        conv = Conversation(str(zid))

        logger.info(f"[{time.time() - start_time:.2f}s] Fetching comments...")
        comments = comments_from_snapshot(snapshot_reader) if snapshot_reader else fetch_comments(conn, zid)
        logger.info(f"[{time.time() - start_time:.2f}s] {len(comments['comments'])} comments fetched")

        logger.info(f"[{time.time() - start_time:.2f}s] Fetching moderation data...")
        moderation = moderation_from_snapshot(snapshot_reader) if snapshot_reader else fetch_moderation(conn, zid)
        logger.info(f"[{time.time() - start_time:.2f}s] Moderation data fetched")

        conv = conv.update_moderation(moderation, recompute=False)
        logger.info(f"[{time.time() - start_time:.2f}s] Moderation applied")

        if snapshot_reader:
            total_votes = snapshot_reader.vote_count()
        else:
            cursor = conn.cursor()
            cursor.execute(VOTES_COUNT_SQL, (zid,))
            total_votes = cursor.fetchone()[0]
            cursor.close()
        logger.info(f"[{time.time() - start_time:.2f}s] {total_votes} total votes")

        # Get batch size from command line arguments
        batch_size = args.batch_size
        logger.info(f"[{time.time() - start_time:.2f}s] Using batch size of {batch_size}")
        
        # Get max votes to process from command line arguments
        max_votes_to_process = args.max_votes if args.max_votes is not None else total_votes
        if max_votes_to_process < total_votes:
            logger.info(f"[{time.time() - start_time:.2f}s] Limiting to {max_votes_to_process} votes (out of {total_votes} total)")
        else:
            logger.info(f"[{time.time() - start_time:.2f}s] Processing all {total_votes} votes")
        
        for offset in range(0, min(total_votes, max_votes_to_process), batch_size):
            batch_start_time = time.time()
            end_idx = min(offset+batch_size, total_votes, max_votes_to_process)
            logger.info(f"[{time.time() - start_time:.2f}s] Processing votes {offset+1} to {end_idx} of {total_votes}")
            
            if snapshot_reader:
                vote_batch = snapshot_reader.vote_batch(offset, batch_size)
            else:
                cursor = conn.cursor()
                cursor.execute(VOTES_BATCH_SQL, (zid, batch_size, offset))
                vote_batch = cursor.fetchall()
                cursor.close()

            db_fetch_time = time.time()
            logger.info(f"[{time.time() - start_time:.2f}s] Database fetch completed in {db_fetch_time - batch_start_time:.2f}s")
            
            votes_list = []
            for vote in vote_batch:
                created_time = int(float(vote[0]) * 1000) if vote[0] else None
                votes_list.append({
                    'pid': str(vote[2]),
                    'tid': str(vote[1]),
                    'vote': float(vote[3]),
                    'created': created_time
                })
            
            transform_time = time.time()
            logger.info(f"[{time.time() - start_time:.2f}s] Data transformation completed in {transform_time - db_fetch_time:.2f}s")
            logger.info(f"[{time.time() - start_time:.2f}s] Size of votes list of dict: {memory_usage_mb(votes_list):.2f} MB")
            
            batch_votes = {'votes': votes_list}
            update_start = time.time()
            conv = conv.update_votes(batch_votes, recompute=False)
            update_end = time.time()
            
            logger.info(f"[{time.time() - start_time:.2f}s] Vote update completed in {update_end - update_start:.2f}s")
            logger.info(f"[{time.time() - start_time:.2f}s] Total batch processing time: {time.time() - batch_start_time:.2f}s")
            mem_mb = conv.raw_rating_mat.memory_usage(deep=True).sum() / (1024 * 1024)
            logger.info(f"[{time.time() - start_time:.2f}s] Memory used by the matrix of votes so far: {mem_mb:.2f} MB")

        
        logger.info(f"[{time.time() - start_time:.2f}s] Running final computation with detailed timing...")
        
        # PCA computation
        pca_start = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] Starting PCA computation...")
        conv._compute_pca()
        pca_end = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] PCA computation completed in {pca_end - pca_start:.2f}s")
        
        # Clustering computation
        cluster_start = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] Starting clustering computation...")
        conv._compute_clusters()
        cluster_end = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] Clustering computation completed in {cluster_end - cluster_start:.2f}s")
        
        # Representativeness computation
        repness_start = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] Starting representativeness computation...")
        conv._compute_repness()
        repness_end = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] Representativeness computation completed in {repness_end - repness_start:.2f}s")
        
        # Participant info computation
        info_start = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] Starting participant info computation...")
        conv._compute_participant_info()
        info_end = time.time()
        logger.info(f"[{time.time() - start_time:.2f}s] Participant info computation completed in {info_end - info_start:.2f}s")
        
        logger.info(f"[{time.time() - start_time:.2f}s] All computations complete! Total computation time: {time.time() - pca_start:.2f}s")

        logger.info(f"[{time.time() - start_time:.2f}s] Results:")
        logger.info(f"Groups: {len(conv.group_clusters)}")
        logger.info(f"Comments: {conv.comment_count}")
        logger.info(f"Participants: {conv.participant_count}")
        if conv.repness and 'comment_repness' in conv.repness:
            logger.info(f"Representativeness for {len(conv.repness['comment_repness'])} comments")

        # Save results to DynamoDB using the DynamoDBClient, as in the Pakistan test
        try:
            logger.info(f"[{time.time() - start_time:.2f}s] Initializing DynamoDB client...")
            from polismath.database.dynamodb import DynamoDBClient

            # Use environment variables or sensible defaults for local/test
            endpoint_url = os.environ.get('DYNAMODB_ENDPOINT')
            region_name = os.environ.get('AWS_REGION', 'us-east-1')
            aws_access_key_id = os.environ.get('AWS_ACCESS_KEY_ID', 'dummy')
            aws_secret_access_key = os.environ.get('AWS_SECRET_ACCESS_KEY', 'dummy')
            dynamodb_client = DynamoDBClient(
                endpoint_url=endpoint_url,
                region_name=region_name,
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key
            )
            dynamodb_client.initialize()
            logger.info(f"[{time.time() - start_time:.2f}s] DynamoDB client initialized")
            logger.info(f"[{time.time() - start_time:.2f}s] Exporting conversation to DynamoDB...")
            success = conv.export_to_dynamodb(dynamodb_client)
            logger.info(f"[{time.time() - start_time:.2f}s] Export to DynamoDB {'succeeded' if success else 'failed'}")
        except Exception as e:
            logger.error(f"[{time.time() - start_time:.2f}s] Error exporting to DynamoDB: {e}")
            import traceback

            traceback.print_exc()

    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
    finally:
        if conn:
            conn.close()
        logger.info(f"[{time.time() - start_time:.2f}s] Database connection closed")


if __name__ == "__main__":
    main()
