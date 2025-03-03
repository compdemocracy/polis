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
    p = successes / trials
    z_score = (p - 0.5) / np.sqrt(0.25 / trials)  # Under null hypothesis p=0.5
    return z_score

# Ports stats/two-prop-test from math/stats.clj  
def two_prop_test(succ1, succ2, trials1, trials2):
    """Perform two-proportion z-test"""
    if trials1 == 0 or trials2 == 0:
        return 0
    p1 = succ1 / trials1
    p2 = succ2 / trials2
    p_pooled = (succ1 + succ2) / (trials1 + trials2)
    se = np.sqrt(p_pooled * (1 - p_pooled) * (1/trials1 + 1/trials2))
    if se == 0:
        return 0
    z_score = (p1 - p2) / se
    return z_score

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

def get_votes_matrix(db_uri, zid):
    """Get the votes matrix from the database as a numpy array
    
    Returns a matrix where:
    - Rows correspond to participant IDs (PIDs) which are consecutive integers starting at 0
    - Columns correspond to comment IDs (TIDs) which are consecutive integers starting at 0
    - Cell values: -1 for agree, 1 for disagree, 0 for no vote
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
    
    # Get all votes
    votes_query = f"SELECT pid, tid, vote FROM votes WHERE zid = {zid} AND vote != 0"
    votes_df = pl.read_database_uri(query=votes_query, uri=db_uri)
    
    # Fill in the votes matrix directly using PIDs and TIDs as indices
    for row in votes_df.iter_rows(named=True):
        pid, tid, vote = row["pid"], row["tid"], row["vote"]
        votes_array[pid, tid] = vote
    
    logger.debug(f"Retrieved votes matrix with shape {votes_array.shape}")
    return votes_array

# Ports beats-best-by-test? from math/repness.clj
def beats_best_by_test(comment_stats, current_best_z):
    """Returns true if comment has more representative z score than current best"""
    if current_best_z is None:
        return True
    return max(comment_stats["rat"], comment_stats["rdt"]) > current_best_z

# Ports beats-best-agr? from math/repness.clj
def beats_best_agr(comment_stats, current_best):
    """Check if comment beats current best for agreement"""
    na, nd = comment_stats["na"], comment_stats["nd"]
    if na == 0 and nd == 0:
        return False
        
    if current_best and current_best["ra"] > 1.0:
        # Compare using repness metric
        new_metric = comment_stats["ra"] * comment_stats["rat"] * comment_stats["pa"] * comment_stats["pat"] 
        best_metric = current_best["ra"] * current_best["rat"] * current_best["pa"] * current_best["pat"]
        return new_metric > best_metric
    
    if current_best:
        # Compare using probability metric
        return (comment_stats["pa"] * comment_stats["pat"] > 
                current_best["pa"] * current_best["pat"])
    
    # Accept if either repness or probability look good
    return (z_sig_90(comment_stats["pat"]) or 
            (comment_stats["ra"] > 1.0 and comment_stats["pa"] > 0.5))

# Ports passes-by-test? from math/repness.clj
def passes_by_test(comment_stats):
    """Check if comment passes representativeness criteria.
    
    A comment passes if EITHER:
    - Both agree tests (rat and pat) are significant at 90% level, OR
    - Both disagree tests (rdt and pdt) are significant at 90% level
    """
    return ((z_sig_90(comment_stats["rat"]) and z_sig_90(comment_stats["pat"])) or
            (z_sig_90(comment_stats["rdt"]) and z_sig_90(comment_stats["pdt"])))

# Ports finalize-cmt-stats from math/repness.clj
def finalize_cmt_stats(tid, comment_stats):
    """Format comment stats for client consumption"""
    if comment_stats["rat"] > comment_stats["rdt"]:
        return {
            "tid": tid,
            "n-success": comment_stats["na"],
            "n-trials": comment_stats["ns"],
            "p-success": comment_stats["pa"],
            "p-test": comment_stats["pat"],
            "repness": comment_stats["ra"],
            "repness-test": float(comment_stats["rat"]),
            "repful-for": "agree"
        }
    else:
        return {
            "tid": tid,
            "n-success": comment_stats["nd"], 
            "n-trials": comment_stats["ns"],
            "p-success": comment_stats["pd"],
            "p-test": comment_stats["pdt"],
            "repness": comment_stats["rd"],
            "repness-test": float(comment_stats["rdt"]),
            "repful-for": "disagree"
        }

# Ports repness-metric from math/repness.clj
def repness_metric(rep_data):
    """Calculate repness metric for sorting"""
    return (rep_data["repness"] * rep_data["repness_test"] * 
            rep_data["p_success"] * rep_data["p_test"])

# Ports select-rep-comments from math/repness.clj
def select_rep_comments(repness_stats, mod_out=None):
    """Select representative comments for each group.
    
    A comment is considered representative if it passes BOTH:
    1. Single proportion test (pat/pdt) comparing group's agree/disagree rate to 0.5
    2. Two proportion test (rat/rdt) comparing group's rate to other groups' rate
    
    Args:
        repness_stats: Dictionary containing:
            - ids: list of group IDs
            - tids: list of comment IDs
            - stats: list of group stats, each containing:
                - gid: group ID
                - comments: list of comment stats with test results
        mod_out: Set of comment IDs to exclude (optional)
    
    Returns:
        Dictionary mapping group IDs to their representative comments
    """
    if mod_out is None:
        mod_out = set()
    
    results = {}
    # Initialize results for each group
    for group in repness_stats["stats"]:
        gid = group["gid"]
        results[gid] = {
            "best": None,
            "best_agree": None,
            "sufficient": []
        }
        
        # Process each comment's stats
        for comment_stats in group["comments"]:
            tid = comment_stats["tid"]
            if tid in mod_out:
                continue
                
            # Check if comment passes both tests
            if passes_by_test(comment_stats):
                results[gid]["sufficient"].append(
                    finalize_cmt_stats(tid, comment_stats))
                    
            # Track best comment even if doesn't pass
            if (not results[gid]["sufficient"] and
                beats_best_by_test(comment_stats, 
                    results[gid]["best"]["repness_test"] if results[gid]["best"] else None)):
                results[gid]["best"] = finalize_cmt_stats(tid, comment_stats)
                
            # Track best agree comment
            if beats_best_agr(comment_stats, results[gid]["best_agree"]):
                results[gid]["best_agree"] = comment_stats
                
    # Format final results
    final_results = {}
    for gid, group_results in results.items():
        sufficient = group_results["sufficient"]
        best = group_results["best"]
        best_agree = group_results["best_agree"]
        
        if best_agree:
            best_agree = {**finalize_cmt_stats(best_agree["tid"], best_agree),
                         "n_agree": best_agree["n_group_agree"],
                         "best_agree": True}
            
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
            agrees = [c for c in sufficient if c["repful_for"] == "agree"]
            disagrees = [c for c in sufficient if c["repful_for"] == "disagree"]
            final_results[gid] = agrees + disagrees
            
    return final_results

# Ports conv-repness from math/repness.clj
def compute_group_repness(votes_matrix, group_clusters, base_clusters):
    """Compute representativeness for each group.
    
    This function computes how representative each comment is for each group 
    by measuring both agreement within the group and how that agreement differs
    from other groups.
    
    Args:
        votes_matrix: A 2D numpy array where:
            - rows correspond to PIDs (consecutive integers starting at 0)
            - columns correspond to TIDs (consecutive integers starting at 0)
            - cell values: -1 for agree, 1 for disagree, 0 for no vote
        group_clusters: List of group clusters from math data
        base_clusters: Base clusters from math data
        
    Returns:
        Dictionary mapping group indices (as strings) to lists of comment stats
    """
    # Extract group members (set of PIDs for each group)
    group_members = {}
    
    # First, determine if members is a list or a dict
    members_is_dict = isinstance(base_clusters.get("members", {}), dict)
    
    # For each group, extract the participant IDs that belong to it
    for group in group_clusters:
        gid = group["id"]
        members = []
        
        # Extract participant IDs for this group
        for bid in group["members"]:
            # Find the corresponding entries in base_clusters
            if members_is_dict:
                # If members is a dict with keys as base cluster IDs
                if str(bid) in base_clusters["members"]:
                    members.extend(base_clusters["members"][str(bid)])
            else:
                # If members is a list indexed by positions
                try:
                    bid_index = base_clusters["id"].index(bid)
                    members.extend(base_clusters["members"][bid_index])
                except (ValueError, IndexError):
                    # Skip if bid not found in base_clusters["id"]
                    continue
        
        group_members[gid] = members
    
    # Initialize results
    group_stats = []
    
    # For each group
    for gid, members in group_members.items():
        comments = []
        
        # Create a boolean mask for group members
        member_mask = np.zeros(votes_matrix.shape[0], dtype=bool)
        for pid in members:
            if 0 <= pid < votes_matrix.shape[0]:  # Ensure PID is within matrix bounds
                member_mask[pid] = True
        
        # Skip if no members found
        if not np.any(member_mask):
            continue
        
        # For each comment (TID)
        for tid in range(votes_matrix.shape[1]):
            # Get votes for this comment from group members and others
            group_votes = votes_matrix[member_mask, tid]
            other_votes = votes_matrix[~member_mask, tid]
            
            # Count votes (excluding zeros which are no-votes)
            n_group_agree = np.sum(group_votes == -1)  # -1 is agree in our data
            n_group_disagree = np.sum(group_votes == 1)  # 1 is disagree
            n_group_votes = n_group_agree + n_group_disagree
            
            n_other_agree = np.sum(other_votes == -1)
            n_other_disagree = np.sum(other_votes == 1)
            n_other_votes = n_other_agree + n_other_disagree
            
            # Skip if too few votes
            if n_group_votes < 2 or n_other_votes < 2:
                continue
            
            # Calculate probabilities with Laplace smoothing
            p_group_agree = (n_group_agree + 1) / (n_group_votes + 2)
            p_group_disagree = (n_group_disagree + 1) / (n_group_votes + 2)
            p_other_agree = (n_other_agree + 1) / (n_other_votes + 2)
            p_other_disagree = (n_other_disagree + 1) / (n_other_votes + 2)
            
            # Calculate single proportion tests (vs 0.5 null hypothesis)
            pat = prop_test(n_group_agree, n_group_votes)
            pdt = prop_test(n_group_disagree, n_group_votes)
            
            # Calculate two proportion tests (between groups)
            rat = two_prop_test(n_group_agree, n_other_agree, n_group_votes, n_other_votes)
            rdt = two_prop_test(n_group_disagree, n_other_disagree, n_group_votes, n_other_votes)
            
            # Store all stats for both agree and disagree
            comment_stats = {
                "tid": tid,
                "na": int(n_group_agree),
                "nd": int(n_group_disagree),
                "ns": int(n_group_votes),
                "pa": float(p_group_agree),
                "pd": float(p_group_disagree),
                "pat": float(pat),
                "pdt": float(pdt),
                "ra": float(p_group_agree / p_other_agree),
                "rd": float(p_group_disagree / p_other_disagree),
                "rat": float(rat),
                "rdt": float(rdt),
                "n-agree": int(n_group_agree),
                "n-disagree": int(n_group_disagree),
                "n_group_agree": int(n_group_agree),
                "n_group_disagree": int(n_group_disagree),
                "n_other_agree": int(n_other_agree),
                "n_other_disagree": int(n_other_disagree)
            }
            
            # Format the comment stats for client consumption
            final_stats = finalize_cmt_stats(tid, comment_stats)
            
            # Add debug data - both kebab-case and snake_case for testing flexibility
            final_stats.update({
                "n_group_agree": int(n_group_agree),
                "n_group_disagree": int(n_group_disagree),
                "n_other_agree": int(n_other_agree),
                "n_other_disagree": int(n_other_disagree)
            })
            
            comments.append(final_stats)
        
        # Sort comments by absolute repness test score
        comments.sort(key=lambda x: -abs(x["repness-test"]))
        
        # Add group stats
        group_stats.append({
            "gid": gid,
            "comments": comments
        })
    
    # Prepare the return value to match the Clojure structure
    result = {}
    for i, group_stat in enumerate(group_stats):
        result[str(i)] = group_stat["comments"]
        
    return result 