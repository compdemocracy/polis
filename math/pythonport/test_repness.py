"""Tests for the repness computation module"""

import os
import pytest
import numpy as np
import polars as pl
import logging
from dotenv import load_dotenv
from repness import compute_group_repness, get_votes_matrix
from math_python_main import get_db_connection, get_math_data, parse_json

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def get_clojure_repness(db_uri, zid):
    """Get the repness results computed by Clojure from the database."""
    query = f"""
    SELECT data->>'repness' as repness
    FROM math_main 
    WHERE zid = {zid}
    """
    df = pl.read_database_uri(query=query, uri=db_uri)
    if len(df) == 0 or df[0, "repness"] is None:
        raise ValueError(f"No repness data found for zid: {zid}")
    
    repness_json = df[0, "repness"]
    parsed_repness = parse_json(repness_json)
    
    return parsed_repness

def test_group_repness_comparison_to_clojure():
    """Compare Python repness computation with Clojure's results."""
    # Load environment variables
    load_dotenv()
    db_uri = get_db_connection()
    
    # Use test ZID
    zid = int(os.getenv("DEFAULT_ZID", "17909"))
    
    # Get Clojure results
    clojure_repness = get_clojure_repness(db_uri, zid)
    logger.debug("Clojure repness type: %s", type(clojure_repness))
    logger.debug("Clojure repness keys: %s", list(clojure_repness.keys()) if isinstance(clojure_repness, dict) else "Not a dict")
    if isinstance(clojure_repness, dict) and clojure_repness:
        first_group = clojure_repness["0"]
        logger.debug("First Clojure group structure: n_comments=%d, sample_comment=%s", 
                    len(first_group), {k: first_group[0][k] for k in ['tid', 'n-agree', 'repness']} if first_group else "empty")
    
    # Get math data for Python computation
    json_blob, _, _, _ = get_math_data(db_uri, zid)
    math_data = parse_json(json_blob)
    group_clusters = math_data.get("group-clusters", [])
    base_clusters = math_data.get("base-clusters", {})
    
    # Get votes matrix
    votes_matrix = get_votes_matrix(db_uri, zid)
    
    # Compute Python results
    python_repness = compute_group_repness(votes_matrix, group_clusters, base_clusters)
    logger.debug("Python repness type: %s", type(python_repness))
    logger.debug("Python repness keys: %s", list(python_repness.keys()))
    if python_repness["stats"]:
        first_group = python_repness["stats"][0]
        logger.debug("First Python group structure: gid=%s, n_comments=%d, sample_comment=%s",
                    first_group["gid"], 
                    len(first_group["comments"]),
                    {k: first_group["comments"][0][k] for k in ['tid', 'z_score']} if first_group["comments"] else "empty")
    
    # Convert Clojure repness to list format
    clojure_repness_list = [clojure_repness[str(i)] for i in range(len(clojure_repness))]
    
    # Compare results
    assert len(python_repness["stats"]) == len(clojure_repness_list), \
        f"Different number of groups: Python={len(python_repness['stats'])}, Clojure={len(clojure_repness_list)}"
    
    for py_group, cl_group in zip(python_repness["stats"], clojure_repness_list):
        # Compare group IDs
        assert py_group["gid"] == cl_group["gid"], \
            f"Different group IDs: Python={py_group['gid']}, Clojure={cl_group['gid']}"
        
        # Compare number of comments
        py_comments = py_group["comments"]
        cl_comments = cl_group["comments"]
        assert len(py_comments) == len(cl_comments), \
            f"Different number of comments for group {py_group['gid']}"
        
        # Compare comment stats
        for py_comment, cl_comment in zip(py_comments, cl_comments):
            # Compare essential fields
            assert py_comment["tid"] == cl_comment["tid"], \
                f"Different comment IDs in group {py_group['gid']}"
            
            # Compare numeric values with tolerance
            for field in ["n_success", "n_trials", "p_success", "p_test", "repness", "repness_test"]:
                py_val = float(py_comment[field])
                cl_val = float(cl_comment[field])
                np.testing.assert_allclose(
                    py_val, cl_val, rtol=1e-5, atol=1e-8,
                    err_msg=f"Mismatch in {field} for comment {py_comment['tid']} in group {py_group['gid']}"
                )
            
            # Compare repful_for field
            assert py_comment["repful_for"] == cl_comment["repful_for"], \
                f"Different repful_for for comment {py_comment['tid']} in group {py_group['gid']}"
            
            # Compare vote counts
            for field in ["n_group_agree", "n_group_disagree", "n_other_agree", "n_other_disagree"]:
                assert py_comment[field] == cl_comment[field], \
                    f"Different {field} for comment {py_comment['tid']} in group {py_group['gid']}" 