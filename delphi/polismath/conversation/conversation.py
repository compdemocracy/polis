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

from polismath.pca_kmeans_rep.named_matrix import NamedMatrix
from polismath.pca_kmeans_rep.pca import pca_project_named_matrix
from polismath.pca_kmeans_rep.clusters import cluster_named_matrix
from polismath.pca_kmeans_rep.repness import conv_repness, participant_stats
from polismath.pca_kmeans_rep.corr import compute_correlation
from polismath.utils.general import agree, disagree, pass_vote


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
        self.group_votes = {}  # Initialize group_votes to avoid attribute errors
        
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
        from polismath.pca_kmeans_rep.named_matrix import NamedMatrix
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
        from polismath.pca_kmeans_rep.clusters import cluster_named_matrix
        
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
    
    def _compute_participant_info_optimized(self, vote_matrix: NamedMatrix, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Optimized version of the participant info computation.
        
        Args:
            vote_matrix: The vote matrix containing participant votes
            group_clusters: The group clusters from clustering
            
        Returns:
            Dictionary with participant information including group correlations
        """
        import time
        start_time = time.time()
        
        if not group_clusters:
            return {}
        
        # Extract values and ensure they're numeric
        matrix_values = vote_matrix.values.copy()
        
        # Convert to numeric matrix with NaN for missing values
        if not np.issubdtype(matrix_values.dtype, np.number):
            numeric_values = np.zeros(matrix_values.shape, dtype=float)
            for i in range(matrix_values.shape[0]):
                for j in range(matrix_values.shape[1]):
                    val = matrix_values[i, j]
                    if pd.isna(val) or val is None:
                        numeric_values[i, j] = np.nan
                    else:
                        try:
                            numeric_values[i, j] = float(val)
                        except (ValueError, TypeError):
                            numeric_values[i, j] = np.nan
            matrix_values = numeric_values
        
        # Replace NaNs with zeros for correlation calculation
        matrix_values = np.nan_to_num(matrix_values, nan=0.0)
        
        # Create result structure
        result = {
            'participant_ids': vote_matrix.rownames(),
            'stats': {}
        }
        
        prep_time = time.time() - start_time
        logger.info(f"Participant stats prep time: {prep_time:.2f}s")
        
        # For each participant, calculate statistics
        participant_count = len(vote_matrix.rownames())
        logger.info(f"Processing statistics for {participant_count} participants...")
        
        # OPTIMIZATION 1: Precompute mappings and lookup tables
        
        # Precompute mapping of participant IDs to indices for faster lookups
        ptpt_idx_map = {ptpt_id: idx for idx, ptpt_id in enumerate(vote_matrix.rownames())}
        
        # Precompute group membership lookups
        ptpt_group_map = {}
        for group in group_clusters:
            for member in group.get('members', []):
                ptpt_group_map[member] = group.get('id', 0)
        
        # OPTIMIZATION 2: Precompute group data
        
        # Precompute group member indices for each group
        group_member_indices = {}
        for group in group_clusters:
            group_id = group.get('id', 0)
            member_indices = []
            for member in group.get('members', []):
                if member in ptpt_idx_map:
                    idx = ptpt_idx_map[member]
                    if 0 <= idx < matrix_values.shape[0]:
                        member_indices.append(idx)
            group_member_indices[group_id] = member_indices
        
        # OPTIMIZATION 3: Precompute group vote matrices and average votes
        
        # Precompute group vote matrices and their valid comment masks
        group_vote_matrices = {}
        group_avg_votes = {}
        group_valid_masks = {}
        
        for group_id, member_indices in group_member_indices.items():
            if len(member_indices) >= 3:  # Only calculate for groups with enough members
                # Extract the group vote matrix
                group_vote_matrix = matrix_values[member_indices, :]
                group_vote_matrices[group_id] = group_vote_matrix
                
                # Calculate average votes per comment for this group
                group_avg_votes[group_id] = np.mean(group_vote_matrix, axis=0)
                
                # Precompute which comments have at least 3 votes from this group
                group_valid_masks[group_id] = np.sum(group_vote_matrix != 0, axis=0) >= 3
        
        # OPTIMIZATION 4: Use vectorized operations for participant stats
        
        process_start = time.time()
        batch_start = time.time()
        
        for p_idx, participant_id in enumerate(vote_matrix.rownames()):
            if p_idx >= matrix_values.shape[0]:
                continue
                
            # Print progress for large participant sets
            if participant_count > 100 and p_idx % 100 == 0:
                now = time.time()
                elapsed = now - process_start
                batch_time = now - batch_start
                batch_start = now
                percent = (p_idx / participant_count) * 100
                logger.info(f"Processed {p_idx}/{participant_count} participants ({percent:.1f}%) - " +
                           f"Elapsed: {elapsed:.2f}s, Batch: {batch_time:.4f}s")
            
            # Get participant votes
            participant_votes = matrix_values[p_idx, :]
            
            # Count votes using vectorized operations
            n_agree = np.sum(participant_votes > 0)
            n_disagree = np.sum(participant_votes < 0)
            n_pass = np.sum(participant_votes == 0) 
            n_votes = n_agree + n_disagree
            
            # Skip participants with no votes
            if n_votes == 0:
                continue
                
            # Find participant's group using precomputed mapping
            participant_group = ptpt_group_map.get(participant_id)
            
            # OPTIMIZATION 5: Efficient group correlation calculation
            
            # Calculate agreement with each group - optimized version
            group_agreements = {}
            
            for group_id, member_indices in group_member_indices.items():
                if len(member_indices) < 3:
                    # Skip groups with too few members
                    group_agreements[group_id] = 0.0
                    continue
                
                if group_id not in group_avg_votes or group_id not in group_valid_masks:
                    group_agreements[group_id] = 0.0
                    continue
                    
                # Use precomputed data
                g_votes = group_avg_votes[group_id]
                valid_mask = group_valid_masks[group_id]
                
                if np.sum(valid_mask) >= 3:  # At least 3 valid comments
                    # Extract only valid comment votes
                    p_votes = participant_votes[valid_mask]
                    g_votes_valid = g_votes[valid_mask]
                    
                    # Fast correlation calculation
                    p_std = np.std(p_votes)
                    g_std = np.std(g_votes_valid)
                    
                    if p_std > 0 and g_std > 0:
                        # Use numpy's built-in correlation (faster and more numerically stable)
                        correlation = np.corrcoef(p_votes, g_votes_valid)[0, 1]
                        
                        if not np.isnan(correlation):
                            group_agreements[group_id] = correlation
                        else:
                            group_agreements[group_id] = 0.0
                    else:
                        group_agreements[group_id] = 0.0
                else:
                    group_agreements[group_id] = 0.0
            
            # Store participant stats
            result['stats'][participant_id] = {
                'n_agree': int(n_agree),
                'n_disagree': int(n_disagree),
                'n_pass': int(n_pass),
                'n_votes': int(n_votes),
                'group': participant_group,
                'group_correlations': group_agreements
            }
        
        total_time = time.time() - start_time
        process_time = time.time() - process_start
        logger.info(f"Participant stats completed in {total_time:.2f}s (preparation: {prep_time:.2f}s, processing: {process_time:.2f}s)")
        logger.info(f"Processed {len(result['stats'])} participants with {len(group_clusters)} groups")
        
        return result

    def _compute_participant_info(self) -> None:
        """
        Compute information about participants.
        """
        import time
        
        start_time = time.time()
        logger.info("Starting participant info computation...")
        
        # Check if we have groups
        if not self.group_clusters:
            self.participant_info = {}
            return
        
        # Use the integrated optimized version directly
        ptpt_stats = self._compute_participant_info_optimized(self.rating_mat, self.group_clusters)
        
        # Store results
        self.participant_info = ptpt_stats.get('stats', {})
        
        logger.info(f"Participant info computation completed in {time.time() - start_time:.2f}s")
    
    
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
        import time
        start_time = time.time()
        logger.info("Starting get_full_data conversion")
        
        # Base data
        base_start = time.time()
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
        logger.info(f"Base data setup: {time.time() - base_start:.4f}s")
        
        # Add PCA data
        pca_start = time.time()
        if self.pca:
            result['pca'] = {
                'center': self.pca['center'].tolist() if isinstance(self.pca['center'], np.ndarray) else self.pca['center'],
                'comps': [comp.tolist() if isinstance(comp, np.ndarray) else comp for comp in self.pca['comps']]
            }
        logger.info(f"PCA data conversion: {time.time() - pca_start:.4f}s")
        
        # Add projection data (this is often the largest and most time-consuming part)
        proj_start = time.time()
        if self.proj:
            proj_size = len(self.proj)
            logger.info(f"Converting projections for {proj_size} participants")
            
            # Use chunking for large projection sets
            if proj_size > 5000:
                result['proj'] = {}
                chunk_size = 1000
                chunks_processed = 0
                
                # Process in chunks to avoid memory issues
                keys = list(self.proj.keys())
                for i in range(0, proj_size, chunk_size):
                    chunk_start = time.time()
                    chunk_keys = keys[i:i+chunk_size]
                    
                    # Process this chunk
                    for pid in chunk_keys:
                        proj = self.proj[pid]
                        result['proj'][pid] = proj.tolist() if isinstance(proj, np.ndarray) else proj
                    
                    chunks_processed += 1
                    logger.info(f"Processed projection chunk {chunks_processed}: {time.time() - chunk_start:.4f}s for {len(chunk_keys)} participants")
            else:
                # Process all at once for smaller datasets
                result['proj'] = {pid: proj.tolist() if isinstance(proj, np.ndarray) else proj 
                                for pid, proj in self.proj.items()}
        logger.info(f"Projection data conversion: {time.time() - proj_start:.4f}s")
        
        # Add cluster data
        clusters_start = time.time()
        result['group_clusters'] = self.group_clusters
        logger.info(f"Clusters data: {time.time() - clusters_start:.4f}s")
        
        # Add representativeness data
        repness_start = time.time()
        if self.repness:
            result['repness'] = self.repness
        logger.info(f"Repness data: {time.time() - repness_start:.4f}s")
        
        # Add participant info
        ptpt_info_start = time.time()
        if self.participant_info:
            result['participant_info'] = self.participant_info
        logger.info(f"Participant info: {time.time() - ptpt_info_start:.4f}s")
        
        # Add comment priorities if available (matching Clojure format)
        priorities_start = time.time()
        if hasattr(self, 'comment_priorities') and self.comment_priorities:
            result['comment_priorities'] = self.comment_priorities
        logger.info(f"Comment priorities: {time.time() - priorities_start:.4f}s")
        
        logger.info(f"Total get_full_data time: {time.time() - start_time:.4f}s")
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
        import time
        start_time = time.time()
        logger.info(f"Starting _compute_user_vote_counts for {len(self.rating_mat.rownames())} participants")
        
        vote_counts = {}
        
        # Use more efficient approach for large datasets
        if len(self.rating_mat.rownames()) > 1000:
            # Create a mask of non-nan values across the entire matrix
            non_nan_mask = ~np.isnan(self.rating_mat.values)
            
            # Sum across rows using vectorized operation
            row_sums = np.sum(non_nan_mask, axis=1)
            
            # Convert to dictionary
            for i, pid in enumerate(self.rating_mat.rownames()):
                if i < len(row_sums):
                    vote_counts[pid] = int(row_sums[i])
                else:
                    # Fallback if dimensions don't match
                    vote_counts[pid] = 0
                    
            logger.info(f"Computed vote counts for {len(vote_counts)} participants using vectorized approach in {time.time() - start_time:.4f}s")
        else:
            # Original approach for smaller datasets
            for i, pid in enumerate(self.rating_mat.rownames()):
                # Get row of votes for this participant
                row = self.rating_mat.values[i, :]
                
                # Count non-nan values
                count = np.sum(~np.isnan(row))
                
                # Store count
                vote_counts[pid] = int(count)
            
            logger.info(f"Computed vote counts for {len(vote_counts)} participants using original approach in {time.time() - start_time:.4f}s")
            
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
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Convert the conversation to a dictionary for serialization.
        Optimized version that handles large datasets efficiently.
        
        Returns:
            Dictionary representation of the conversation
        """
        import numpy as np
        import time
        
        # Start timing
        overall_start_time = time.time()
        logger.info(f"Starting optimized to_dict conversion")
        
        # Initialize with basic attributes - build directly rather than using get_full_data
        base_start = time.time()
        result = {
            'conversation_id': self.conversation_id,
            'last_updated': self.last_updated,
            'participant_count': self.participant_count,
            'comment_count': self.comment_count,
            'vote_stats': self.vote_stats
        }
        
        # Add moderation data
        result['moderation'] = {
            'mod_out_tids': list(self.mod_out_tids),
            'mod_in_tids': list(self.mod_in_tids),
            'meta_tids': list(self.meta_tids),
            'mod_out_ptpts': list(self.mod_out_ptpts)
        }
        
        # Add PCA data efficiently
        if self.pca:
            # Function to safely convert numpy arrays to lists
            def numpy_to_list(arr):
                if isinstance(arr, np.ndarray):
                    return arr.tolist()
                elif isinstance(arr, list):
                    return [numpy_to_list(x) for x in arr]
                return arr
            
            result['pca'] = {
                'center': numpy_to_list(self.pca['center']),
                'comps': numpy_to_list(self.pca['comps'])
            }
        
        # Add projection data efficiently (chunked for large datasets)
        if self.proj:
            proj_start = time.time()
            proj_size = len(self.proj)
            logger.info(f"Converting projections for {proj_size} participants")
            
            result['proj'] = {}
            
            # Use chunking for large projection sets
            if proj_size > 5000:
                chunk_size = 1000
                keys = list(self.proj.keys())
                
                for i in range(0, proj_size, chunk_size):
                    chunk_start = time.time()
                    chunk_keys = keys[i:i+chunk_size]
                    
                    # Process this chunk using dictionary comprehension
                    result['proj'].update({
                        pid: proj.tolist() if isinstance(proj, np.ndarray) else proj
                        for pid, proj in ((pid, self.proj[pid]) for pid in chunk_keys)
                    })
                    
                    logger.info(f"Processed projection chunk {i//chunk_size + 1}: {time.time() - chunk_start:.4f}s")
            else:
                # Process all at once for smaller datasets
                result['proj'] = {
                    pid: proj.tolist() if isinstance(proj, np.ndarray) else proj 
                    for pid, proj in self.proj.items()
                }
            
            logger.info(f"Projection data conversion: {time.time() - proj_start:.4f}s")
        
        # Add clusters data
        result['group_clusters'] = self.group_clusters
        
        # Add representativeness data
        if self.repness:
            result['repness'] = self.repness
            
        # Add participant info
        if self.participant_info:
            result['participant_info'] = self.participant_info
            
        # Add comment priorities if available
        if hasattr(self, 'comment_priorities') and self.comment_priorities:
            result['comment_priorities'] = self.comment_priorities
            
        logger.info(f"Base data setup: {time.time() - base_start:.4f}s")
        
        # Now add the Clojure-specific format data
        clojure_start = time.time()
        
        # Rename conversation_id to zid and add timestamps
        result['zid'] = result.pop('conversation_id')
        result['lastVoteTimestamp'] = self.last_updated
        result['lastModTimestamp'] = self.last_updated
        
        # Convert and add tids (comment IDs) efficiently
        # Using a list comprehension with try/except inline for performance
        result['tids'] = [
            int(tid) if tid.isdigit() else tid 
            for tid in self.rating_mat.colnames()
        ]
        
        # Add count values with Clojure naming
        result['n'] = self.participant_count
        result['n-cmts'] = self.comment_count
        
        # Add user vote counts with vectorized operations
        vote_counts_start = time.time()
        
        # Use more efficient batch processing approach from to_dynamo_dict
        user_vote_counts = {}
        if len(self.rating_mat.rownames()) > 0:
            # Create a mask of non-nan values and sum across rows
            non_nan_mask = ~np.isnan(self.rating_mat.values)
            row_sums = np.sum(non_nan_mask, axis=1)
            
            # Convert to dictionary with integer keys where possible
            for i, pid in enumerate(self.rating_mat.rownames()):
                if i < len(row_sums):
                    # Try to convert participant ID to integer for Clojure compatibility
                    try:
                        user_vote_counts[int(pid)] = int(row_sums[i])
                    except (ValueError, TypeError):
                        user_vote_counts[pid] = int(row_sums[i])
        
        result['user-vote-counts'] = user_vote_counts
        logger.info(f"User vote counts: {time.time() - vote_counts_start:.4f}s")
        
        # Calculate votes-base efficiently with vectorized operations
        votes_base_start = time.time()
        
        # Create pre-calculated masks for agree/disagree votes
        agree_mask = np.abs(self.rating_mat.values - 1.0) < 0.001
        disagree_mask = np.abs(self.rating_mat.values + 1.0) < 0.001
        valid_mask = ~np.isnan(self.rating_mat.values)
        
        # Compute votes base with vectorized operations
        votes_base = {}
        for j, tid in enumerate(self.rating_mat.colnames()):
            if j >= self.rating_mat.values.shape[1]:
                continue
                
            # Calculate vote stats with vectorized operations
            col_agree = np.sum(agree_mask[:, j])
            col_disagree = np.sum(disagree_mask[:, j])
            col_total = np.sum(valid_mask[:, j])
            
            # Try to convert tid to int for Clojure compatibility
            try:
                votes_base[int(tid)] = {'A': int(col_agree), 'D': int(col_disagree), 'S': int(col_total)}
            except (ValueError, TypeError):
                votes_base[tid] = {'A': int(col_agree), 'D': int(col_disagree), 'S': int(col_total)}
        
        result['votes-base'] = votes_base
        logger.info(f"Votes base: {time.time() - votes_base_start:.4f}s")
        
        # Compute group votes with optimized approach
        group_votes_start = time.time()
        
        # Use the optimized implementation similar to to_dynamo_dict
        group_votes = {}
        
        if self.group_clusters:
            # Precompute indices for each participant for faster lookups
            ptpt_indices = {ptpt_id: i for i, ptpt_id in enumerate(self.rating_mat.rownames())}
            
            # Process each group
            for group in self.group_clusters:
                group_id = group.get('id')
                if group_id is None:
                    continue
                
                # Get indices for all members of this group
                member_indices = []
                for member in group.get('members', []):
                    idx = ptpt_indices.get(member)
                    if idx is not None and idx < self.rating_mat.values.shape[0]:
                        member_indices.append(idx)
                
                # Skip groups with no valid members
                if not member_indices:
                    continue
                
                # Get the vote submatrix for this group
                group_matrix = self.rating_mat.values[member_indices, :]
                
                # Calculate vote stats for each comment using vectorized operations
                votes = {}
                for j, comment_id in enumerate(self.rating_mat.colnames()):
                    if j >= group_matrix.shape[1]:
                        continue
                    
                    # Extract column and calculate votes
                    col = group_matrix[:, j]
                    agree_votes = np.sum(np.abs(col - 1.0) < 0.001)
                    disagree_votes = np.sum(np.abs(col + 1.0) < 0.001)
                    total_votes = np.sum(~np.isnan(col))
                    
                    # Try to convert comment_id to int
                    try:
                        cid = int(comment_id)
                    except (ValueError, TypeError):
                        cid = comment_id
                    
                    # Store in result with Clojure-compatible format
                    votes[cid] = {'A': int(agree_votes), 'D': int(disagree_votes), 'S': int(total_votes)}
                
                # Store this group's data
                group_votes[str(group_id)] = {
                    'n-members': len(member_indices),
                    'votes': votes
                }
                
        result['group-votes'] = group_votes
        logger.info(f"Group votes: {time.time() - group_votes_start:.4f}s")
        
        # Add empty subgroup structures
        result['subgroup-votes'] = {}
        result['subgroup-repness'] = {}
        
        # Initialize group_votes if missing to avoid errors
        if not hasattr(self, 'group_votes'):
            logger.info("Adding empty group_votes attribute")
            self.group_votes = {}
        
        # Add group-aware consensus with optimized calculation
        consensus_start = time.time()
        group_consensus = {}
        
        # Compute in one pass using existing structure
        if 'group-votes' in result:
            # Store consensus values per comment ID
            for tid in self.rating_mat.colnames():
                # Try converting to integer for consistent keys
                try:
                    tid_key = int(tid)
                except (ValueError, TypeError):
                    tid_key = tid
                
                # Start with consensus value of 1
                consensus_value = 1.0
                has_data = False
                
                # Multiply probabilities from all groups (same as reduce * in Clojure)
                for gid, gid_data in result['group-votes'].items():
                    votes_data = gid_data.get('votes', {})
                    
                    if tid_key in votes_data:
                        vote_stats = votes_data[tid_key]
                        agree_count = vote_stats.get('A', 0)
                        total_count = vote_stats.get('S', 0)
                        
                        # Calculate probability with Laplace smoothing
                        if total_count > 0:
                            prob = (agree_count + 1.0) / (total_count + 2.0)
                            consensus_value *= prob
                            has_data = True
                
                # Only store if we have actual data
                if has_data:
                    group_consensus[tid_key] = consensus_value
        
        result['group-aware-consensus'] = group_consensus
        logger.info(f"Group consensus: {time.time() - consensus_start:.4f}s")
        
        # Calculate in-conv participants
        in_conv_start = time.time()
        
        # Use pre-calculated vote counts to avoid recalculation
        in_conv = []
        min_votes = min(7, self.comment_count)
        
        for pid, count in result['user-vote-counts'].items():
            if count >= min_votes:
                in_conv.append(pid)  # pid is already converted to int where possible
        
        result['in-conv'] = in_conv
        logger.info(f"In-conv: {time.time() - in_conv_start:.4f}s")
        
        # Convert moderation IDs to integers when possible
        mod_start = time.time()
        
        # Convert moderation lists with list comprehensions for performance
        result['mod-out'] = [
            int(tid) if isinstance(tid, str) and tid.isdigit() else tid 
            for tid in self.mod_out_tids
        ]
        
        result['mod-in'] = [
            int(tid) if isinstance(tid, str) and tid.isdigit() else tid 
            for tid in self.mod_in_tids
        ]
        
        result['meta-tids'] = [
            int(tid) if isinstance(tid, str) and tid.isdigit() else tid 
            for tid in self.meta_tids
        ]
        
        logger.info(f"Moderation data: {time.time() - mod_start:.4f}s")
        
        # Add base clusters (same as group clusters)
        result['base-clusters'] = self.group_clusters
        
        # Add empty consensus structure for compatibility
        result['consensus'] = {
            'agree': [],
            'disagree': [],
            'comment-stats': {}
        }
        
        # Add math_tick value
        current_time = int(time.time())
        math_tick_value = 25000 + (current_time % 10000)  # Range 25000-35000
        
        logger.info(f"Clojure format setup: {time.time() - clojure_start:.4f}s")
        
        # Add math_tick value and return
        result['math_tick'] = math_tick_value
        logger.info(f"Total to_dict time: {time.time() - overall_start_time:.4f}s")
        return result
    
    def _convert_structure(self, data):
        """
        Optimized conversion of nested data structures for Clojure compatibility.
        Much faster than the full recursive conversion.
        
        Args:
            data: The data structure to convert
            
        Returns:
            Converted data structure
        """
        import numpy as np
        
        # For primitive types, just return
        if data is None or isinstance(data, (int, float, bool, str)):
            return data
            
        # For numpy arrays, convert to list
        if isinstance(data, np.ndarray):
            return data.tolist()
            
        # For lists, convert each element
        if isinstance(data, list):
            return [self._convert_structure(item) for item in data]
            
        # For dictionaries, convert keys and values
        if isinstance(data, dict):
            result = {}
            for k, v in data.items():
                # Convert key if it's a string
                new_key = k.replace('_', '-') if isinstance(k, str) else k
                
                # Convert value
                result[new_key] = self._convert_structure(v)
                
            return result
            
        # For any other type, return as is
        return data
    
    # Cache for memoization to avoid repeating conversions
    _conversion_cache = {}
    
    @staticmethod
    def _convert_to_clojure_format(data: Any) -> Any:
        """
        Recursively convert all keys in a nested data structure from underscore format to hyphenated format.
        
        Args:
            data: Any Python data structure (dict, list, or primitive value)
            
        Returns:
            Converted data structure with hyphenated keys
        """
        import time
        detail_start = time.time()
        
        # Count objects processed for debugging
        processed_count = {
            'dict': 0,
            'list': 0,
            'tuple': 0,
            'primitive': 0,
            'numpy': 0,
            'cache_hit': 0,
            'total': 0
        }
        
        def _convert_inner(data, depth=0):
            processed_count['total'] += 1
            
            # For immutable types, use memoization to avoid re-processing
            if isinstance(data, (str, int, float, bool, tuple)) or data is None:
                # We can only cache immutable types as dict keys
                cache_key = (id(data), str(type(data))) if isinstance(data, tuple) else data
                
                if cache_key in Conversation._conversion_cache:
                    processed_count['cache_hit'] += 1
                    return Conversation._conversion_cache[cache_key]
            
            # Base cases: primitive types
            if data is None or isinstance(data, (str, int, float, bool)):
                processed_count['primitive'] += 1
                Conversation._conversion_cache[data] = data
                return data
                
            # Handle numpy arrays and convert to lists
            if hasattr(data, 'tolist') and callable(getattr(data, 'tolist')):
                processed_count['numpy'] += 1
                result = data.tolist()
                return result
            
            # Special case for empty dictionaries and lists to avoid recursion
            if isinstance(data, dict) and not data:
                return {}
            if isinstance(data, (list, tuple)) and not data:
                return []
                
            # Recursive case: dictionaries
            if isinstance(data, dict):
                processed_count['dict'] += 1
                dict_start = time.time()
                
                # Special optimization for large dictionaries:
                # Pre-process all string keys at once to avoid repeated string replacements
                keys_map_start = time.time()
                keys_map = {k: k.replace('_', '-') if isinstance(k, str) else k for k in data.keys()}
                keys_map_time = time.time() - keys_map_start
                
                # Debug for large dictionaries
                if len(data) > 1000 and depth == 0:
                    logger.info(f"Processing large dictionary with {len(data)} keys, keys_map time: {keys_map_time:.4f}s")
                
                converted_dict = {}
                special_cases_time = 0
                regular_cases_time = 0
                
                for key, value in data.items():
                    # Handle special cases where we need to try converting string keys to integers
                    if key in ('proj', 'comment-priorities'):
                        special_start = time.time()
                        if isinstance(value, dict):
                            # Process this special dictionary more efficiently
                            int_keyed_dict = {}
                            for k, v in value.items():
                                try:
                                    # Try to convert key to integer
                                    int_k = int(k)
                                    int_keyed_dict[int_k] = _convert_inner(v, depth+1)
                                except (ValueError, TypeError):
                                    # Keep as is if conversion fails
                                    int_keyed_dict[k] = _convert_inner(v, depth+1)
                            converted_dict[keys_map[key]] = int_keyed_dict
                            special_cases_time += time.time() - special_start
                            continue
                    
                    # For regular keys, use the pre-computed hyphenated key
                    regular_start = time.time()
                    converted_dict[keys_map[key]] = _convert_inner(value, depth+1)
                    regular_cases_time += time.time() - regular_start
                
                # Debug for large dictionaries or projection data (which is typically the largest)
                if (len(data) > 1000 or key == 'proj') and depth == 0:
                    total_dict_time = time.time() - dict_start
                    logger.info(f"Dictionary processing: total={total_dict_time:.4f}s, special={special_cases_time:.4f}s, regular={regular_cases_time:.4f}s")
                
                return converted_dict
                
            # Recursive case: lists or tuples
            if isinstance(data, (list, tuple)):
                if isinstance(data, list):
                    processed_count['list'] += 1
                else:
                    processed_count['tuple'] += 1
                
                # Debug for large lists
                list_start = time.time()
                if len(data) > 1000 and depth == 0:
                    logger.info(f"Processing large list with {len(data)} items")
                
                # For tuples, we'll cache the result
                result = [_convert_inner(item, depth+1) for item in data]
                
                # Debug for large lists
                if len(data) > 1000 and depth == 0:
                    logger.info(f"Large list processing completed in {time.time() - list_start:.4f}s")
                
                if isinstance(data, tuple):
                    # We need to use an ID-based key for tuples
                    cache_key = (id(data), str(type(data)))
                    Conversation._conversion_cache[cache_key] = result
                    
                return result
                
            # For any other type (like sets, custom objects, etc.), just return as is
            return data
        
        # Start the conversion process
        result = _convert_inner(data)
        
        # Log summary statistics
        detail_time = time.time() - detail_start
        if processed_count['total'] > 1000:
            logger.info(f"Conversion stats: processed {processed_count['total']} objects in {detail_time:.4f}s")
            logger.info(f"    - Dictionaries: {processed_count['dict']}")
            logger.info(f"    - Lists: {processed_count['list']}")
            logger.info(f"    - Tuples: {processed_count['tuple']}")
            logger.info(f"    - Primitives: {processed_count['primitive']}")
            logger.info(f"    - NumPy arrays: {processed_count['numpy']}")
            logger.info(f"    - Cache hits: {processed_count['cache_hit']}")
            
            if processed_count['dict'] > 0:
                logger.info(f"    - Average time per object: {(detail_time/processed_count['total'])*1000:.4f}ms")
            
            cache_size = len(Conversation._conversion_cache)
            logger.info(f"    - Cache size: {cache_size} entries")
        
        return result
    
    # Reset the conversion cache whenever needed
    @staticmethod
    def _reset_conversion_cache():
        """Clear the conversion cache to free memory."""
        Conversation._conversion_cache = {}
    
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
        
        # Restore comment priorities if available
        if 'comment_priorities' in data:
            conv.comment_priorities = data.get('comment_priorities', {})
        
        return conv
        
    def to_dynamo_dict(self) -> Dict[str, Any]:
        """
        Convert the conversation to a dictionary optimized for DynamoDB export.
        This method is specifically optimized for performance with large datasets
        and uses Python-native naming conventions (underscores instead of hyphens).
        
        Returns:
            Dictionary representation optimized for DynamoDB
        """
        import numpy as np
        import time
        import decimal
        
        # Start timing
        start_time = time.time()
        logger.info("Starting conversion to DynamoDB format...")
        
        # Initialize result with basic attributes
        result = {
            'zid': self.conversation_id,
            'last_updated': self.last_updated,
            'last_vote_timestamp': self.last_updated,
            'last_mod_timestamp': self.last_updated,
            'participant_count': self.participant_count,
            'comment_count': self.comment_count,
            'group_count': len(self.group_clusters) if hasattr(self, 'group_clusters') else 0
        }
        
        # Function to convert numpy arrays to lists
        def numpy_to_list(obj):
            if isinstance(obj, np.ndarray):
                return obj.tolist()
            elif isinstance(obj, list):
                return [numpy_to_list(item) for item in obj]
            elif isinstance(obj, dict):
                return {k: numpy_to_list(v) for k, v in obj.items()}
            elif isinstance(obj, (np.int64, np.int32, np.int16, np.int8)):
                return int(obj)
            elif isinstance(obj, (np.float64, np.float32, np.float16)):
                return float(obj)
            return obj
        
        # Function to convert floats to Decimal for DynamoDB compatibility
        def float_to_decimal(obj):
            if isinstance(obj, float):
                return decimal.Decimal(str(obj))
            elif isinstance(obj, dict):
                return {k: float_to_decimal(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [float_to_decimal(x) for x in obj]
            return obj
        
        # Add comment IDs list (tids)
        logger.info(f"[{time.time() - start_time:.2f}s] Processing comment IDs...")
        tid_integers = []
        for tid in self.rating_mat.colnames():
            try:
                tid_integers.append(int(tid))
            except (ValueError, TypeError):
                tid_integers.append(tid)
        result['comment_ids'] = tid_integers
        
        # Add moderation data with integer conversion where possible
        logger.info(f"[{time.time() - start_time:.2f}s] Processing moderation data...")
        result['moderated_out'] = []
        for tid in self.mod_out_tids:
            try:
                result['moderated_out'].append(int(tid))
            except (ValueError, TypeError):
                result['moderated_out'].append(tid)
        
        result['moderated_in'] = []
        for tid in self.mod_in_tids:
            try:
                result['moderated_in'].append(int(tid))
            except (ValueError, TypeError):
                result['moderated_in'].append(tid)
        
        result['meta_comments'] = []
        for tid in self.meta_tids:
            try:
                result['meta_comments'].append(int(tid))
            except (ValueError, TypeError):
                result['meta_comments'].append(tid)
        
        # Add user vote counts (more efficient approach)
        logger.info(f"[{time.time() - start_time:.2f}s] Computing user vote counts...")
        user_vote_counts = {}
        for i, pid in enumerate(self.rating_mat.rownames()):
            # Skip if index is out of bounds
            if i >= self.rating_mat.values.shape[0]:
                continue
                
            # Count votes with efficient numpy operations
            row = self.rating_mat.values[i, :]
            count = int(np.sum(~np.isnan(row)))
            
            # Try to convert pid to int for DynamoDB
            try:
                user_vote_counts[int(pid)] = count
            except (ValueError, TypeError):
                user_vote_counts[pid] = count
        
        result['user_vote_counts'] = user_vote_counts
        
        # Calculate included participants (meeting vote threshold)
        logger.info(f"[{time.time() - start_time:.2f}s] Computing included participants...")
        included_participants = []
        min_votes = min(7, self.comment_count)
        
        for pid, count in user_vote_counts.items():
            if count >= min_votes:
                included_participants.append(pid)  # Already converted above
        
        result['included_participants'] = included_participants
        
        # Add votes base structure (optimized batch conversion)
        logger.info(f"[{time.time() - start_time:.2f}s] Computing votes base structure...")
        votes_base_start = time.time()
        votes_base = {}
        
        # Pre-identify agree, disagree, and voteless masks
        agree_mask = np.abs(self.rating_mat.values - 1.0) < 0.001
        disagree_mask = np.abs(self.rating_mat.values + 1.0) < 0.001
        valid_mask = ~np.isnan(self.rating_mat.values)
        
        # Process column by column
        for j, tid in enumerate(self.rating_mat.colnames()):
            if j >= self.rating_mat.values.shape[1]:
                continue
                
            # Get the column
            try:
                # Calculate stats with vectorized operations
                col_agree = np.sum(agree_mask[:, j])
                col_disagree = np.sum(disagree_mask[:, j])
                col_total = np.sum(valid_mask[:, j])
                
                # Try to convert tid to int for compatibility
                try:
                    votes_base[int(tid)] = {'agree': int(col_agree), 'disagree': int(col_disagree), 'total': int(col_total)}
                except (ValueError, TypeError):
                    votes_base[tid] = {'agree': int(col_agree), 'disagree': int(col_disagree), 'total': int(col_total)}
            except (IndexError, ValueError, TypeError):
                # Handle any errors gracefully
                continue
        
        logger.info(f"[{time.time() - start_time:.2f}s] votes_base computed in {time.time() - votes_base_start:.2f}s")
        result['votes_base'] = votes_base
        
        # Compute group votes structure with optimized approach
        logger.info(f"[{time.time() - start_time:.2f}s] Computing group votes structure...")
        group_votes_start = time.time()
        
        # Initialize with empty structure
        result['group_votes'] = {}
        
        # Process groups only if they exist
        if self.group_clusters:
            # Precompute indices for each participant
            ptpt_indices = {}
            for i, ptpt_id in enumerate(self.rating_mat.rownames()):
                ptpt_indices[ptpt_id] = i
            
            # Process each group
            for group in self.group_clusters:
                group_id = group.get('id')
                if group_id is None:
                    continue
                
                # Get indices for group members
                member_indices = []
                for member in group.get('members', []):
                    idx = ptpt_indices.get(member)
                    if idx is not None and idx < self.rating_mat.values.shape[0]:
                        member_indices.append(idx)
                
                # Skip groups with no valid members
                if not member_indices:
                    continue
                
                # Get the submatrix for this group
                group_matrix = self.rating_mat.values[member_indices, :]
                
                # Calculate votes for each comment
                group_votes = {}
                for j, comment_id in enumerate(self.rating_mat.colnames()):
                    if j >= group_matrix.shape[1]:
                        continue
                        
                    # Extract the column for this comment
                    col = group_matrix[:, j]
                    
                    # Calculate vote counts
                    agree_votes = np.sum(np.abs(col - 1.0) < 0.001)
                    disagree_votes = np.sum(np.abs(col + 1.0) < 0.001)
                    total_votes = np.sum(~np.isnan(col))
                    
                    # Try to convert comment_id to int
                    try:
                        cid = int(comment_id)
                    except (ValueError, TypeError):
                        cid = comment_id
                        
                    # Store in result
                    group_votes[cid] = {
                        'agree': int(agree_votes), 
                        'disagree': int(disagree_votes), 
                        'total': int(total_votes)
                    }
                
                # Add this group's data to result
                result['group_votes'][str(group_id)] = {
                    'member_count': len(member_indices),
                    'votes': group_votes
                }
        
        logger.info(f"[{time.time() - start_time:.2f}s] group_votes computed in {time.time() - group_votes_start:.2f}s")
        
        # Add empty subgroup structures (to be implemented if needed)
        result['subgroup_votes'] = {}
        result['subgroup_repness'] = {}
        
        # Add group-aware consensus
        logger.info(f"[{time.time() - start_time:.2f}s] Computing group consensus values...")
        consensus_start = time.time()
        
        # Simplified implementation
        result['group_consensus'] = {}
        if self.group_clusters and 'group_votes' in result:
            group_votes = result['group_votes']
            
            # Process each comment across all groups
            for tid in self.rating_mat.colnames():
                try:
                    tid_key = int(tid)
                except (ValueError, TypeError):
                    tid_key = tid
                
                # Calculate consensus by group probabilities
                consensus_value = 1.0
                group_probs = {}
                
                # Collect probabilities for all groups
                for gid, gid_stats in group_votes.items():
                    votes_data = gid_stats.get('votes', {})
                    if tid_key in votes_data:
                        vote_stats = votes_data[tid_key]
                        # Get vote counts with defaults
                        agree_count = vote_stats.get('agree', 0)
                        total_count = vote_stats.get('total', 0)
                        
                        # Calculate probability with Laplace smoothing
                        prob = (agree_count + 1.0) / (total_count + 2.0)
                        group_probs[gid] = prob
                
                # Multiply probabilities for consensus
                if group_probs:
                    for prob in group_probs.values():
                        consensus_value *= prob
                    
                    # Store result with decimal conversion for DynamoDB
                    result['group_consensus'][tid_key] = decimal.Decimal(str(consensus_value))
        
        logger.info(f"[{time.time() - start_time:.2f}s] group_consensus computed in {time.time() - consensus_start:.2f}s")
        
        # Add base-clusters and PCA data
        logger.info(f"[{time.time() - start_time:.2f}s] Processing PCA and cluster data...")
        
        # Convert group clusters
        base_clusters = []
        for cluster in self.group_clusters:
            # Convert to a dict without numpy arrays
            clean_cluster = {
                'id': cluster.get('id'),
                'members': cluster.get('members', []),
                'center': numpy_to_list(cluster.get('center', [])),
            }
            base_clusters.append(clean_cluster)
        
        # Convert to decimals for DynamoDB
        result['base_clusters'] = float_to_decimal(base_clusters)
        result['group_clusters'] = result['base_clusters']  # Same data
        
        # Process PCA data
        if self.pca:
            pca_data = {
                'center': numpy_to_list(self.pca.get('center', [])),
                'components': numpy_to_list(self.pca.get('comps', []))
            }
            result['pca'] = float_to_decimal(pca_data)
        
        # Add consensus structure
        result['consensus'] = {
            'agree': [],
            'disagree': [],
            'comment_stats': {}
        }
        
        # Add math_tick value
        current_time = int(time.time())
        math_tick = 25000 + (current_time % 10000)
        result['math_tick'] = math_tick
        
        # Process comment priorities
        if hasattr(self, 'comment_priorities') and self.comment_priorities:
            logger.info(f"[{time.time() - start_time:.2f}s] Processing comment priorities...")
            priorities = {}
            for cid, priority in self.comment_priorities.items():
                try:
                    priorities[int(cid)] = int(priority)
                except (ValueError, TypeError):
                    priorities[cid] = int(priority)
            result['comment_priorities'] = priorities
        
        # Process repness data efficiently
        if self.repness and 'comment_repness' in self.repness:
            logger.info(f"[{time.time() - start_time:.2f}s] Processing representativeness data...")
            repness_start = time.time()
            
            # Process in batch to be more efficient
            repness_data = []
            for item in self.repness['comment_repness']:
                # Convert using try/except to handle mixed formats
                try:
                    gid = item.get('gid', 0)
                    tid = item.get('tid', '')
                    rep_value = item.get('repness', 0)
                    
                    # Try to convert tid to integer
                    try:
                        tid = int(tid)
                    except (ValueError, TypeError):
                        pass
                     
                    # Add to results with Decimal conversion for DynamoDB
                    repness_data.append({
                        'group_id': gid,
                        'comment_id': tid,
                        'repness': decimal.Decimal(str(rep_value))
                    })
                except Exception as e:
                    logger.warning(f"Error processing repness item: {e}")
            
            # Add to result
            result['repness'] = {
                'comment_repness': repness_data
            }
            
            logger.info(f"[{time.time() - start_time:.2f}s] Representativeness data processed in {time.time() - repness_start:.2f}s")
        
        # The proj attribute (participant projections) is handled separately by the DynamoDB client
        # for efficiency with large datasets
        
        logger.info(f"[{time.time() - start_time:.2f}s] Conversion to DynamoDB format completed")
        return result

    def export_to_dynamodb(self, dynamodb_client) -> bool:
        """
        Export conversation data directly to DynamoDB.
        
        Args:
            dynamodb_client: An initialized DynamoDBClient instance
            
        Returns:
            Success status
        """
        # Export the conversation data to DynamoDB
        logger.info(f"Exporting conversation {self.conversation_id} to DynamoDB")
        
        try:
            # Write everything in a single call, letting the DynamoDB client handle the details
            success = dynamodb_client.write_conversation(self)
            if not success:
                logger.error(f"Failed to write conversation {self.conversation_id} to DynamoDB")
            return success
        except Exception as e:
            logger.error(f"Exception during export to DynamoDB: {e}")
            import traceback
            logger.error(f"Traceback: {traceback.format_exc()}")
            return False
