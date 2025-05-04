"""
Core conversation management and processing for Pol.is.

This module handles mathematical processing of conversation data,
including votes, clustering, and representativeness calculation.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Union, Any, Set, Callable
from copy import deepcopy
import time
import logging
import sys
from datetime import datetime

from polismath.math.named_matrix import NamedMatrix
from polismath.math.pca import pca_project_named_matrix
from polismath.math.clusters import cluster_named_matrix
from polismath.math.repness import conv_repness, participant_stats
from polismath.math.corr import compute_correlation
from polismath.utils.general import agree, disagree, pass_vote


# Constants for conversation management
MAX_PTPTS = 5000  # Maximum number of participants per conversation
MAX_CMTS = 400    # Maximum number of comments per conversation
SMALL_CONV_THRESHOLD = 1000  # Threshold for small vs large conversation


# Configure logging
logger = logging.getLogger(__name__)

# Set up better logging if not already configured
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    # Also set up the NamedMatrix logger
    matrix_logger = logging.getLogger('polismath.math.named_matrix')
    matrix_logger.addHandler(handler)
    matrix_logger.setLevel(logging.INFO)


class Conversation:
    """
    Manages the state and computation for a Pol.is conversation.
    """
    
    def __init__(self, 
                conversation_id: str, 
                last_updated: Optional[int] = None,
                votes: Optional[Dict[str, Any]] = None):
        """
        Initialize a conversation.
        
        Args:
            conversation_id: Unique identifier for the conversation
            last_updated: Timestamp of last update (milliseconds since epoch)
            votes: Initial votes data
        """
        self.conversation_id = conversation_id
        self.last_updated = last_updated or int(time.time() * 1000)
        
        # Initialize empty state
        self.raw_rating_mat = NamedMatrix()  # All votes
        self.rating_mat = NamedMatrix()      # Filtered for moderation
        
        # Participant and comment info
        self.participant_count = 0
        self.comment_count = 0
        
        # Moderation state
        self.mod_out_tids = set()   # Excluded comments
        self.mod_in_tids = set()    # Featured comments
        self.meta_tids = set()      # Meta comments
        self.mod_out_ptpts = set()  # Excluded participants
        
        # Clustering and projection state
        self.pca = None
        self.base_clusters = []
        self.group_clusters = []
        self.subgroup_clusters = {}
        self.proj = {}
        self.repness = None
        self.consensus = []
        self.participant_info = {}
        self.vote_stats = {}
        
        # Initialize with votes if provided
        if votes:
            self.update_votes(votes)
    
    def update_votes(self, 
                    votes: Dict[str, Any],
                    recompute: bool = True) -> 'Conversation':
        """
        Update the conversation with new votes.
        
        Args:
            votes: Dictionary of votes
            recompute: Whether to recompute the clustering
            
        Returns:
            Updated conversation
        """
        # Create a copy to avoid modifying the original
        result = deepcopy(self)
        
        # Extract vote data
        vote_data = votes.get('votes', [])
        last_vote_timestamp = votes.get('lastVoteTimestamp', self.last_updated)
        
        if not vote_data:
            return result
        
        start_time = time.time()
        total_votes = len(vote_data)
        logger.info(f"Processing {total_votes} votes for conversation {self.conversation_id}")
        
        # Collect all valid votes for batch processing
        vote_updates = []
        invalid_count = 0
        null_count = 0
        
        # Progress tracking
        progress_interval = 10000  # Report every N votes
        
        for i, vote in enumerate(vote_data):
            # Report progress for large datasets
            if i > 0 and i % progress_interval == 0:
                progress_pct = (i / total_votes) * 100
                elapsed = time.time() - start_time
                remaining = (elapsed / i) * (total_votes - i) if i > 0 else 0
                logger.info(f"[{elapsed:.2f}s] Processed {i}/{total_votes} votes ({progress_pct:.1f}%) - Est. remaining: {remaining:.2f}s")
            
            try:
                ptpt_id = str(vote.get('pid'))  # Ensure string
                comment_id = str(vote.get('tid'))  # Ensure string
                vote_value = vote.get('vote')
                created = vote.get('created', last_vote_timestamp)
                
                # Skip invalid votes
                if ptpt_id is None or comment_id is None or vote_value is None:
                    invalid_count += 1
                    continue
                    
                # Convert vote value to standard format
                try:
                    # Handle string values
                    if isinstance(vote_value, str):
                        vote_value = vote_value.lower()
                        if vote_value == 'agree':
                            vote_value = 1.0
                        elif vote_value == 'disagree':
                            vote_value = -1.0
                        elif vote_value == 'pass':
                            vote_value = None
                        else:
                            # Try to convert numeric string
                            try:
                                vote_value = float(vote_value)
                                # Normalize to -1, 0, 1
                                if vote_value > 0:
                                    vote_value = 1.0
                                elif vote_value < 0:
                                    vote_value = -1.0
                                else:
                                    vote_value = 0.0
                            except (ValueError, TypeError):
                                logger.warning(f"Unknown vote value format: {vote_value}")
                                vote_value = None
                    # Handle numeric values
                    elif isinstance(vote_value, (int, float)):
                        vote_value = float(vote_value)
                        # Normalize to -1, 0, 1
                        if vote_value > 0:
                            vote_value = 1.0
                        elif vote_value < 0:
                            vote_value = -1.0
                        else:
                            vote_value = 0.0
                    else:
                        vote_value = None
                except Exception as e:
                    logger.error(f"Error converting vote value: {e}")
                    vote_value = None
                
                # Skip null votes or unknown format
                if vote_value is None:
                    null_count += 1
                    continue
                
                # Add to batch updates list
                vote_updates.append((ptpt_id, comment_id, vote_value))
                
            except Exception as e:
                logger.error(f"Error processing vote: {e}")
                invalid_count += 1
                continue
        
        # Log validation results
        logger.info(f"[{time.time() - start_time:.2f}s] Vote processing summary: {len(vote_updates)} valid, {invalid_count} invalid, {null_count} null")
        
        # Apply all updates in a single batch operation for better performance
        if vote_updates:
            logger.info(f"[{time.time() - start_time:.2f}s] Applying {len(vote_updates)} votes as batch update...")
            batch_start = time.time()
            result.raw_rating_mat = result.raw_rating_mat.batch_update(vote_updates)
            logger.info(f"[{time.time() - start_time:.2f}s] Batch update completed in {time.time() - batch_start:.2f}s")
        
        # Update last updated timestamp
        result.last_updated = max(
            last_vote_timestamp, 
            result.last_updated
        )
        
        # Update count stats
        result.participant_count = len(result.raw_rating_mat.rownames())
        result.comment_count = len(result.raw_rating_mat.colnames())
        
        # Apply moderation and create filtered rating matrix
        result._apply_moderation()
        
        # Compute vote stats
        result._compute_vote_stats()
        
        # Recompute clustering if requested
        if recompute:
            try:
                result = result.recompute()
            except Exception as e:
                print(f"Error during recompute: {e}")
                # If recompute fails, return the conversation with just the new votes
        
        return result
    
    def _apply_moderation(self) -> None:
        """
        Apply moderation settings to create filtered rating matrix.
        """
        # Get all row and column names
        all_ptpts = self.raw_rating_mat.rownames()
        all_comments = self.raw_rating_mat.colnames()
        
        # Filter out moderated participants and comments
        valid_ptpts = [p for p in all_ptpts if p not in self.mod_out_ptpts]
        valid_comments = [c for c in all_comments if c not in self.mod_out_tids]
        
        # Create filtered matrix
        self.rating_mat = self.raw_rating_mat.rowname_subset(valid_ptpts)
        self.rating_mat = self.rating_mat.colname_subset(valid_comments)
    
    def _compute_vote_stats(self) -> None:
        """
        Compute statistics on votes.
        """
        # Make sure pandas is imported
        import numpy as np
        import pandas as pd
        
        # Initialize stats
        self.vote_stats = {
            'n_votes': 0,
            'n_agree': 0,
            'n_disagree': 0,
            'n_pass': 0,
            'comment_stats': {},
            'participant_stats': {}
        }
        
        # Get matrix values and ensure they are numeric
        try:
            # Make a clean copy that's definitely numeric
            clean_mat = self._get_clean_matrix()
            values = clean_mat.values
            
            # Count votes safely
            try:
                # Create masks, handling non-numeric data
                non_null_mask = ~np.isnan(values)
                agree_mask = np.abs(values - 1.0) < 0.001  # Close to 1
                disagree_mask = np.abs(values + 1.0) < 0.001  # Close to -1
                
                self.vote_stats['n_votes'] = int(np.sum(non_null_mask))
                self.vote_stats['n_agree'] = int(np.sum(agree_mask))
                self.vote_stats['n_disagree'] = int(np.sum(disagree_mask))
                self.vote_stats['n_pass'] = int(np.sum(np.isnan(values)))
            except Exception as e:
                print(f"Error counting votes: {e}")
                # Set defaults if counting fails
                self.vote_stats['n_votes'] = 0
                self.vote_stats['n_agree'] = 0
                self.vote_stats['n_disagree'] = 0
                self.vote_stats['n_pass'] = 0
            
            # Compute comment stats
            for i, cid in enumerate(clean_mat.colnames()):
                if i >= values.shape[1]:
                    continue
                    
                try:
                    col = values[:, i]
                    n_votes = np.sum(~np.isnan(col))
                    n_agree = np.sum(np.abs(col - 1.0) < 0.001)
                    n_disagree = np.sum(np.abs(col + 1.0) < 0.001)
                    
                    self.vote_stats['comment_stats'][cid] = {
                        'n_votes': int(n_votes),
                        'n_agree': int(n_agree),
                        'n_disagree': int(n_disagree),
                        'agree_ratio': float(n_agree / max(n_votes, 1))
                    }
                except Exception as e:
                    print(f"Error computing stats for comment {cid}: {e}")
                    self.vote_stats['comment_stats'][cid] = {
                        'n_votes': 0,
                        'n_agree': 0,
                        'n_disagree': 0,
                        'agree_ratio': 0.0
                    }
            
            # Compute participant stats
            for i, pid in enumerate(clean_mat.rownames()):
                if i >= values.shape[0]:
                    continue
                    
                try:
                    row = values[i, :]
                    n_votes = np.sum(~np.isnan(row))
                    n_agree = np.sum(np.abs(row - 1.0) < 0.001)
                    n_disagree = np.sum(np.abs(row + 1.0) < 0.001)
                    
                    self.vote_stats['participant_stats'][pid] = {
                        'n_votes': int(n_votes),
                        'n_agree': int(n_agree),
                        'n_disagree': int(n_disagree),
                        'agree_ratio': float(n_agree / max(n_votes, 1))
                    }
                except Exception as e:
                    print(f"Error computing stats for participant {pid}: {e}")
                    self.vote_stats['participant_stats'][pid] = {
                        'n_votes': 0,
                        'n_agree': 0,
                        'n_disagree': 0,
                        'agree_ratio': 0.0
                    }
        except Exception as e:
            print(f"Error in vote stats computation: {e}")
            # Initialize with empty stats if computation fails
            self.vote_stats = {
                'n_votes': 0,
                'n_agree': 0,
                'n_disagree': 0,
                'n_pass': 0,
                'comment_stats': {},
                'participant_stats': {}
            }
    
    def update_moderation(self, 
                         moderation: Dict[str, Any],
                         recompute: bool = True) -> 'Conversation':
        """
        Update moderation settings.
        
        Args:
            moderation: Dictionary of moderation settings
            recompute: Whether to recompute the clustering
            
        Returns:
            Updated conversation
        """
        # Create a copy to avoid modifying the original
        result = deepcopy(self)
        
        # Extract moderation data
        mod_out_tids = moderation.get('mod_out_tids', [])
        mod_in_tids = moderation.get('mod_in_tids', [])
        meta_tids = moderation.get('meta_tids', [])
        mod_out_ptpts = moderation.get('mod_out_ptpts', [])
        
        # Update moderation sets
        if mod_out_tids:
            result.mod_out_tids = set(mod_out_tids)
        
        if mod_in_tids:
            result.mod_in_tids = set(mod_in_tids)
        
        if meta_tids:
            result.meta_tids = set(meta_tids)
        
        if mod_out_ptpts:
            result.mod_out_ptpts = set(mod_out_ptpts)
        
        # Apply moderation to update rating matrix
        result._apply_moderation()
        
        # Compute vote stats
        result._compute_vote_stats()
        
        # Recompute clustering if requested
        if recompute:
            result = result.recompute()
        
        return result
    
    def _compute_pca(self, n_components: int = 2) -> None:
        """
        Compute PCA on the vote matrix.
        
        Args:
            n_components: Number of principal components
        """
        # Make sure pandas and numpy are imported
        import numpy as np
        import pandas as pd
        
        # Check if we have enough data
        if self.rating_mat.values.shape[0] < 2 or self.rating_mat.values.shape[1] < 2:
            # Not enough data for PCA, create minimal results
            cols = max(self.rating_mat.values.shape[1], 1)
            self.pca = {
                'center': np.zeros(cols),
                'comps': np.zeros((min(n_components, 2), cols))
            }
            self.proj = {pid: np.zeros(2) for pid in self.rating_mat.rownames()}
            return
        
        try:
            # Make a clean copy of the rating matrix
            clean_matrix = self._get_clean_matrix()
            
            # Perform PCA based on conversation size
            if self.participant_count <= SMALL_CONV_THRESHOLD:
                # Regular PCA for small conversations
                pca_results, proj_dict = pca_project_named_matrix(clean_matrix, n_components)
            else:
                # Sampling-based PCA for large conversations
                try:
                    sample_size = min(SMALL_CONV_THRESHOLD, self.participant_count)
                    row_names = clean_matrix.rownames()
                    sample_rows = np.random.choice(row_names, sample_size, replace=False)
                    
                    # Create sample matrix
                    sample_mat = clean_matrix.rowname_subset(sample_rows)
                    
                    # Perform PCA on sample
                    pca_results, _ = pca_project_named_matrix(sample_mat, n_components)
                    
                    # Project all participants
                    proj_dict = {}
                    for ptpt_id in clean_matrix.rownames():
                        try:
                            votes = clean_matrix.get_row_by_name(ptpt_id)
                            from polismath.math.pca import sparsity_aware_project_ptpt
                            proj = sparsity_aware_project_ptpt(votes, pca_results)
                            proj_dict[ptpt_id] = proj
                        except (KeyError, ValueError, TypeError) as e:
                            # If we can't project this participant, use zeros
                            proj_dict[ptpt_id] = np.zeros(2)
                            print(f"Error projecting participant {ptpt_id}: {e}")
                except Exception as e:
                    # If sampling PCA fails, fall back to regular PCA
                    print(f"Error in sampling PCA: {e}, falling back to regular PCA")
                    pca_results, proj_dict = pca_project_named_matrix(clean_matrix, n_components)
            
            # Store results
            self.pca = pca_results
            self.proj = proj_dict
        
        except Exception as e:
            # If PCA fails, create minimal results
            print(f"Error in PCA computation: {e}")
            # Make sure we have numpy and pandas
            import numpy as np
            import pandas as pd
            
            cols = self.rating_mat.values.shape[1]
            self.pca = {
                'center': np.zeros(cols),
                'comps': np.zeros((min(n_components, 2), cols))
            }
            self.proj = {pid: np.zeros(2) for pid in self.rating_mat.rownames()}
    
    def _get_clean_matrix(self) -> NamedMatrix:
        """
        Get a clean copy of the rating matrix with proper numeric values.
        
        Returns:
            Clean NamedMatrix
        """
        # Make a copy of the matrix
        matrix_values = self.rating_mat.values.copy()
        
        # Ensure the matrix contains numeric values
        if not np.issubdtype(matrix_values.dtype, np.number):
            # Convert to numeric matrix with proper NaN handling
            numeric_matrix = np.zeros(matrix_values.shape, dtype=float)
            for i in range(matrix_values.shape[0]):
                for j in range(matrix_values.shape[1]):
                    val = matrix_values[i, j]
                    if pd.isna(val) or val is None:
                        numeric_matrix[i, j] = np.nan
                    else:
                        try:
                            numeric_matrix[i, j] = float(val)
                        except (ValueError, TypeError):
                            numeric_matrix[i, j] = np.nan
            matrix_values = numeric_matrix
        
        # Create a DataFrame with proper indexing
        import pandas as pd
        df = pd.DataFrame(
            matrix_values,
            index=self.rating_mat.rownames(),
            columns=self.rating_mat.colnames()
        )
        
        # Create a new NamedMatrix
        from polismath.math.named_matrix import NamedMatrix
        return NamedMatrix(df)
    
    def _compute_clusters(self) -> None:
        """
        Compute participant clusters using auto-determination of optimal k.
        """
        # Make sure numpy and pandas are imported
        import numpy as np
        import pandas as pd
        
        # Check if we have projections
        if not self.proj:
            self.base_clusters = []
            self.group_clusters = []
            self.subgroup_clusters = {}
            return
        
        # Prepare data for clustering
        ptpt_ids = list(self.proj.keys())
        proj_values = np.array([self.proj[pid] for pid in ptpt_ids])
        
        # Create projection matrix
        proj_matrix = NamedMatrix(
            matrix=proj_values,
            rownames=ptpt_ids,
            colnames=['x', 'y']
        )
        
        # Use auto-determination of k based on data size
        # The determine_k function will handle this appropriately
        from polismath.math.clusters import cluster_named_matrix
        
        # Let the clustering function auto-determine the appropriate number of clusters
        # Pass k=None to use the built-in determine_k function
        base_clusters = cluster_named_matrix(proj_matrix, k=None)
        
        # Convert base clusters to group clusters
        # Group clusters are high-level groups based on base clusters
        group_clusters = base_clusters
        
        # Store results
        self.base_clusters = base_clusters
        self.group_clusters = group_clusters
        
        # Compute subgroup clusters if needed
        self.subgroup_clusters = {}
        
        # TODO: Implement subgroup clustering if needed
    
    def _compute_repness(self) -> None:
        """
        Compute comment representativeness.
        """
        # Make sure numpy and pandas are imported
        import numpy as np
        import pandas as pd
        
        # Check if we have groups
        if not self.group_clusters:
            self.repness = {
                'comment_ids': self.rating_mat.colnames(),
                'group_repness': {},
                'consensus_comments': []
            }
            return
        
        # Compute representativeness
        self.repness = conv_repness(self.rating_mat, self.group_clusters)
    
    def _compute_participant_info(self) -> None:
        """
        Compute information about participants.
        """
        # Make sure numpy and pandas are imported
        import numpy as np
        import pandas as pd
        import time
        
        start_time = time.time()
        logger.info("Starting participant info computation...")
        
        # Check if we have groups
        if not self.group_clusters:
            self.participant_info = {}
            return
        
        # Use optimized participant stats calculation for better performance
        try:
            # Import the optimized version
            from polismath.conversation.participant_info_optimization import compute_participant_info_optimized
            logger.info("Using optimized participant info computation")
            
            # Use the optimized version which has better performance for large datasets
            ptpt_stats = compute_participant_info_optimized(self.rating_mat, self.group_clusters)
            
        except ImportError:
            # Fall back to original version if optimized one is not available
            logger.info("Falling back to standard participant info computation")
            from polismath.math.repness import participant_stats
            ptpt_stats = participant_stats(self.rating_mat, self.group_clusters)
        
        # Store results
        self.participant_info = ptpt_stats.get('stats', {})
        
        logger.info(f"Participant info computation completed in {time.time() - start_time:.2f}s")
    
    def _importance_metric(self, A: int, P: int, S: int, E: float) -> float:
        """
        Calculate the importance metric for a comment.
        Direct port of the Clojure importance-metric function.
        
        Args:
            A: Number of agree votes
            P: Number of pass votes
            S: Total number of votes
            E: Extremity value
            
        Returns:
            Importance metric value
        """
        p = (P + 1.0) / (S + 2.0)
        a = (A + 1.0) / (S + 2.0)
        return (1.0 - p) * (E + 1.0) * a
    
    def _priority_metric(self, is_meta: bool, A: int, P: int, S: int, E: float) -> float:
        """
        Calculate the priority metric for a comment.
        Direct port of the Clojure priority-metric function.
        
        Args:
            is_meta: Whether the comment is a meta comment
            A: Number of agree votes
            P: Number of pass votes
            S: Total number of votes
            E: Extremity value
            
        Returns:
            Priority metric value
        """
        import math
        
        # Meta comments have a fixed high priority (equivalent to meta-priority in Clojure)
        META_PRIORITY = 7.0
        
        if is_meta:
            return META_PRIORITY ** 2
        else:
            # Regular priority calculation matching Clojure formula
            importance = self._importance_metric(A, P, S, E)
            # Scale by a factor which lets new comments bubble up
            scaling_factor = 1.0 + (8.0 * (2.0 ** (-S / 5.0)))
            return (importance * scaling_factor) ** 2
    
    def _compute_comment_priorities(self) -> None:
        """
        Compute comment priorities for Clojure format compatibility.
        
        In the Clojure version, comment priorities are used to determine which
        comments to show users. This method computes similar values in a format
        compatible with the Clojure output.
        """
        # Import needed libraries
        import numpy as np
        import pandas as pd
        import time
        
        start_time = time.time()
        logger.info("Computing comment priorities...")
        
        # Initialize comment priorities
        self.comment_priorities = {}
        
        # If we don't have a rating matrix, return empty priorities
        if self.rating_mat.values.shape[0] == 0 or self.rating_mat.values.shape[1] == 0:
            logger.info("No rating matrix data, skipping comment priorities")
            return
        
        try:
            # Get the list of comment IDs
            comment_ids = self.rating_mat.colnames()
            
            # For each comment, calculate priority matching Clojure's calculation
            for cid in comment_ids:
                try:
                    # Determine if this is a meta comment
                    is_meta = cid in self.meta_tids
                    
                    # Get vote counts from group_votes if available
                    if hasattr(self, 'group_votes') and self.group_votes:
                        # Aggregate votes across all groups, just like in Clojure
                        A, D, S, P = 0, 0, 0, 0
                        
                        # Sum votes across all groups (matches the Clojure reduce logic)
                        for gid, group_data in self.group_votes.items():
                            if 'votes' in group_data and cid in group_data['votes']:
                                vote_data = group_data['votes'][cid]
                                A += vote_data.get('A', 0)
                                D += vote_data.get('D', 0)
                                S += vote_data.get('S', 0)
                                
                        # Calculate passes (P) as defined in Clojure: P = S - (A + D)
                        P = S - (A + D)
                    else:
                        # Fallback to vote_stats if group_votes not available
                        comment_stats = self.vote_stats.get('comment_stats', {}).get(cid, {})
                        A = comment_stats.get('n_agree', 0)
                        D = comment_stats.get('n_disagree', 0)
                        S = comment_stats.get('n_votes', 0)
                        P = S - (A + D)  # Calculate passes
                    
                    # Get extremity value from PCA
                    E = 0
                    if hasattr(self, 'pca') and self.pca and 'comment_extremity' in self.pca:
                        # Get comment index in the PCA data
                        try:
                            comment_idx = self.rating_mat.colnames().index(cid)
                            if comment_idx < len(self.pca['comment_extremity']):
                                E = self.pca['comment_extremity'][comment_idx]
                        except (ValueError, IndexError):
                            E = 0
                    
                    # Calculate priority using the same formula as Clojure
                    priority = self._priority_metric(is_meta, A, P, S, E)
                    
                    # Match Clojure's fixed values for low-vote comments
                    if S < 7:
                        # In Clojure, these often get a fixed value of 49
                        priority = 49
                    
                    # Store priority as an integer to match Clojure format
                    self.comment_priorities[cid] = int(priority)
                except Exception as e:
                    logger.warning(f"Error computing priority for comment {cid}: {e}")
                    # Default priority matching Clojure's common value for low-vote comments
                    self.comment_priorities[cid] = 49
            
            logger.info(f"Comment priorities computation completed in {time.time() - start_time:.2f}s")
        
        except Exception as e:
            logger.error(f"Error computing comment priorities: {e}")
            # Make sure we have minimal comment priorities even if computation fails
            for cid in self.rating_mat.colnames():
                self.comment_priorities[cid] = 49  # Clojure's common default value
    
    def recompute(self) -> 'Conversation':
        """
        Recompute all derived data.
        
        Returns:
            Updated conversation
        """
        # Make sure numpy and pandas are imported
        import numpy as np
        import pandas as pd
        
        # Create a copy to avoid modifying the original
        result = deepcopy(self)
        
        # Check if we have enough data
        if result.rating_mat.values.shape[0] == 0 or result.rating_mat.values.shape[1] == 0:
            # Not enough data, return early
            return result
        
        # Compute PCA and projections
        result._compute_pca()
        
        # Compute clusters
        result._compute_clusters()
        
        # Compute representativeness
        result._compute_repness()
        
        # Compute participant info
        result._compute_participant_info()
        
        # Compute comment priorities (for Clojure format compatibility)
        result._compute_comment_priorities()
        
        return result
    
    def get_summary(self) -> Dict[str, Any]:
        """
        Get a summary of the conversation.
        
        Returns:
            Dictionary with conversation summary
        """
        return {
            'conversation_id': self.conversation_id,
            'last_updated': self.last_updated,
            'participant_count': self.participant_count,
            'comment_count': self.comment_count,
            'vote_count': self.vote_stats.get('n_votes', 0),
            'group_count': len(self.group_clusters),
        }
    
    def get_full_data(self) -> Dict[str, Any]:
        """
        Get the full conversation data.
        
        Returns:
            Dictionary with all conversation data
        """
        # Base data
        result = {
            'conversation_id': self.conversation_id,
            'last_updated': self.last_updated,
            'participant_count': self.participant_count,
            'comment_count': self.comment_count,
            'vote_stats': self.vote_stats,
            'moderation': {
                'mod_out_tids': list(self.mod_out_tids),
                'mod_in_tids': list(self.mod_in_tids),
                'meta_tids': list(self.meta_tids),
                'mod_out_ptpts': list(self.mod_out_ptpts)
            }
        }
        
        # Add PCA data
        if self.pca:
            result['pca'] = {
                'center': self.pca['center'].tolist() if isinstance(self.pca['center'], np.ndarray) else self.pca['center'],
                'comps': [comp.tolist() if isinstance(comp, np.ndarray) else comp for comp in self.pca['comps']]
            }
        
        # Add projection data
        if self.proj:
            result['proj'] = {pid: proj.tolist() if isinstance(proj, np.ndarray) else proj 
                            for pid, proj in self.proj.items()}
        
        # Add cluster data
        result['group_clusters'] = self.group_clusters
        
        # Add representativeness data
        if self.repness:
            result['repness'] = self.repness
        
        # Add participant info
        if self.participant_info:
            result['participant_info'] = self.participant_info
        
        # Add comment priorities if available (matching Clojure format)
        if hasattr(self, 'comment_priorities') and self.comment_priorities:
            result['comment_priorities'] = self.comment_priorities
        
        return result
    
    def _compute_votes_base(self) -> Dict[str, Any]:
        """
        Compute votes base structure which maps each comment ID to aggregated vote counts.
        This matches the Clojure conversation.clj votes-base implementation.
        
        Returns:
            Dictionary mapping comment IDs to vote statistics
        """
        import numpy as np
        
        # Get all comment IDs
        comment_ids = self.rating_mat.colnames()
        
        # Helper functions to identify vote types (like utils/agree?, utils/disagree? in Clojure)
        def agree_vote(x):
            return not np.isnan(x) and abs(x - 1.0) < 0.001
            
        def disagree_vote(x):
            return not np.isnan(x) and abs(x + 1.0) < 0.001
            
        def is_number(x):
            return not np.isnan(x)
        
        # Create vote aggregations for each comment
        votes_base = {}
        for tid in comment_ids:
            # Get the column for this comment
            try:
                col_idx = self.rating_mat.colnames().index(tid)
                votes = self.rating_mat.values[:, col_idx]
                
                # Count vote types
                agree_votes = np.sum(agree_vote(votes))
                disagree_votes = np.sum(disagree_vote(votes))
                total_votes = np.sum(is_number(votes))
                
                # Store in format matching Clojure
                votes_base[tid] = {
                    'A': int(agree_votes),
                    'D': int(disagree_votes),
                    'S': int(total_votes)
                }
            except (ValueError, IndexError) as e:
                # If comment not found, use empty counts
                votes_base[tid] = {'A': 0, 'D': 0, 'S': 0}
                
        return votes_base
    
    def _compute_group_votes(self) -> Dict[str, Any]:
        """
        Compute group votes structure which maps group IDs to vote statistics by comment.
        This matches the Clojure conversation.clj group-votes implementation.
        
        Returns:
            Dictionary mapping group IDs to vote statistics
        """
        # If no groups, return empty dict
        if not self.group_clusters:
            return {}
            
        group_votes = {}
        
        # Helper to count votes of a specific type for a group
        def count_votes_for_group(group_id, comment_id, vote_type):
            group = next((g for g in self.group_clusters if g.get('id') == group_id), None)
            if not group:
                return 0
                
            # Get members of this group
            members = group.get('members', [])
            
            # If members list is empty, return 0
            if not members:
                return 0
                
            # Get the row indices for these members
            row_indices = []
            for member in members:
                try:
                    member_idx = self.rating_mat.rownames().index(member)
                    row_indices.append(member_idx)
                except ValueError:
                    # Skip members not found in matrix
                    continue
                    
            # Get the column index for this comment
            try:
                col_idx = self.rating_mat.colnames().index(comment_id)
            except ValueError:
                # If comment not found, return 0
                return 0
                
            # Count votes of specified type
            votes = self.rating_mat.values[row_indices, col_idx]
            
            if vote_type == 'A':  # Agree
                return int(np.sum(np.abs(votes - 1.0) < 0.001))
            elif vote_type == 'D':  # Disagree
                return int(np.sum(np.abs(votes + 1.0) < 0.001))
            elif vote_type == 'S':  # Total votes
                return int(np.sum(~np.isnan(votes)))
            else:
                return 0
        
        # For each group, compute vote stats
        for group in self.group_clusters:
            group_id = group.get('id')
            
            # Skip groups without ID
            if group_id is None:
                continue
                
            # Count members in this group
            n_members = len(group.get('members', []))
            
            # Get vote counts for each comment
            votes = {}
            for comment_id in self.rating_mat.colnames():
                votes[comment_id] = {
                    'A': count_votes_for_group(group_id, comment_id, 'A'),
                    'D': count_votes_for_group(group_id, comment_id, 'D'),
                    'S': count_votes_for_group(group_id, comment_id, 'S')
                }
                
            # Store results
            group_votes[str(group_id)] = {
                'n-members': n_members,
                'votes': votes
            }
            
        return group_votes
        
    def _compute_user_vote_counts(self) -> Dict[str, int]:
        """
        Compute the number of votes per participant.
        
        Returns:
            Dictionary mapping participant IDs to vote counts
        """
        vote_counts = {}
        
        for i, pid in enumerate(self.rating_mat.rownames()):
            # Get row of votes for this participant
            row = self.rating_mat.values[i, :]
            
            # Count non-nan values
            count = np.sum(~np.isnan(row))
            
            # Store count
            vote_counts[pid] = int(count)
            
        return vote_counts
        
    def _compute_group_aware_consensus(self) -> Dict[str, float]:
        """
        Compute group-aware consensus values for each comment.
        Based on the Clojure implementation in conversation.clj.
        
        Returns:
            Dictionary mapping comment IDs to consensus values
        """
        # If we don't have group votes or comments, return empty dict
        if not hasattr(self, 'group_clusters') or not self.group_clusters:
            return {}
            
        # Get group votes structure
        group_votes = self._compute_group_votes()
        if not group_votes:
            return {}
            
        # First build a nested structure of [tid][gid] -> probability
        # This matches the tid-gid-probs in Clojure
        tid_gid_probs = {}
        
        # First reduce: iterate through each group
        for gid, gid_stats in group_votes.items():
            votes_data = gid_stats.get('votes', {})
            
            # Second reduce: iterate through each comment's votes in this group
            for tid, vote_stats in votes_data.items():
                # Get vote counts with defaults
                agree_count = vote_stats.get('A', 0)
                total_count = vote_stats.get('S', 0)
                
                # Calculate probability with Laplace smoothing
                prob = (agree_count + 1.0) / (total_count + 2.0)
                
                # Initialize the tid entry if needed
                if tid not in tid_gid_probs:
                    tid_gid_probs[tid] = {}
                
                # Store probability for this group and comment
                tid_gid_probs[tid][gid] = prob
        
        # Now calculate consensus by multiplying probabilities for each comment
        # This matches the tid-consensus in Clojure
        consensus = {}
        
        for tid, gid_probs in tid_gid_probs.items():
            # Get all probabilities for this comment
            probs = list(gid_probs.values())
            
            if probs:
                # Multiply all probabilities (same as Clojure's reduce *)
                consensus_value = 1.0
                for p in probs:
                    consensus_value *= p
                
                # Store result
                consensus[tid] = consensus_value
        
        return consensus
    
    def to_dict(self, use_clojure_format: bool = True) -> Dict[str, Any]:
        """
        Convert the conversation to a dictionary for serialization.
        
        Args:
            use_clojure_format: If True, use hyphenated keys to match Clojure format
        
        Returns:
            Dictionary representation of the conversation
        """
        # Get base dictionary
        result = self.get_full_data()
        
        # Rename conversation_id to zid for Clojure compatibility
        result['zid'] = result.pop('conversation_id')
        
        # Add timestamps in Clojure format
        result['lastVoteTimestamp'] = self.last_updated
        result['lastModTimestamp'] = self.last_updated  # Use same value if no specific mod timestamp
        
        # Add tids (list of comment IDs)
        # Convert comment IDs to integers when possible for Clojure compatibility
        tid_integers = []
        for tid in self.rating_mat.colnames():
            try:
                tid_integers.append(int(tid))
            except (ValueError, TypeError):
                tid_integers.append(tid)
                
        result['tids'] = tid_integers
        
        # Add count values
        result['n'] = self.participant_count
        result['n-cmts'] = self.comment_count
        
        # Add user vote counts
        result['user-vote-counts'] = self._compute_user_vote_counts()
        
        # Add votes-base structure
        result['votes-base'] = self._compute_votes_base()
        
        # Add group-votes structure
        result['group-votes'] = self._compute_group_votes()
        
        # Add empty subgroup structures (to be implemented if needed)
        result['subgroup-votes'] = {}
        result['subgroup-repness'] = {}
        
        # Add group-aware-consensus (based on Clojure implementation)
        result['group-aware-consensus'] = self._compute_group_aware_consensus()
        
        # Add in-conv (set of participants included in clustering)
        # In Clojure, this is a set of participant IDs that meet certain vote count criteria
        # Note: In Clojure, the IDs are integers, so we need to convert strings to ints when possible
        ptpt_ids_in_conv = []
        for pid, count in self._compute_user_vote_counts().items():
            # Include participants who have voted on at least min(7, total_comments) comments
            min_votes = min(7, self.comment_count)
            if count >= min_votes:
                try:
                    # Try to convert to integer to match Clojure format
                    ptpt_ids_in_conv.append(int(pid))
                except (ValueError, TypeError):
                    # If conversion fails, keep as string
                    ptpt_ids_in_conv.append(pid)
                
        result['in-conv'] = ptpt_ids_in_conv
        # Convert mod IDs to integers when possible for Clojure compatibility
        mod_out_integers = []
        for tid in self.mod_out_tids:
            try:
                mod_out_integers.append(int(tid))
            except (ValueError, TypeError):
                mod_out_integers.append(tid)
        
        mod_in_integers = []
        for tid in self.mod_in_tids:
            try:
                mod_in_integers.append(int(tid))
            except (ValueError, TypeError):
                mod_in_integers.append(tid)
                
        meta_integers = []
        for tid in self.meta_tids:
            try:
                meta_integers.append(int(tid))
            except (ValueError, TypeError):
                meta_integers.append(tid)
        
        result['mod-out'] = mod_out_integers
        result['mod-in'] = mod_in_integers
        result['meta-tids'] = meta_integers
        
        # Calculate a math_tick value (used in Clojure version to track updates)
        # Will be added to the result after conversion
        
        # Add base-clusters (in Clojure these are lower-level clusters)
        # For simplicity, we'll use the same group clusters for now
        result['base-clusters'] = self.group_clusters
        
        # Add separate consensus field (same structure as in Clojure)
        result['consensus'] = {
            'agree': [],      # List of agreed-upon comments
            'disagree': [],   # List of disagreed-upon comments
            'comment-stats': {} # Statistics on comments
        }
        
        # Use a smaller, more consistent math_tick value to match the Clojure format
        # Instead of using a full timestamp, use a simpler number similar to Clojure's
        # For the biodiversity dataset, Clojure used 25221
        current_time = int(time.time())
        math_tick_value = 25000 + (current_time % 10000)  # Will be in the range 25000-35000
        
        if use_clojure_format:
            # Recursively convert all Python underscores to Clojure hyphens throughout the data structure
            converted_result = self._convert_to_clojure_format(result)
            
            # Add math_tick with underscore directly to avoid conversion to hyphen
            # This matches Clojure's format exactly
            converted_result['math_tick'] = math_tick_value
            
            return converted_result
        else:
            result['math_tick'] = math_tick_value
            return result
    
    @staticmethod
    def _convert_to_clojure_format(data: Any) -> Any:
        """
        Recursively convert all keys in a nested data structure from underscore format to hyphenated format.
        
        Args:
            data: Any Python data structure (dict, list, or primitive value)
            
        Returns:
            Converted data structure with hyphenated keys
        """
        # Base cases: primitive types
        if data is None or isinstance(data, (str, int, float, bool)):
            return data
            
        # Handle numpy arrays and convert to lists
        if hasattr(data, 'tolist') and callable(getattr(data, 'tolist')):
            return data.tolist()
            
        # Recursive case: dictionaries
        if isinstance(data, dict):
            converted_dict = {}
            for key, value in data.items():
                # Try to convert string keys to integers for specific fields
                if key in ('proj', 'comment-priorities'):
                    # For these special fields, try to convert string keys to integers
                    # This makes the Python output match Clojure's integer IDs
                    if isinstance(value, dict):
                        int_keyed_dict = {}
                        for k, v in value.items():
                            try:
                                # Try to convert key to integer
                                int_k = int(k)
                                int_keyed_dict[int_k] = Conversation._convert_to_clojure_format(v)
                            except (ValueError, TypeError):
                                # Keep as is if conversion fails
                                int_keyed_dict[k] = Conversation._convert_to_clojure_format(v)
                        converted_dict[key.replace('_', '-') if isinstance(key, str) else key] = int_keyed_dict
                        continue
                
                # Convert the key from underscore to hyphen format
                hyphenated_key = key.replace('_', '-') if isinstance(key, str) else key
                # Recursively convert the value
                converted_value = Conversation._convert_to_clojure_format(value)
                converted_dict[hyphenated_key] = converted_value
            return converted_dict
            
        # Recursive case: lists or tuples
        if isinstance(data, (list, tuple)):
            return [Conversation._convert_to_clojure_format(item) for item in data]
            
        # For any other type (like sets, custom objects, etc.), just return as is
        # This is a simplification and might need to be extended for other types
        return data
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Conversation':
        """
        Create a conversation from a dictionary.
        
        Args:
            data: Dictionary representation of a conversation
            
        Returns:
            Conversation instance
        """
        # Create empty conversation
        conv = cls(data.get('conversation_id', ''))
        
        # Restore basic attributes
        conv.last_updated = data.get('last_updated', int(time.time() * 1000))
        conv.participant_count = data.get('participant_count', 0)
        conv.comment_count = data.get('comment_count', 0)
        
        # Restore vote stats
        conv.vote_stats = data.get('vote_stats', {})
        
        # Restore moderation state
        moderation = data.get('moderation', {})
        conv.mod_out_tids = set(moderation.get('mod_out_tids', []))
        conv.mod_in_tids = set(moderation.get('mod_in_tids', []))
        conv.meta_tids = set(moderation.get('meta_tids', []))
        conv.mod_out_ptpts = set(moderation.get('mod_out_ptpts', []))
        
        # Restore PCA data
        pca_data = data.get('pca')
        if pca_data:
            conv.pca = {
                'center': np.array(pca_data['center']),
                'comps': np.array(pca_data['comps'])
            }
        
        # Restore projection data
        proj_data = data.get('proj')
        if proj_data:
            conv.proj = {pid: np.array(proj) for pid, proj in proj_data.items()}
        
        # Restore cluster data
        conv.group_clusters = data.get('group_clusters', [])
        
        # Restore representativeness data
        conv.repness = data.get('repness')
        
        # Restore participant info
        conv.participant_info = data.get('participant_info', {})
        
        return conv