#!/usr/bin/env python3
"""Entry binary for analyzing polis math data"""

import os
import sys
import polars as pl
import click
from datetime import datetime
import pytz
import json
import logging
from dotenv import load_dotenv, find_dotenv
from functools import wraps
from repness import get_votes_matrix, compute_group_repness, select_rep_comments

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
# By default searches up directory tree for .env file
dotenv_path = find_dotenv()
if dotenv_path:
    logger.debug(f"Loading environment variables from: {dotenv_path}")
    load_dotenv(dotenv_path)
else:
    logger.debug("No .env file found")


def get_db_connection():
    """Create database connection string using environment variables."""
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise ValueError("DATABASE_URL environment variable not set")
    return db_url


def get_sanitized_db_url(db_url):
    """Return database URL with password masked."""
    try:
        # Handle both formats: postgres://user:pass@host:port/db and postgresql://user:pass@host:port/db
        if '://' not in db_url:
            return 'Invalid database URL format'
        
        parts = db_url.split('@')
        if len(parts) != 2:
            return 'Invalid database URL format'
            
        credentials = parts[0].split('://')[-1]
        if ':' in credentials:
            user = credentials.split(':')[0]
        else:
            user = credentials
            
        host_part = parts[1]
        
        return f"postgres://{user}:***@{host_part}"
    except Exception:
        return 'Could not parse database URL'


def get_conversation_info(db_url, zid):
    """Get conversation topic and other metadata."""
    query = f"SELECT topic FROM conversations WHERE zid = {zid}"
    df = pl.read_database_uri(query=query, uri=db_url)
    if len(df) == 0:
        return "Unknown Topic"
    return df[0, "topic"]


def get_math_data(db_url, zid):
    """Get math data for a conversation."""
    query = f"""
    SELECT data as json_blob, math_tick, last_vote_timestamp, modified 
    FROM math_main 
    WHERE zid = {zid}
    """
    df = pl.read_database_uri(query=query, uri=db_url)
    if len(df) == 0:
        raise ValueError(f"No math data found for zid: {zid}")
    return df.row(0)


def timestamp_to_datetime(ts):
    """Convert a millisecond timestamp to datetime object in CST."""
    if ts is None:
        return None
    utc_dt = datetime.fromtimestamp(ts / 1000.0, tz=pytz.UTC)
    cst = pytz.timezone("America/Chicago")
    return utc_dt.astimezone(cst)


def convert_json_numeric_strings(obj):
    """Recursively process JSON data to convert numeric strings to integers.
    
    This mimics the behavior of Clojure's cheshire.core/parse-string function,
    which automatically converts string values to integers when possible.
    While JSON parsing handles numbers in the data automatically, we still need
    this for any numbers that were explicitly stored as strings in the JSON.
    """
    if isinstance(obj, dict):
        return {k: convert_json_numeric_strings(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_json_numeric_strings(x) for x in obj]
    elif isinstance(obj, str):
        try:
            # Only convert strings that look like integers
            if obj.isdigit() or (obj[0] == '-' and obj[1:].isdigit()):
                return int(obj)
            return obj
        except (ValueError, IndexError):
            return obj
    return obj


def parse_json(data):
    """Parse JSON data, attempting to convert numeric strings to integers.
    
    First uses standard JSON parsing which handles actual JSON numbers,
    then applies our custom converter for any numbers that were stored as strings.
    """
    try:
        # Parse JSON normally - this handles all actual JSON numbers
        parsed = json.loads(data)
        # Then handle any remaining string numbers
        return convert_json_numeric_strings(parsed)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON data: {e}")


def analyze_math_data(data_json):
    """Analyze the math data and return key statistics."""
    data = parse_json(data_json)

    # Print all top-level keys in the math data
    print("\nMath data keys:")
    for key in data.keys():
        print(f"- {key}")
    stats = {
        "n_groups": len(data.get("group-clusters", [])),
        "n_comments": len(data.get("tids", [])),
    }

    # Count total participants across all groups
    group_stats = {}
    for group in data.get("group-clusters", []):
        group_id = group.get("id", "unknown")
        members = group.get("members", [])
        group_stats[f"group_{group_id}_size"] = len(members)

    stats.update(group_stats)
    return stats


def common_args(f):
    """Decorator to handle common command arguments."""
    @click.argument("zid", type=int, required=False)
    @click.option(
        "--db-uri",
        "-d",
        help="Database URI. If not provided, will use DATABASE_URL environment variable.",
        envvar="DATABASE_URL",
    )
    @wraps(f)
    def wrapper(zid, db_uri, *args, **kwargs):
        try:
            if not db_uri:
                db_uri = get_db_connection()
                
            # Display database connection info (sanitized)
            click.echo(f"\nConnecting to: {get_sanitized_db_url(db_uri)}")

            # If no ZID provided, check DEFAULT_ZID env variable
            if zid is None:
                default_zid = os.getenv("DEFAULT_ZID")
                if not default_zid:
                    logger.debug("No ZID provided via CLI and DEFAULT_ZID environment variable not set")
                    raise ValueError("No ZID provided and DEFAULT_ZID environment variable not set")
                try:
                    zid = int(default_zid)
                    logger.debug(f"Using ZID {zid} from DEFAULT_ZID environment variable")
                except ValueError:
                    logger.debug(f"Invalid DEFAULT_ZID value: {default_zid}")
                    raise ValueError("DEFAULT_ZID environment variable must be a valid integer")
            else:
                logger.debug(f"Using ZID {zid} provided via CLI argument")

            return f(zid, db_uri, *args, **kwargs)
        except KeyboardInterrupt:
            click.echo("\nOperation cancelled by user", err=True)
            sys.exit(130)
        except Exception as e:
            logger.exception("Error in command execution:")  # This will log the full traceback
            click.echo(f"Error: {e}", err=True)
            sys.exit(1)
    return wrapper


@click.group()
def main():
    """Analyze polis math data."""
    pass


@main.command()
@common_args
def peek_json(zid, db_uri):
    """
    Get math statistics for a Polis conversation.
    """
    # Get conversation topic
    topic = get_conversation_info(db_uri, zid)

    # Get math data
    json_blob, math_tick, last_vote_ts, modified_ts = get_math_data(db_uri, zid)

    # Analyze the data
    stats = analyze_math_data(json_blob)

    # Display results
    click.echo("\nMath Statistics:")
    click.echo("---------------")
    click.echo(f"Topic: {topic}")
    click.echo(f"Math tick: {math_tick}")
    click.echo(f"Last vote: {timestamp_to_datetime(last_vote_ts)}")
    click.echo(f"Last modified: {timestamp_to_datetime(modified_ts)}")
    click.echo("\nClustering Statistics:")
    click.echo("---------------------")
    click.echo(f"Number of groups: {stats['n_groups']}")
    click.echo(f"Number of comments: {stats['n_comments']}")
    click.echo("\nGroup Sizes:")
    click.echo("------------")
    for key, value in stats.items():
        if key.startswith("group_"):
            group_id = key.split("_")[1]
            click.echo(f"Group {group_id}: {value} participants")

    # Save raw data to file for further analysis if needed
    output_file = f"{zid}_math_data.json"
    with open(output_file, "w") as f:
        json.dump(parse_json(json_blob), f, indent=2)
    click.echo(f"\nRaw math data saved to: {output_file}")


@main.command()
@common_args
def compute_repness(zid, db_uri):
    """
    Compute the representativeness of comments for each group in a conversation.
    """
    # Get math data to extract clusters
    json_blob, _, _, _ = get_math_data(db_uri, zid)
    math_data = parse_json(json_blob)
    
    # Get clusters from math data
    group_clusters = math_data.get("group-clusters", [])
    base_clusters = math_data.get("base-clusters", [])
    
    # Debug logging
    logger.debug("Group clusters: %s", group_clusters)
    logger.debug("Base clusters: %s", base_clusters)
    
    if not group_clusters:
        click.echo("No group clusters found in math data")
        return
        
    # Get votes matrix
    votes_matrix = get_votes_matrix(db_uri, zid)
    
    # Analyze repness for all groups
    repness_stats = compute_group_repness(votes_matrix, group_clusters, base_clusters)
    
    # Select representative comments
    rep_comments = select_rep_comments(repness_stats)
        
    # Display results
    click.echo("\nRepresentative Comments Analysis:")
    click.echo("--------------------------------")
    for group_id, comments in rep_comments.items():
        click.echo(f"\nGroup {group_id}:")
        for comment in comments:
            click.echo(f"Comment {comment['tid']}:")
            click.echo(f"  Type: {comment['repful_for']}")
            click.echo(f"  Success: {comment['n_success']}/{comment['n_trials']} ({comment['p_success']:.2f})")
            click.echo(f"  Repness: {comment['repness']:.2f} (z={comment['repness_test']:.2f})")
            if 'best_agree' in comment:
                click.echo("  (Best agree comment)")


if __name__ == "__main__":
    main()
