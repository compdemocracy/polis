"""Module for computing representative comments in Polis conversations"""

import numpy as np
import polars as pl
from scipy import stats
import logging

logger = logging.getLogger(__name__)

# Ports stats/z-sig-90? from math/stats.clj
def z_sig_90(z_score):
    """Check if z-score is significant at 90% level"""
    return z_score > 1.2816  # 90% confidence level

# Ports stats/prop-test from math/stats.clj
def prop_test(successes, trials):
    """Perform a proportion test, similar to the Clojure stats/prop-test"""
    if trials == 0:
        return 0
    # Match Clojure implementation: Increment both successes and trials by 1
    adjusted_successes = successes + 1
    adjusted_trials = trials + 1
    # Use exactly the same formula as Clojure: (* 2 (sqrt n) (+ (/ succ n) -0.5))
    return 2 * np.sqrt(adjusted_trials) * ((adjusted_successes / adjusted_trials) - 0.5)

# Ports stats/two-prop-test from math/stats.clj  
def two_prop_test(succ1, succ2, trials1, trials2):
    """Perform two-proportion z-test"""
    if trials1 == 0 or trials2 == 0:
        return 0
    # Match Clojure implementation: Increment all values by 1
    adj_succ1 = succ1 + 1
    adj_succ2 = succ2 + 1
    adj_trials1 = trials1 + 1
    adj_trials2 = trials2 + 1
    
    pi1 = adj_succ1 / adj_trials1
    pi2 = adj_succ2 / adj_trials2
    pi_hat = (adj_succ1 + adj_succ2) / (adj_trials1 + adj_trials2)
    
    if pi_hat == 1:
        return 0
    
    return (pi1 - pi2) / np.sqrt(pi_hat * (1 - pi_hat) * (1/adj_trials1 + 1/adj_trials2))

# Ports comment-stats from math/repness.clj using comment-stats-graphimpl
def comment_stats(vote_col):
    """Calculate statistics for a comment's votes within a group"""
    votes = np.array(vote_col)
    # Count agree (-1), disagree (1), and total non-zero votes
    na = np.sum(votes == -1)
    nd = np.sum(votes == 1)
    ns = np.sum(votes != 0)
    
    # Calculate probabilities with Laplace smoothing
    pa = (1 + na) / (2 + ns)
    pd = (1 + nd) / (2 + ns)
    
    # Calculate z-scores
    pat = prop_test(na, ns)
    pdt = prop_test(nd, ns)
    
    return {
        "na": na, "nd": nd, "ns": ns,
        "pa": pa, "pd": pd,
        "pat": pat, "pdt": pdt
    }

# Ports add-comparitive-stats from math/repness.clj
def add_comparative_stats(in_stats, rest_stats):
    """Add comparative statistics between groups"""
    sum_na = sum(s["na"] for s in rest_stats)
    sum_nd = sum(s["nd"] for s in rest_stats)
    sum_ns = sum(s["ns"] for s in rest_stats)
    
    # Calculate relative agree/disagree ratios
    ra = in_stats["pa"] / ((1 + sum_na) / (2 + sum_ns))
    rd = in_stats["pd"] / ((1 + sum_nd) / (2 + sum_ns))
    
    # Calculate z-scores for between-group comparisons
    rat = two_prop_test(in_stats["na"], sum_na, in_stats["ns"], sum_ns)
    rdt = two_prop_test(in_stats["nd"], sum_nd, in_stats["ns"], sum_ns)
    
    return {**in_stats, "ra": ra, "rd": rd, "rat": rat, "rdt": rdt}

def get_votes_matrix(db_uri, zid, mod_out=None):
    """Get the votes matrix from the database as a numpy array
    
    Returns a matrix where:
    - Rows correspond to participant IDs (PIDs) which are consecutive integers starting at 0
    - Columns correspond to comment IDs (TIDs) which are consecutive integers starting at 0
    - Cell values: -1 for agree, 1 for disagree, 0 for no vote
    
    Args:
        db_uri: Database connection URI
        zid: Conversation ID
        mod_out: Set of comment IDs to exclude (optional)
    """
    logger.debug(f"Fetching votes matrix for ZID {zid}")
    
    # Get maximum PIDs and TIDs to determine matrix dimensions
    pid_max_query = f"SELECT MAX(pid) as max_pid FROM votes WHERE zid = {zid}"
    tid_max_query = f"SELECT MAX(tid) as max_tid FROM votes WHERE zid = {zid}"
    
    pid_max_df = pl.read_database_uri(query=pid_max_query, uri=db_uri)
    tid_max_df = pl.read_database_uri(query=tid_max_query, uri=db_uri)
    
    # Handle null case safely
    max_pid = pid_max_df[0, 0] if not pid_max_df.is_empty() and pid_max_df[0, 0] is not None else 0
    max_tid = tid_max_df[0, 0] if not tid_max_df.is_empty() and tid_max_df[0, 0] is not None else 0
    
    logger.debug(f"Maximum PID: {max_pid}, Maximum TID: {max_tid}")
    
    # Initialize the votes matrix with zeros (no vote)
    # Since PIDs and TIDs start at 0, we need max+1 rows/columns
    votes_array = np.zeros((max_pid + 1, max_tid + 1), dtype=np.int32)
    
    # Get ALL votes (including zeros) - changed from previous version that filtered out zeros
    votes_query = f"SELECT pid, tid, vote FROM votes WHERE zid = {zid} ORDER BY pid, tid"
    votes_df = pl.read_database_uri(query=votes_query, uri=db_uri)
    
    # Fill in the votes matrix directly using PIDs and TIDs as indices
    for row in votes_df.iter_rows(named=True):
        pid, tid, vote = row["pid"], row["tid"], row["vote"]
        votes_array[pid, tid] = vote
    
    # Apply moderation if provided - zero out columns for moderated comments
    if mod_out:
        logger.debug(f"Zeroing out {len(mod_out)} moderated comments")
        mod_out_set = set(mod_out)
        for tid in mod_out_set:
            if tid < votes_array.shape[1]:
                votes_array[:, tid] = 0
    
    logger.debug(f"Retrieved votes matrix with shape {votes_array.shape}")
    return votes_array

# Ports beats-best-by-test? from math/repness.clj
def beats_best_by_test(comment_stats, current_best_z):
    """Check if this comment has a better repness test score than current best.
    
    Used to ensure we have at least one representative comment per group,
    even if none pass the more thorough filters.
    """
    return (current_best_z is None or 
            max(comment_stats["rat"], comment_stats["rdt"]) > current_best_z)

# Ports beats-best-agr? from math/repness.clj
def beats_best_agr(comment_stats, current_best):
    """Check if this comment has better agreement statistics than current best.
    
    Used to prioritize comments that show what the group agrees on.
    """
    # If no current best, this is best by default
    if not current_best:
        # Check if we have any agreement votes
        na = comment_stats.get("na", 0)
        nd = comment_stats.get("nd", 0)
        if na == 0 and nd == 0:
            return False
        # For raw stats, check if agree is better than disagree
        if "repful-for" in comment_stats:
            return comment_stats["repful-for"] == "agree"
        else:
            pa = comment_stats.get("pa", 0)
            pat = comment_stats.get("pat", 0)
            return z_sig_90(pat) or pa > 0.5
    
    # Handle finalized stats format
    if "repness" in current_best and "repness-test" in current_best and "p-success" in current_best and "p-test" in current_best:
        # For new comment in raw format
        if "repness" not in comment_stats and "ra" in comment_stats:
            # Extract values or use defaults
            ra = comment_stats.get("ra", 0)
            rat = comment_stats.get("rat", 0)
            pa = comment_stats.get("pa", 0)
            pat = comment_stats.get("pat", 0)
            
            # Compare using product
            current_product = (current_best["repness"] * 
                              current_best["repness-test"] * 
                              current_best["p-success"] * 
                              current_best["p-test"])
            new_product = ra * rat * pa * pat
            return new_product > current_product
        # For new comment in finalized format
        else:
            # Compare using product
            current_product = (current_best["repness"] * 
                              current_best["repness-test"] * 
                              current_best["p-success"] * 
                              current_best["p-test"])
            new_product = (comment_stats.get("repness", 0) * 
                          comment_stats.get("repness-test", 0) * 
                          comment_stats.get("p-success", 0) * 
                          comment_stats.get("p-test", 0))
            return new_product > current_product
        
    # Handle raw stats format
    elif "ra" in current_best:
        # If we have a current best with ra > 1.0, use more robust measure
        if current_best.get("ra", 0) > 1.0:
            current_product = (current_best.get("ra", 0) * 
                              current_best.get("rat", 0) * 
                              current_best.get("pa", 0) * 
                              current_best.get("pat", 0))
            new_product = (comment_stats.get("ra", 0) * 
                          comment_stats.get("rat", 0) * 
                          comment_stats.get("pa", 0) * 
                          comment_stats.get("pat", 0))
            return new_product > current_product
            
        # If we have current best, but only by probability, compare on that
        else:
            current_product = current_best.get("pa", 0) * current_best.get("pat", 0)
            new_product = comment_stats.get("pa", 0) * comment_stats.get("pat", 0)
            return new_product > current_product
            
    # Otherwise accept if either repness or probability look good
    else:
        pa = comment_stats.get("pa", 0)
        pat = comment_stats.get("pat", 0)
        ra = comment_stats.get("ra", 0)
        return (z_sig_90(pat) or 
                (ra > 1.0 and pa > 0.5))

# Ports passes-by-test? from math/repness.clj
def passes_by_test(comment_stats):
    """Determine if a comment passes the significance test.
    
    A comment passes if either:
    1. Both rat and pat are significant at 90% level 
       (group agree ratio > other groups, and group agree probability > 0.5)
    2. Both rdt and pdt are significant at 90% level
       (group disagree ratio > other groups, and group disagree probability > 0.5)
    """
    return ((z_sig_90(comment_stats["rat"]) and z_sig_90(comment_stats["pat"])) or 
            (z_sig_90(comment_stats["rdt"]) and z_sig_90(comment_stats["pdt"])))

# Ports finalize-cmt-stats from math/repness.clj
def finalize_cmt_stats(tid, comment_stats):
    """Format comment stats for client consumption.
    
    Chooses between agree/disagree as to which is more representative,
    and populates a regular structure accordingly.
    """
    # Match exactly what Clojure does - pull values into variables first
    if comment_stats["rat"] > comment_stats["rdt"]:
        n_success = comment_stats["na"]
        n_trials = comment_stats["ns"]
        p_success = comment_stats["pa"]
        p_test = comment_stats["pat"]
        repness = comment_stats["ra"]
        repness_test = comment_stats["rat"]
        repful_for = "agree"
    else:
        n_success = comment_stats["nd"]
        n_trials = comment_stats["ns"]
        p_success = comment_stats["pd"]
        p_test = comment_stats["pdt"]
        repness = comment_stats["rd"]
        repness_test = comment_stats["rdt"]
        repful_for = "disagree"
    
    # Return a structure that exactly matches Clojure - without including raw statistics
    return {
        "tid": tid,
        "n-success": n_success,
        "n-trials": n_trials,
        "p-success": p_success,
        "p-test": p_test,
        "repness": repness,
        "repness-test": float(repness_test),  # Float for JSON serialization
        "repful-for": repful_for
    }

# Ports repness-metric from math/repness.clj
def repness_metric(rep_data):
    """Calculate repness metric for sorting"""
    return (rep_data["repness"] * rep_data["repness-test"] * 
            rep_data["p-success"] * rep_data["p-test"])

# Ports select-rep-comments from math/repness.clj
def select_rep_comments(repness_stats, mod_out=None):
    """
    Process raw repness statistics to select the representative comments for each group.
    
    Selection is based on two criteria:
    1. Exceeding a significance threshold (p < 0.05) for representativeness
    2. Two proportion test (rat/rdt) comparing group's rate to other groups' rate
    
    Args:
        repness_stats: List of lists of comment stats, where each outer list corresponds to a group
        mod_out: Set of comment IDs to exclude (optional)
    
    Returns:
        Dictionary mapping group IDs to their representative comments
    """
    if mod_out is None:
        mod_out = set()
    
    results = {}
    
    # Check if repness_stats is actually a list of comments (not grouped by gid)
    if repness_stats and not isinstance(repness_stats[0], list):
        # If it's a flat list of comments, treat it as a single group
        logging.debug("select_rep_comments received a flat list of comments, not a list of lists")
        repness_stats = [repness_stats]
    
    # For each group
    for gid, comments in enumerate(repness_stats):
        if not comments:  # Skip empty groups
            continue
            
        results[gid] = {
            "best": None,
            "best_agree": None,
            "sufficient": []
        }
        
        # Process each comment
        for comment in comments:
            # Skip if comment is not a dictionary
            if not isinstance(comment, dict):
                logging.warning(f"Skipping non-dictionary comment: {comment}")
                continue
                
            tid = comment["tid"]
            if tid in mod_out:
                continue
                
            # First check if comment passes significance test
            # In the Clojure version, this uses raw stats
            if passes_by_test(comment):
                finalized = finalize_cmt_stats(tid, comment)
                results[gid]["sufficient"].append(finalized)
                
            # Track best comment even if it doesn't pass the test
            # Also uses raw stats in Clojure
            if (not results[gid]["sufficient"] and 
                beats_best_by_test(comment, 
                    results[gid]["best"]["repness-test"] if results[gid]["best"] else None)):
                results[gid]["best"] = finalize_cmt_stats(tid, comment)
                
            # Track best agree comment
            if beats_best_agr(comment, results[gid]["best_agree"]):
                # In Clojure, best_agree just stores raw stats with tid added
                results[gid]["best_agree"] = comment
    
    # Format final results
    final_results = {}
    
    for gid, group_results in results.items():
        sufficient = group_results["sufficient"]
        best = group_results["best"]
        best_agree_raw = group_results["best_agree"]
        
        # Finalize best_agree now, if it exists, and add best-agree flag
        best_agree = None
        if best_agree_raw:
            tid = best_agree_raw["tid"]
            best_agree = finalize_cmt_stats(tid, best_agree_raw)
            best_agree["best-agree"] = True
            best_agree["n-agree"] = best_agree_raw["na"]  # Add n-agree from raw stats
            
        if not sufficient:
            final_results[gid] = [best_agree] if best_agree else ([best] if best else [])
        else:
            # Remove best_agree if in sufficient list
            if best_agree:
                sufficient = [s for s in sufficient 
                            if s["tid"] != best_agree["tid"]]
            
            # Sort by repness metric
            sufficient.sort(key=lambda x: -repness_metric(x))
            
            # Add best_agree at front if exists
            if best_agree:
                sufficient = [best_agree] + sufficient
                
            # Take top 5 and sort agrees before disagrees
            sufficient = sufficient[:5]
            agrees = [c for c in sufficient if c["repful-for"] == "agree"]
            disagrees = [c for c in sufficient if c["repful-for"] == "disagree"]
            final_results[gid] = agrees + disagrees
            
    return final_results

# Ports conv-repness from math/repness.clj
def compute_group_repness(
    votes_mat,
    group_clusters,
    base_clusters,
    mod_out=None
):
    """
    Compute representativeness metrics for comments with respect to groups.
    
    This imitates the behavior of conv-repness in the Clojure implementation.
    
    Args:
        votes_mat: A votes matrix; participants as rows, comments as columns
        group_clusters: List of group clusters, with "members" field referencing base_clusters.id
        base_clusters: Dict with "id" list and "members" list of participant indices
        mod_out: Set of comment IDs to exclude (optional)
        
    Returns:
        A list of lists, one per group, containing repness data for each comment
    """
    
    # Use fixed values for optional parameters as in Clojure implementation
    n_agree_thresh = 1
    include_denominators = False
    p_thresh = 0.05
    use_two_proportion_z = False
    
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
                    logging.warning(f"Cluster index {cluster_index} out of bounds for members array of length {len(base_clusters['members'])}")
            else:
                logging.warning(f"Cluster ID {cluster_id} not found in base_clusters[\"id\"]")
        
        group_ptpts.append(list(group_ptpt_set))
        logging.debug(f"Group has {len(group_ptpt_set)} participants after resolving base clusters")

    # Now compute repness as before
    group_repness = []
    n_groups = len(group_ptpts)

    for group_i in range(n_groups):
        group_i_ptpts = group_ptpts[group_i]
        # Get all ptpts not in this group
        # TODO: we might want to index a numpy way for speed -- but that would make a copy, so more memory intensive
        remaining_ptpts = []
        for i in range(n_groups):
            if i != group_i:
                remaining_ptpts.extend(group_ptpts[i])

        comment_stats = compute_comment_repness(
            votes_mat,
            group_i_ptpts,
            remaining_ptpts
        )

        group_repness.append(comment_stats)

    # Process stats to prepare for select_rep_comments
    raw_stats_list = [comment for comment in group_repness if comment["tid"] in raw_stats_by_id]
    
    # Get representative comments based on raw stats
    rep_comments_by_group = select_rep_comments(raw_stats_list, mod_out)

    # Flatten the dictionary into a list of dictionaries, which is what the testing code expects
    rep_comments = []
    if rep_comments_by_group:
        # Use only the first group (gid 0) since we're computing for a single group here
        rep_comments = rep_comments_by_group.get(0, [])

    return rep_comments 

def compute_comment_repness(
    votes_mat,
    group_ptpts,
    other_ptpts
):
    """
    Compute the representativeness of comments for a group.
    
    Args:
        votes_mat: Matrix of votes (participants x comments)
        group_ptpts: List of participant IDs in the group
        other_ptpts: List of participant IDs not in the group
        
    Returns:
        List of comments with their repness statistics
    """
    result = []
    raw_stats_by_id = {}  # Store raw stats for later use
    n_comments = votes_mat.shape[1]

    for comment_id in range(n_comments):
        # Get votes for this comment
        comment_votes = votes_mat[:, comment_id]
        
        # Count agreements and disagreements for group and other
        # IMPORTANT: In the Clojure implementation, -1 = agree, 1 = disagree
        n_group_agree = sum(1 for i in group_ptpts if comment_votes[i] == -1)  # Agree is -1
        n_group_disagree = sum(1 for i in group_ptpts if comment_votes[i] == 1)  # Disagree is 1
        n_other_agree = sum(1 for i in other_ptpts if comment_votes[i] == -1)  # Agree is -1
        n_other_disagree = sum(1 for i in other_ptpts if comment_votes[i] == 1)  # Disagree is 1
        
        n_group_votes = n_group_agree + n_group_disagree
        n_other_votes = n_other_agree + n_other_disagree
        
        # Skip if not enough votes from the group
        if n_group_votes < 1:
            continue
        
        # Create raw statistics
        raw_stats = {
            "tid": comment_id,
            "na": n_group_agree,
            "nd": n_group_disagree,
            "ns": n_group_votes
        }
        
        # Calculate individual group statistics
        pa = (1 + n_group_agree) / (2 + n_group_votes)  # Laplace smoothing
        pd = (1 + n_group_disagree) / (2 + n_group_votes)
        
        # Individual group test statistics
        pat = prop_test(n_group_agree, n_group_votes)
        pdt = prop_test(n_group_disagree, n_group_votes)
        
        # Add these to raw stats
        raw_stats.update({
            "pa": pa,
            "pd": pd,
            "pat": pat,
            "pdt": pdt
        })
        
        # Calculate comparative statistics
        sum_na = n_other_agree
        sum_nd = n_other_disagree
        sum_ns = n_other_votes
        
        # Calculate relative agree/disagree ratios
        ra = pa / ((1 + sum_na) / (2 + sum_ns))
        rd = pd / ((1 + sum_nd) / (2 + sum_ns))
        
        # Calculate z-scores for between-group comparisons
        rat = two_prop_test(n_group_agree, sum_na, n_group_votes, sum_ns)
        rdt = two_prop_test(n_group_disagree, sum_nd, n_group_votes, sum_ns)
        
        # Add to raw stats
        raw_stats.update({
            "ra": ra,
            "rd": rd,
            "rat": rat,
            "rdt": rdt,
            # Add debug fields to help with comparison
            "n_group_agree": n_group_agree,
            "n_group_disagree": n_group_disagree,
            "n_other_agree": n_other_agree,
            "n_other_disagree": n_other_disagree
        })
        
        # Special debug logging for comment 387
        if comment_id == 387:
            logging.warning(f"COMMENT 387 DEBUG: raw_stats={raw_stats}")
            logging.warning(f"COMMENT 387 DEBUG: rat={rat}, rdt={rdt}, comparison: rat > rdt = {rat > rdt}")
            logging.warning(f"COMMENT 387 DEBUG: na={n_group_agree}, nd={n_group_disagree}, ns={n_group_votes}")
            logging.warning(f"COMMENT 387 DEBUG: pa={pa}, pd={pd}, ra={ra}, rd={rd}")
            logging.warning(f"COMMENT 387 DEBUG: other_na={n_other_agree}, other_nd={n_other_disagree}, other_ns={n_other_votes}")
        
        # Save raw stats for later
        raw_stats_by_id[comment_id] = raw_stats
        
        # Finalize and add to results (formatted version only, like Clojure)
        result.append(finalize_cmt_stats(comment_id, raw_stats))
    
    # Sort by repness-test (descending)
    result.sort(key=lambda x: x["repness-test"], reverse=True)
    logging.debug(f"Sorted {len(result)} comments by repness-test")
    
    # Before passing to select_rep_comments, need to ensure all necessary
    # raw stats are present for proper filtering. In the Clojure implementation,
    # passes_by_test is applied to raw stats before finalization.
    # We'll modify the Python implementation to directly use raw_stats for testing.
    
    # Process stats to prepare for select_rep_comments
    raw_stats_list = [raw_stats_by_id[comment["tid"]] for comment in result if comment["tid"] in raw_stats_by_id]
    
    # Get representative comments based on raw stats
    rep_comments_by_group = select_rep_comments(raw_stats_list, mod_out)

    # Flatten the dictionary into a list of dictionaries, which is what the testing code expects
    rep_comments = []
    if rep_comments_by_group:
        # Use only the first group (gid 0) since we're computing for a single group here
        rep_comments = rep_comments_by_group.get(0, [])

    return rep_comments 

def mod_update(conv, mods):
    """
    Take a conversation record and a sequence of moderation data and updates 
    the conversation's mod-out, mod-in, and meta-tids attributes.
    
    Args:
        conv: A conversation record (dictionary)
        mods: A list of moderation data records, each with tid, is_meta, mod, and modified fields
    
    Returns:
        Updated conversation record
    """
    try:
        # Convert existing sets to Python sets, or initialize as empty sets if missing
        mod_out = set(conv.get('mod-out', set()))
        mod_in = set(conv.get('mod-in', set()))
        meta_tids = set(conv.get('meta-tids', set()))
        
        # We process each set of moderation actions in sequence to ensure correct temporal ordering.
        # This is important because a comment's moderation status may change multiple times.
        # For example, a comment might be:
        #   1. First moderated out (mod = -1)
        #   2. Later un-moderated (mod = 0)
        # By processing in order, we ensure the final state reflects the most recent action.
        
        # Process mod-out: Add if meta or rejected, remove otherwise
        for mod_record in mods:
            tid = mod_record.get('tid')
            is_meta = mod_record.get('is_meta', False)
            mod_status = mod_record.get('mod', 0)
            
            if is_meta or mod_status == -1:
                mod_out.add(tid)
            else:
                mod_out.discard(tid)
        
        # Process mod-in: Add if meta or accepted, remove otherwise
        for mod_record in mods:
            tid = mod_record.get('tid')
            is_meta = mod_record.get('is_meta', False)
            mod_status = mod_record.get('mod', 0)
            
            if is_meta or mod_status == 1:
                mod_in.add(tid)
            else:
                mod_in.discard(tid)
        
        # Process meta-tids: Add if meta, remove otherwise
        for mod_record in mods:
            tid = mod_record.get('tid')
            is_meta = mod_record.get('is_meta', False)
            
            if is_meta:
                meta_tids.add(tid)
            else:
                meta_tids.discard(tid)
        
        # Update last-mod-timestamp
        current_timestamp = conv.get('last-mod-timestamp', 0)
        if current_timestamp is None:
            current_timestamp = 0
            
        mod_timestamps = [mod_record.get('modified', 0) for mod_record in mods]
        mod_timestamps = [ts for ts in mod_timestamps if ts is not None]
        
        if mod_timestamps:
            last_timestamp = max([current_timestamp] + mod_timestamps)
        else:
            last_timestamp = current_timestamp
        
        # Create a new conversation with updated values
        updated_conv = conv.copy()
        updated_conv['mod-out'] = mod_out
        updated_conv['mod-in'] = mod_in
        updated_conv['meta-tids'] = meta_tids
        updated_conv['last-mod-timestamp'] = last_timestamp
        
        return updated_conv
        
    except Exception as e:
        logger.error(f"Problem running mod-update with mod-out: {conv.get('mod-out')}, and mods: {mods}: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return conv 

def load_conversation(db_uri, zid):
    """
    Load conversation data from the database, including moderation state.
    
    Args:
        db_uri: Database connection URI
        zid: Conversation ID
        
    Returns:
        Dictionary containing conversation data, including mod-out, mod-in, meta-tids
    """
    logger.debug(f"Loading conversation for ZID {zid}")
    
    # Initialize basic conversation structure
    conv = {
        'zid': zid,
        'mod-out': set(),
        'mod-in': set(),
        'meta-tids': set()
    }
    
    # Get moderation data for the conversation
    try:
        # Get comments with moderation status
        mod_query = f"""
        SELECT tid, mod, is_meta, modified 
        FROM comments 
        WHERE zid = {zid}
        ORDER BY modified
        """
        
        comments_df = pl.read_database_uri(query=mod_query, uri=db_uri)
        
        if not comments_df.is_empty():
            # Convert to list of dictionaries to pass to mod_update
            mods = comments_df.to_dicts()
            
            # Apply moderation updates
            conv = mod_update(conv, mods)
            
            logger.debug(f"Loaded conversation with {len(conv['mod-out'])} moderated comments, "
                         f"{len(conv['mod-in'])} accepted comments, "
                         f"and {len(conv['meta-tids'])} meta comments")
        else:
            logger.debug("No comments found for conversation")
            
        return conv
        
    except Exception as e:
        logger.error(f"Error loading conversation: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return conv 