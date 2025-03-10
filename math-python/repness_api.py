#!/usr/bin/env python
# coding: utf-8


import pandas as pd
import numpy as np
import os
import dotenv
import click
import json
from flask import Flask, jsonify, request
from scipy.stats import hypergeom
import logging

# Configure logging
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger.info("Logging configured")

# Load environment variables
dotenv.load_dotenv()
DB_URL = os.getenv("DATABASE_URL")
logger.info(f"Database URL configured: {'YES' if DB_URL else 'NO'}")

# Initialize Flask app
app = Flask(__name__)

def fix_postgres_url_for_sqlalchemy(db_url):
    if db_url and db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://", 1)
    return db_url

def get_math_blob(db_url, zid):
    db_url = fix_postgres_url_for_sqlalchemy(db_url)
    logger.debug(f"Fetching math blob for zid: {zid}")

    """Get math data for a conversation."""
    query = f"""
    SELECT data as json_blob, math_tick, last_vote_timestamp, modified 
    FROM math_main 
    WHERE zid = {zid}
    """
    df = pd.read_sql(query, db_url)
    if len(df) == 0:
        raise ValueError(f"No math data found for zid: {zid}")
    return df.iloc[0]["json_blob"]


def get_groups(db_url, zid):
    db_url = fix_postgres_url_for_sqlalchemy(db_url)
    # Get math data to extract clusters
    math_data = get_math_blob(db_url, zid)

    # Get clusters from math data
    group_clusters = math_data.get("group-clusters", [])
    base_clusters = math_data.get("base-clusters", {})

    # Create a mapping from cluster ID to index in the array
    cluster_id_to_index = {cluster_id: idx for idx, cluster_id in enumerate(base_clusters["id"])}

    # Collect all participants for each group based on their associated base clusters
    group_ptpts = []
    for group in group_clusters:
        group_ptpt_set = set()
        for cluster_id in group["members"]:
            # Find the index for this cluster ID in the parallel arrays
            if cluster_id in cluster_id_to_index:
                cluster_index = cluster_id_to_index[cluster_id]
                # Add the participants from this cluster to the group
                if cluster_index < len(base_clusters["members"]):
                    group_ptpt_set.update(base_clusters["members"][cluster_index])
                else:
                    raise ValueError(
                        f"Cluster index {cluster_index} out of bounds for members array of length {len(base_clusters['members'])}"
                    )
            else:
                raise ValueError(f'Cluster ID {cluster_id} not found in base_clusters["id"]')

        group_ptpts.append(list(group_ptpt_set))
    return group_ptpts


def get_data_from_db(db_url, zid):
    logger.debug(f"Getting data from DB for zid: {zid}")
    db_url = fix_postgres_url_for_sqlalchemy(db_url)

    try:
        logger.debug("Fetching votes data")
        votes_query = f"""SELECT 
        pid as "participant", 
        tid as "comment-id", 
        created as "timestamp",
        -1*vote as "vote"
        FROM votes WHERE zid = {zid} ORDER BY pid, tid"""
        votes_df = pd.read_sql(votes_query, con=db_url)
        logger.debug(f"Retrieved {len(votes_df)} vote records")

        # Check for duplicate participant-comment pairs and only keep the latest vote
        # First sort the dataframe by timestamp, then group and keep the last entry in each group
        votes_df = votes_df.sort_values(by="timestamp", ascending=True)
        original_len = len(votes_df)
        votes_df = votes_df.drop_duplicates(subset=["participant", "comment-id"], keep="last")
        logger.debug(f"Removed {original_len - len(votes_df)} duplicate votes")

        logger.debug("Fetching comments data")
        query = f"""SELECT 
            tid AS "comment-id",
            created AS "timestamp", 
            pid AS "author-id",
            mod as "moderated"
        FROM comments WHERE zid = {zid} ORDER BY "comment-id" DESC"""
        comments_df = pd.read_sql(query, con=db_url)
        logger.debug(f"Retrieved {len(comments_df)} comment records")

        # Group votes by comment-id and vote value, then pivot to get counts for each vote type
        vote_counts = votes_df.groupby(["comment-id", "vote"]).size().reset_index(name="count")

        # Pivot the table to have separate columns for each vote value
        vote_counts_pivot = vote_counts.pivot(
            index="comment-id", columns="vote", values="count"
        ).reset_index()

        # Rename columns for clarity
        vote_counts_pivot.columns = ["comment-id", "disagrees", "pass", "agrees"]
        # Drop the 'pass' column
        vote_counts_pivot = vote_counts_pivot.drop(columns=["pass"])

        # Merge comments with vote counts
        comments_df = comments_df.merge(vote_counts_pivot, on="comment-id", how="left")

        # Pivot the votes dataframe to have participants as rows and comments as columns
        votes_pivot_df = votes_df.pivot(index="participant", columns="comment-id", values="vote")

        # Convert vote values to integers
        for col in votes_pivot_df.columns[1:]:
            votes_pivot_df[col] = votes_pivot_df[col].astype(float)

        # Create a dataframe to store participant statistics
        participant_stats = pd.DataFrame(index=votes_pivot_df.index)

        # Count the number of votes for each participant (excluding NaN values)
        participant_stats["n-votes"] = votes_pivot_df.count(axis=1)

        # Count the number of agrees (vote=1) for each participant
        participant_stats["n-agree"] = (votes_pivot_df == 1).sum(axis=1)

        # Count the number of disagrees (vote=-1) for each participant
        participant_stats["n-disagree"] = (votes_pivot_df == -1).sum(axis=1)

        # Count the number of comments authored by each participant
        # First, create a Series counting comments per author
        comment_counts = comments_df.groupby("author-id").size()

        # Add the comment counts to participant_stats, filling NaN values with 0
        # (participants who didn't author any comments)
        participant_stats["n-comments"] = (
            participant_stats.index.map(lambda x: comment_counts.get(x, 0)).fillna(0).astype(int)
        )

        # Add a placeholder for group-id (will be filled later)
        participant_stats["group-id"] = np.nan

        # Reorder columns to have group-id first, followed by statistics
        participant_stats = participant_stats[
            ["group-id", "n-comments", "n-votes", "n-agree", "n-disagree"]
        ]
        # Add the participant stats to the votes_pivot_df
        votes_pivot_df = pd.concat([participant_stats, votes_pivot_df], axis=1)

        logger.debug("Getting groups from math blob")
        groups = get_groups(db_url, zid)
        logger.debug(f"Retrieved {len(groups)} groups")
        
        # Update group-id column based on the groups list
        # Initialize all group-ids as NaN
        votes_pivot_df["group-id"] = np.nan

        # For each group index and its participants
        for group_idx, participants in enumerate(groups):
            # Set the group-id for all participants in this group
            votes_pivot_df.loc[votes_pivot_df.index.isin(participants), "group-id"] = float(group_idx)

        logger.debug("Successfully prepared data from database")
        return votes_pivot_df, comments_df
    except Exception as e:
        logger.error(f"Error getting data from DB: {str(e)}")
        raise


def calculate_vote_statistics(df, vals_all_in, statements_all_in):
    """
    Calculate vote statistics for each group, comment, and vote value.

    Note: moderated-out comments must have been removed from the statements_all_in list before calling this function

    Args:
        df: DataFrame with participant data including group-id
        vals_all_in: DataFrame with vote values for each participant and comment
        statements_all_in: List of comment IDs to analyze

    Returns:
        tuple: (R_v_g_c, P_v_g_c, N_v_g_c, R_v_g_c)
            R_v_g_c: Representativeness metric
            P_v_g_c: Probability of vote v in group g for comment c
            N_v_g_c: Count of votes of value v in group g for comment c
    """
    logger.debug("Calculating vote statistics")
    N_groups = df["group-id"].nunique()
    N_comments = len(statements_all_in)
    N_v_g_c = np.zeros([3, N_groups, N_comments])  # create N matrix
    P_v_g_c = np.zeros([3, N_groups, N_comments])
    N_g_c = np.zeros([N_groups, N_comments])
    v_values = [-1, 0, 1]

    # Step 1: Calculate N_v(g,c), N(g,c), and P_v(g,c)
    for g in range(N_groups):
        # get indices of cluster g; caution_ idx != participant id
        idx_g = np.where(df["group-id"] == g)[0]
        for c in range(N_comments):
            comment = statements_all_in[c]  # comment id
            df_c = vals_all_in[str(comment)].iloc[
                idx_g
            ]  # data frame: [participants of group g,comment c],
            for v in range(3):
                v_value = v_values[v]
                N_v_g_c[v, g, c] = (
                    df_c == v_value
                ).sum()  # counts all v_value votes in data frame df_c
            N_g_c[g, c] = (
                N_v_g_c[0, g, c] + N_v_g_c[2, g, c]
            )  # total votes corresponds to votes with +1 or -1

            for v in range(3):
                P_v_g_c[v, g, c] = (1 + N_v_g_c[v, g, c]) / (2 + N_g_c[g, c])

    # Step 2: calculate R_v(g,c)
    R_v_g_c = np.zeros([3, N_groups, N_comments])
    for g in range(N_groups):
        for c in range(N_comments):
            for v in range(3):
                R_v_g_c[v, g, c] = (
                    P_v_g_c[v, g, c] / np.delete(P_v_g_c[v, :, c], g, 0).sum()
                )  # np.delete neglects all entries with group g

    return R_v_g_c, P_v_g_c, N_v_g_c


def calculate_significance(df, vals_all_in, statements_all_in, R_v_g_c):
    """
    Calculate significance of representativeness using Fisher exact test.
    
    Use `calculate_vote_statistics` to calculate R_v_g_c first.
    Note: moderated-out comments must have been removed from the statements_all_in list before calling this function
    
    Args:
        df: DataFrame with participant data including group-id
        vals_all_in: DataFrame with vote values for each participant and comment
        statements_all_in: List of comment IDs to analyze
        R_v_g_c: Representativeness metric from calculate_vote_statistics
        N_groups: Number of groups
        N_comments: Number of comments
        
    Returns:
        numpy.ndarray: p_values array with shape [N_groups, N_comments, 3]
    """
    logger.debug("Calculating significance with Fisher exact test")
    N_groups = df["group-id"].nunique()
    N_comments = len(statements_all_in)
    v_values = [-1, 0, 1]
    p_values = np.zeros([N_groups, N_comments, 3])
    
    for g in range(N_groups):
        idx_g = np.where(df["group-id"] == g)[0]
        idx_g_not = np.where(df["group-id"] != g)[0]
        for c in range(N_comments):
            comment = statements_all_in[c]  # comment id

            for v in range(3):
                v_value = v_values[v]
                N_v = (
                    vals_all_in[str(comment)] == v_value
                ).sum()  # total number of v votes in comment c
                N_rest = (
                    vals_all_in[str(comment)]
                ).count() - N_v  # total number of votes = number of participants

                df_c = vals_all_in[str(comment)].iloc[idx_g]  # get data frame of group g for comment c
                N_v_in_g = (df_c == v_value).sum()
                N_g = (df_c).count()

                [M, n, N] = [
                    N_rest + N_v,
                    N_v,
                    N_g,
                ]  # hypergeometric distribution parameters
                x = range(N_v_in_g - 1, N_g + 1)
                prb = hypergeom.pmf(x, M, n, N).sum()  # calculates P(X>=N_v_in_g), i.e. p-value.
                p_values[g, c, v] = prb * R_v_g_c[v, g, c]
    
    return p_values


def calculate_repness(db_url, zid):
    """Calculate representativeness data for a given conversation ID"""
    logger.info(f"Starting representativeness calculation for zid: {zid}")
    try:
        df, df_comments = get_data_from_db(db_url, zid)
        df_comments.index = df_comments.index.astype(str)
        
        metadata_fields = ["group-id", "n-comments", "n-votes", "n-agree", "n-disagree"]
        val_fields = [c for c in df.columns.values if c not in metadata_fields]
        logger.debug(f"Found {len(val_fields)} value fields for calculation")

        # remove statements (columns) which were moderated out
        statements_all_in = sorted(list(df_comments.loc[df_comments["moderated"] > 0].index.array), key=int)
        logger.debug(f"Found {len(statements_all_in)} moderated statements to include")

        def select_rows(df, threshold=7):
            logger.debug(f"Selecting rows with at least {threshold} votes")
            valid = df["n-votes"] >= threshold
            logger.debug(f"Selected {valid.sum()} participants out of {len(df)}")
            return df[valid]

        # REMOVE PARTICIPANTS WITH LESS THAN N VOTES check for each row if the number of finite values >= cutoff
        df = select_rows(df)

        # Compare statements_all_in and val_fields using set operations
        statements_set = set(statements_all_in)
        val_fields_set = set([str(x) for x in val_fields])
        
        statements_in_val_fields = statements_set.intersection(val_fields_set)
        statements_not_in_val_fields = statements_set - val_fields_set
        val_fields_not_in_statements = val_fields_set - statements_set
        
        logger.debug(f"Statements in val_fields: {len(statements_in_val_fields)}")
        logger.debug(f"Statements not in val_fields: {len(statements_not_in_val_fields)}")
        logger.debug(f"Val fields not in statements: {len(val_fields_not_in_statements)}")
        
        if statements_not_in_val_fields:
            logger.warning(f"Some moderated statements are not in val_fields: {statements_not_in_val_fields}")
        if val_fields_not_in_statements:
            logger.debug(f"Some val_fields are not in moderated statements (may be normal): {list(val_fields_not_in_statements)[:5]}...")
        vals = df[val_fields]
        # If the participant didn't see the statement, it's a null value, here we fill in the nulls with zeros
        null_count_before = vals.isnull().sum().sum()
        vals = vals.fillna(0)  # <---in paper: column mean
        logger.debug(f"Filled {null_count_before} null values with zeros")
        vals = vals.sort_values("participant")
        vals.columns = vals.columns.astype(str)
        vals_all_in = vals[statements_all_in]

        # Calculate vote statistics and representativeness
        R_v_g_c, _, _ = calculate_vote_statistics(
            df, vals_all_in, statements_all_in
        )
        
        # Calculate significance using Fisher exact test
        p_values = calculate_significance(
            df, vals_all_in, statements_all_in, R_v_g_c
        )

        logger.info("Representativeness calculation completed successfully")
        N_groups = df["group-id"].nunique()
        representativeness_data = {
            "vote_idx": [-1, 0, 1],
            "groups_idx": list(range(0, N_groups)),
            "statements_idx": [int(i) for i in statements_all_in],
            # Nested lists in order: groups, statements, vote_values
            "repness-p-values": p_values.tolist()
        }
        
        return representativeness_data
    except Exception as e:
        logger.error(f"Error in representativeness calculation: {str(e)}", exc_info=True)
        raise


@app.route('/repness', methods=['GET', 'POST'])
def repness():
    """API endpoint to get representativeness data for a conversation"""
    # Get zid from either URL parameters (GET) or JSON body (POST)
    request_id = id(request)
    logger.info(f"Request {request_id}: Received {request.method} request to /repness endpoint")
    
    if request.method == 'GET':
        zid = request.args.get('zid')
        logger.debug(f"Request {request_id}: GET with zid={zid}")
    else:  # POST
        logger.debug(f"Request {request_id}: POST with body={request.data}")
        zid = request.json.get('zid') if request.json else None
        logger.debug(f"Request {request_id}: Extracted zid={zid} from JSON body")
    
    # Validate ZID
    if not zid:
        logger.warning(f"Request {request_id}: Missing required parameter: zid")
        return jsonify({"error": "Missing required parameter: zid"}), 400
    
    try:
        # Get database URL from environment or use the provided one
        db_url = DB_URL
        if not db_url:
            logger.error(f"Request {request_id}: Database URL not configured")
            return jsonify({"error": "Database URL not configured"}), 500
        
        # Calculate representativeness data
        logger.info(f"Request {request_id}: Calculating representativeness for zid={zid}")
        result = calculate_repness(db_url, zid)
        logger.info(f"Request {request_id}: Calculation successful, returning result")
        return jsonify(result)
    
    except ValueError as e:
        logger.error(f"Request {request_id}: ValueError: {str(e)}")
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        logger.error(f"Request {request_id}: Unhandled exception: {str(e)}", exc_info=True)
        return jsonify({"error": f"An error occurred: {str(e)}"}), 500


@click.group()
def cli():
    """CLI tool for calculating representativeness metrics."""
    pass

@cli.command()
@click.argument('zid', type=int)
@click.option('--output', '-o', type=click.Path(), help='Save results to a JSON file')
@click.option('--pretty', '-p', is_flag=True, help='Print results in a pretty format')
def repness_calc(zid, output, pretty):
    """Calculate representativeness metrics for a conversation.
    
    ZID is the conversation ID to analyze.
    """
    logger.info(f"CLI: Calculating representativeness for zid={zid}")
    
    try:
        # Get database URL from environment
        db_url = DB_URL
        if not db_url:
            logger.error("CLI: Database URL not configured")
            click.echo("Error: Database URL not configured. Please set DATABASE_URL environment variable.")
            return
        
        # Calculate representativeness data
        result = calculate_repness(db_url, zid)
        
        # Handle output
        if output:
            with open(output, 'w') as f:
                json.dump(result, f, indent=2 if pretty else None)
            click.echo(f"Results saved to {output}")
        else:
            if pretty:
                click.echo(json.dumps(result, indent=2))
            else:
                click.echo(json.dumps(result))
        
        logger.info("CLI: Calculation completed successfully")
        
    except ValueError as e:
        logger.error(f"CLI: ValueError: {str(e)}")
        click.echo(f"Error: {str(e)}")
    except Exception as e:
        logger.error(f"CLI: Unhandled exception: {str(e)}", exc_info=True)
        click.echo(f"Error: An unexpected error occurred: {str(e)}")


# If this file is run directly, start the Flask app or CLI based on arguments
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] != "run":
        # If arguments are provided and first arg is not "run", use CLI
        cli()
    else:
        # Otherwise start the Flask app
        logger.info("Starting Flask application")
        PORT = 5017
        
        # Check if we're in development mode
        if os.getenv("FLASK_ENV") == "dev":
            # Use Flask's development server with its helpful features
            app.run(debug=True, host='0.0.0.0', port=PORT)
        else:
            # Use Waitress for production or testing production-like conditions
            import waitress
            logger.info("Starting production server with Waitress")
            waitress.serve(app, host='0.0.0.0', port=PORT) 
