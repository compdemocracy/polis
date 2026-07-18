"""
Core conversation management and processing for Pol.is.

This module handles mathematical processing of conversation data,
including votes, clustering, and representativeness calculation.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Set, Tuple, Union, Any, Callable
from copy import deepcopy
import time
import logging
import sys
from datetime import datetime
from natsort import natsorted

from polismath.pca_kmeans_rep.pca import (
    pca_project_dataframe,
    pca_project_cmnts,
    compute_comment_extremity,
)
from polismath.pca_kmeans_rep.clusters import (
    kmeans_sklearn,
    calculate_silhouette_sklearn
)
from polismath.pca_kmeans_rep.repness import conv_repness
from polismath.pca_kmeans_rep.corr import compute_correlation
from polismath.pca_kmeans_rep.group_k_smoother import group_k_smoother_update
from polismath.pca_kmeans_rep.legacy_kmeans import (
    _NamedData as _LegacyNamedData,
    kmeans as legacy_kmeans,
)
from polismath.utils.engine_mode import resolve_engine_mode, ENGINE_MODE_LEGACY


# Configure logging
logger = logging.getLogger(__name__)


def _base_clusters_to_legacy(base_clusters: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    """Convert stored base clusters ({id, center: list, members: pids}) into the
    legacy_kmeans warm-start form ({id, members, center: np.ndarray}).

    Returns None for empty/None input so the first tick cold-starts via
    init-clusters (Clojure: a falsey :last-clusters -> init-clusters,
    clusters.clj:305-307). PR-C warm-start plumbing for
    :last-clusters (:base-clusters conv) (conversation.clj:409).
    """
    if not base_clusters:
        return None
    return [
        {'id': c['id'],
         'members': list(c['members']),
         'center': np.asarray(c['center'], dtype=float)}
        for c in base_clusters
    ]


def _labels_from_id_clusters(row_names: List[Any],
                             clusters: List[Dict[str, Any]]) -> np.ndarray:
    """Label array aligned with ``row_names`` for silhouette scoring: the index
    (in ``clusters``) of the cluster that contains each name.

    Used at the group level to score a legacy (id-carrying) clustering with the
    same ``calculate_silhouette_sklearn`` the improved path uses, so the smoother
    sees comparable silhouettes. Every base cluster is assigned to exactly one
    group cluster by ``cluster-step``; a name that (degenerately) appears in none
    gets its own singleton label so it never silently merges into label 0.
    """
    label_by_name: Dict[Any, int] = {}
    for label, c in enumerate(clusters):
        for m in c['members']:
            label_by_name[m] = label
    next_label = len(clusters)
    labels = []
    for name in row_names:
        if name in label_by_name:
            labels.append(label_by_name[name])
        else:
            labels.append(next_label)
            next_label += 1
    return np.array(labels)

# Set up default logging only if root logger is not configured
# This prevents duplicate handlers when logging is configured externally
if not logging.root.handlers:
    handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


# =============================================================================
# D12: Comment-priority metrics (Clojure parity)
# =============================================================================
#
# Ports of `importance-metric` and `priority-metric` from Clojure
# (math/src/polismath/math/conversation.clj:311-330). Public so they can be
# unit-tested in isolation.

META_PRIORITY = 7  # Clojure: meta-priority (conversation.clj:319). "TODO TUNE."


def importance_metric(A: float, P: float, S: float, E: float) -> float:
    """
    Clojure importance-metric (conversation.clj:311-315).

        (defn importance-metric
          [A P S E]
          (let [p (/ (+ P 1) (+ S 2))
                a (/ (+ A 1) (+ S 2))]
            (* (- 1 p) (+ E 1) a)))

    Smoothed (Beta(2,2)) probability of pass `p`, smoothed agree `a`, with
    extremity boost `(E + 1)`. Higher when fewer passes, more agrees, more
    extreme (higher PCA extremity).

    Args:
        A: agree count (across all groups).
        P: pass count = S - (A + D) across all groups.
        S: seen count (total votes seen — agree + disagree + pass).
        E: comment extremity (L2 norm of PCA projection).
    """
    p = (P + 1) / (S + 2)
    a = (A + 1) / (S + 2)
    return (1 - p) * (E + 1) * a


def priority_metric(is_meta: bool,
                    A: float, P: float, S: float, E: float) -> float:
    """
    Clojure priority-metric (conversation.clj:321-330).

        (defn priority-metric
          [is-meta A P S E]
          (matrix/pow
            (if is-meta
              meta-priority
              (* (importance-metric A P S E)
                 (+ 1 (* 8 (matrix/pow 2 (/ S -5))))))
            2))

    Squared to deepen bias (toward extremes). Meta comments get a constant
    `META_PRIORITY^2 = 49`. Non-meta comments get `importance * decay`, where
    the decay factor `1 + 8 * 2^(-S/5)` lets new (low-S) comments bubble up
    and fades as more votes accumulate.

    Args:
        is_meta: True for meta comments (treated as constant priority).
        A, P, S, E: see `importance_metric`.

    Returns:
        Squared priority value.

    .. warning::
        **Current behavior (parity-bug mirror):** this function ALWAYS
        returns ``META_PRIORITY ** 2`` and ignores ``is_meta`` and
        ``A, P, S, E``. It deliberately mirrors a Clojure bug — Clojure
        treats meta-tid value 0 as truthy, so every tid takes the meta
        branch — for byte-for-byte parity. The branching formula described
        above is the *intended* semantics, restored once
        https://github.com/compdemocracy/polis/issues/2571 is fixed. See the
        ``TODO(clojure-parity-bug)`` in the body below.
    """
    # TODO(clojure-parity-bug): Clojure (conversation.clj:325) treats meta-tid
    # value 0 as TRUTHY in (if is-meta ...), so every tid takes the meta branch.
    # We mirror this bug for byte-for-byte Clojure parity. Switch back to
    # honoring `is_meta` once the GitHub issue resolves:
    # https://github.com/compdemocracy/polis/issues/2571
    # Original semantic-correct code preserved below for reference and future
    # restoration.
    #
    # Clojure-parity-bug-mirror: ALWAYS take the meta branch, ignoring is_meta.
    return META_PRIORITY ** 2

    # Original semantically-correct logic, restore when Clojure bug is fixed:
    # if is_meta:
    #     inner = META_PRIORITY
    # else:
    #     decay_factor = 1 + 8 * (2 ** (-S / 5))
    #     inner = importance_metric(A, P, S, E) * decay_factor
    # return inner ** 2


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
        self.raw_rating_mat = pd.DataFrame(dtype='float64')  # All votes
        self.rating_mat = pd.DataFrame(dtype='float64')      # Filtered for moderation
        
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

        # Warm-start state threaded across ticks in 'clojure-legacy' engine
        # mode (see polismath.utils.engine_mode). Clojure carries these on the
        # conv (conversation.clj:433-484): the per-k group clusterings and the
        # group-k-smoother state {last_k, last_k_count, smoothed_k}. Cold
        # default is empty (first tick); NOT persisted to/from dynamo — they
        # thread in-memory only, exactly as Clojure's math_main whitelist omits
        # them (conv_man.clj:52-74). Unused in the default 'improved' mode.
        self.group_clusterings: Dict[Any, Any] = {}  # k -> (labels, centers, member_lists, silhouette)
        self.group_k_smoother: Dict[str, Any] = {}   # {last_k, last_k_count, smoothed_k}
        self.proj = {}
        self.repness = None
        self.consensus = []
        self.participant_info = {}
        self.vote_stats = {}
        self.group_votes = {}  # Initialize group_votes to avoid attribute errors
        self.comment_priorities: Dict[Any, float] = {}  # D12 (PR 11)
        
        # Initialize with votes if provided
        if votes:
            self.update_votes(votes)
    
    def update_votes(self, 
                    votes: Dict[str, Any],
                    recompute: bool = True) -> 'Conversation':
        """
        Update the conversation with new votes.
        
        Args:
            votes: Dictionary of votes, with entries 'votes', 'lastVoteTimestamp'
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
        progress_interval = 200000  # Report every N votes
        
        # TODO: we could probably vectorize this further for speed...
        for i, vote in enumerate(vote_data):
            # Report progress for large datasets
            if i > 0 and i % progress_interval == 0:
                progress_pct = (i / total_votes) * 100
                elapsed = time.time() - start_time
                remaining = (elapsed / i) * (total_votes - i) if i > 0 else 0
                logger.info(f"[{elapsed:.2f}s] Processed {i}/{total_votes} votes ({progress_pct:.1f}%) - Est. remaining: {remaining:.2f}s")
            
            try:
                ptpt_id = vote.get('pid')  # Preserve original type
                comment_id = vote.get('tid')  # Preserve original type
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

        # Get existing row and column indices
        existing_rows = self.raw_rating_mat.index
        existing_cols = self.raw_rating_mat.columns
        
        logger.info(f"[{time.time() - start_time:.2f}s] Found {len(existing_rows)} existing rows and {len(existing_cols)} existing columns")

        # Step 1: Convert the list to a DataFrame with columns "row", "col", "value"
        # By now it contain only -1, +1, or 0 as values
        logger.info(f"[{time.time() - start_time:.2f}s] Converting updates to DataFrame...")

        updates_df = pd.DataFrame(vote_updates, columns=['row', 'col', 'value'])

        # Step 2: Keep only the most recent vote for each (participant, comment) pair
        original_count = len(updates_df)
        updates_df = updates_df.drop_duplicates(subset=['row', 'col'], keep='last')
        superseded_votes = original_count - len(updates_df)
        logger.info(f"[{time.time() - start_time:.2f}s] Discarded {superseded_votes} superseded votes (sequential votes on same comment by same participant)")

        # Step 4: Get new rows and columns by set difference
        logger.info(f"[{time.time() - start_time:.2f}s] Identifying new rows and columns...")

        existing_rows_set = set(existing_rows)
        existing_cols = set(existing_cols)

        new_rows = set(updates_df['row']) - existing_rows_set
        new_cols = set(updates_df['col']) - existing_cols

        # Row order: preserve first-appearance order from votes.
        #
        # Clojure builds the rating matrix incrementally — each new participant
        # gets a row appended in the order they first appear in the vote stream
        # (conversation.clj, named_matrix.clj: NamedMatrix preserves insertion
        # order via IndexHash backed by java.util.Vector). The base-cluster IDs
        # are assigned by map-indexed on this row order, so the order directly
        # determines group-level k-means initialization via first-k-distinct.
        #
        # Using natsort (PID-numeric order) instead would change the k-means
        # seed points and produce different silhouette scores / different k.
        # See delphi/docs/INVESTIGATION_K_DIVERGENCE.md for the full
        # analysis showing this is the root cause of k divergence on vw.
        new_rows_ordered = []
        for pid, _, _ in vote_updates:
            if pid in new_rows and pid not in existing_rows_set:
                existing_rows_set.add(pid)
                new_rows_ordered.append(pid)
        all_rows = list(existing_rows) + new_rows_ordered

        # Column order: natsort is fine — column permutation doesn't affect PCA
        # eigenvalues/vectors (only reorders the component loadings), so it has
        # no effect on clustering k.
        # NB: in clojure-legacy mode this column order is now LOAD-BEARING for
        # PCA warm-start alignment — the previous tick's component loadings are
        # threaded in positionally, so the ordering must be STABLE tick-to-tick.
        # Safe while tids are append-only (natsort keeps prior columns' relative
        # order and appends new ones); revisit if columns can ever be removed.
        all_cols = natsorted(existing_cols.union(new_cols))

        logger.info(f"[{time.time() - start_time:.2f}s] Found {len(new_rows)} new rows and {len(new_cols)} new columns")

        # Apply all updates using vectorized pivot_table approach.
        # This is much faster than row-by-row iteration because pandas/numpy
        # can use optimized C code for the reshape operation.

        logger.info(f"[{time.time() - start_time:.2f}s] Applying {len(updates_df)} votes as batch update...")
        batch_start = time.time()

        # Build a wide-form matrix from the long-form updates using pivot_table.
        # aggfunc='last' keeps the last vote if any duplicates remain after dedup.
        update_matrix = updates_df.pivot_table(
            index='row',
            columns='col',
            values='value',
            aggfunc='last'
        )

        # Expand the existing matrix to include any new rows/columns.
        # fill_value=np.nan ensures new cells start as "no vote".
        result.raw_rating_mat = result.raw_rating_mat.reindex(
            index=all_rows, columns=all_cols, fill_value=np.nan
        )

        # Align the update matrix to the same shape (new cells become NaN).
        update_matrix = update_matrix.reindex(index=all_rows, columns=all_cols)

        # Merge: where update_matrix has a value, use it; otherwise keep original.
        # DataFrame.where(cond, other) keeps self where cond is True, uses other where False.
        # So: keep raw_rating_mat where update_matrix is NaN, else use update_matrix.
        result.raw_rating_mat = result.raw_rating_mat.where(
            update_matrix.isna(),  # condition: True where update has no value
            update_matrix          # other: use update value where condition is False
        )

        logger.info(f"[{time.time() - start_time:.2f}s] Batch update completed in {time.time() - batch_start:.2f}s")
        
        # Update last updated timestamp
        result.last_updated = max(
            last_vote_timestamp, 
            result.last_updated
        )
        
        # Update count stats
        result.participant_count, result.comment_count = result.raw_rating_mat.shape
        
        # Apply moderation and create filtered rating matrix
        result._apply_moderation()
        
        # Compute vote stats
        result._compute_vote_stats()
        
        # Recompute clustering if requested
        if recompute:
            try:
                result = result.recompute()
            except Exception as e:
                logger.error(f"Error during recompute: {e}")
                # If recompute fails, return the conversation with just the new votes
        
        return result
    
    def _apply_moderation(self) -> None:
        """
        Apply moderation settings to create filtered rating matrix.

        Matches Clojure behavior (named_matrix.clj:214-230):
        - Moderated-out participants are removed (rows dropped)
        - Moderated-out comments are ZEROED OUT, not removed — the column
          stays in the matrix with all values set to 0.  This preserves
          matrix structure so that tids, column indices, and dimensions
          match between Python and Clojure.
        """
        # Filter out moderated participants (remove rows).
        # Preserve raw_rating_mat row order (vote encounter order) — see
        # update_votes() comment on why row order matters for Clojure parity.
        keep_ptpts = [p for p in self.raw_rating_mat.index if p not in self.mod_out_ptpts]
        self.rating_mat = self.raw_rating_mat.loc[keep_ptpts].copy()

        # Zero out moderated-out comments (keep columns, set values to 0)
        # Clojure: (matrix/set-column m' i 0) — zeroes the column
        mod_cols = [c for c in self.mod_out_tids if c in self.rating_mat.columns]
        if mod_cols:
            self.rating_mat[mod_cols] = 0.0
    
    def _compute_vote_stats(self) -> None:
        """
        Compute statistics on votes using vectorized operations.
        """
        import numpy as np

        # Initialize stats
        self.vote_stats = {
            'n_votes': 0,
            'n_agree': 0,
            'n_disagree': 0,
            'n_pass': 0,
            'comment_stats': {},
            'participant_stats': {}
        }

        try:
            # Use raw_rating_mat (Clojure parity): post-D15 zeroed-moderation columns
            # in self.rating_mat would otherwise inflate n_votes / per-comment 'S' /
            # per-participant counts. raw_rating_mat still has NaN for non-votes,
            # matching Clojure's user-vote-counts and votes-base semantics.
            clean_mat = self._get_clean_matrix(raw=True)
            values = clean_mat.to_numpy()

            # Create boolean masks once for the entire matrix.
            # These are 2D arrays of the same shape as values.
            non_null_mask = ~np.isnan(values)
            agree_mask = np.abs(values - 1.0) < 0.001  # Close to 1
            disagree_mask = np.abs(values + 1.0) < 0.001  # Close to -1

            # Global stats: sum over entire matrix
            try:
                self.vote_stats['n_votes'] = int(np.sum(non_null_mask))
                self.vote_stats['n_agree'] = int(np.sum(agree_mask))
                self.vote_stats['n_disagree'] = int(np.sum(disagree_mask))
                self.vote_stats['n_pass'] = int(np.sum(~non_null_mask))
            except Exception as e:
                logger.error(f"Error counting global votes: {e}")

            # Per-comment stats: sum along axis=0 (columns).
            # axis=0 sums over rows, giving one value per column (comment).
            try:
                comment_n_votes = np.sum(non_null_mask, axis=0)
                comment_n_agree = np.sum(agree_mask, axis=0)
                comment_n_disagree = np.sum(disagree_mask, axis=0)
                # Avoid division by zero: use np.maximum to ensure denominator >= 1
                comment_agree_ratio = comment_n_agree / np.maximum(comment_n_votes, 1)

                # Build comment_stats dict from the arrays.
                for i, cid in enumerate(clean_mat.columns):
                    self.vote_stats['comment_stats'][cid] = {
                        'n_votes': int(comment_n_votes[i]),
                        'n_agree': int(comment_n_agree[i]),
                        'n_disagree': int(comment_n_disagree[i]),
                        'agree_ratio': float(comment_agree_ratio[i])
                    }
            except Exception as e:
                logger.error(f"Error computing comment stats: {e}")

            # Per-participant stats: sum along axis=1 (rows).
            # axis=1 sums over columns, giving one value per row (participant).
            try:
                ptpt_n_votes = np.sum(non_null_mask, axis=1)
                ptpt_n_agree = np.sum(agree_mask, axis=1)
                ptpt_n_disagree = np.sum(disagree_mask, axis=1)
                ptpt_agree_ratio = ptpt_n_agree / np.maximum(ptpt_n_votes, 1)

                # Build participant_stats dict from the arrays.
                for i, pid in enumerate(clean_mat.index):
                    self.vote_stats['participant_stats'][pid] = {
                        'n_votes': int(ptpt_n_votes[i]),
                        'n_agree': int(ptpt_n_agree[i]),
                        'n_disagree': int(ptpt_n_disagree[i]),
                        'agree_ratio': float(ptpt_agree_ratio[i])
                    }
            except Exception as e:
                logger.error(f"Error computing participant stats: {e}")
        except Exception as e:
            logger.error(f"Error in vote stats computation: {e}")
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
    
    def _compute_pca(self, n_components: int = 2,
                     prev_pca: Optional[Dict[str, Any]] = None) -> None:
        """
        Compute PCA on the vote matrix.

        Args:
            n_components: Number of principal components
            prev_pca: The previous tick's PCA result ({'center', 'comps'}) or
                None. Consumed ONLY in 'clojure-legacy' engine mode as the
                power-iteration warm start (Clojure :start-vectors,
                conversation.clj:385). Ignored in the default 'improved' mode.
        """
        import time
        start_time = time.time()
        logger.info(f"Starting PCA computation (matrix shape: {self.rating_mat.shape})...")

        # Make sure pandas and numpy are imported
        import numpy as np
        import pandas as pd

        # Check if we have enough data
        if self.rating_mat.shape[0] < 2 or self.rating_mat.shape[1] < 2:
            # Not enough data for PCA, create minimal results
            cols = max(self.rating_mat.shape[1], 1)
            self.pca = {
                'center': np.zeros(cols),
                'comps': np.zeros((min(n_components, 2), cols))
            }
            self.proj = {pid: np.zeros(2) for pid in self.rating_mat.index}
            logger.info(f"PCA computation completed in {time.time() - start_time:.2f}s (insufficient data)")
            return
        
        try:
            # Make a clean copy of the rating matrix
            clean_matrix = self._get_clean_matrix()

            # Engine-mode warm start (PR-B). In 'clojure-legacy' mode we thread
            # the previous tick's unit components back in as the power-iteration
            # start vectors (Clojure :start-vectors, conversation.clj:385) and
            # require the power-iteration solver (sklearn cannot inject start
            # vectors). In the default 'improved' mode nothing changes:
            # start_vectors stays None and the solver is chosen purely by
            # POLISMATH_PCA_IMPL, so this call is byte-identical to the pre-PR
            # behavior.
            start_vectors = None
            require_powerit = False
            if resolve_engine_mode() == ENGINE_MODE_LEGACY:
                require_powerit = True
                if prev_pca is not None:
                    prev_comps = np.asarray(prev_pca.get('comps'))
                    # Only warm-start from real components; empty/cold state
                    # (first tick) falls through to the cold random draw.
                    if prev_comps.size > 0:
                        start_vectors = prev_comps

            pca_results, proj_dict = pca_project_dataframe(
                clean_matrix, n_components,
                start_vectors=start_vectors, require_powerit=require_powerit)

            # Store results
            self.pca = pca_results
            self.proj = proj_dict
            logger.info(f"PCA computation completed in {time.time() - start_time:.2f}s")

        except Exception as e:
            # If PCA fails, create minimal results
            logger.error(f"Error in PCA computation: {e}")
            # Make sure we have numpy and pandas
            import numpy as np
            import pandas as pd

            cols = self.rating_mat.shape[1]
            self.pca = {
                'center': np.zeros(cols),
                'comps': np.zeros((min(n_components, 2), cols))
            }
            self.proj = {pid: np.zeros(2) for pid in self.rating_mat.index}
            logger.info(f"PCA computation completed in {time.time() - start_time:.2f}s (with errors)")

    def _get_clean_matrix(self, raw: bool = False) -> pd.DataFrame:
        """
        Get a clean copy of the rating matrix with proper numeric values.

        Args:
            raw: If True, sanitize self.raw_rating_mat filtered to
                 self.rating_mat.index (includes votes on moderated-out comments
                 but excludes moderated-out participants, matching Clojure's
                 user-vote-counts / votes-base semantics combined with Polis's
                 mod_out_ptpts handling). If False (default), sanitize the
                 moderation-applied self.rating_mat (used for PCA and clustering).

        Returns:
            Clean DataFrame with numeric values
        """
        source = (self.raw_rating_mat.loc[self.rating_mat.index]
                  if raw else self.rating_mat)
        # Convert all entries to float64, with np.nan for pd.NA and for strings
        matrix_data = source.to_numpy(copy=True)
        if not np.issubdtype(matrix_data.dtype, np.floating):
            try:
                matrix_data = matrix_data.astype(float)
            except (ValueError, TypeError) as e:
                # Handle mixed types using vectorized pandas operations
                # Step 1: Identify original None/NaN values
                df = pd.DataFrame(matrix_data)
                original_nulls = df.isna()

                # Step 2: Convert to numeric, coercing errors to NaN
                df_numeric = df.apply(pd.to_numeric, errors='coerce')

                # Step 3: Find values that became NaN but weren't originally NaN
                # These are the non-convertible strings that should become 0.0
                newly_nan = df_numeric.isna() & ~original_nulls

                # Step 4: Replace newly created NaNs with 0.0
                df_numeric[newly_nan] = 0.0

                # Step 5: Convert back to numpy array
                matrix_data = df_numeric.to_numpy(dtype='float64')

        return pd.DataFrame(matrix_data, index=source.index, columns=source.columns)
    
    def _compute_clusters(self,
                          prev_base_clusters: Optional[List[Dict[str, Any]]] = None,
                          prev_group_clusterings: Optional[Dict[Any, Any]] = None,
                          prev_group_k_smoother: Optional[Dict[str, Any]] = None) -> None:
        """
        Compute two-level hierarchical clustering matching Clojure architecture.

        Level 1: Base clusters (participants → ~100 clusters)
        Level 2: Group clusters (base clusters → 2-5 groups with silhouette-based k selection)

        Args:
            prev_base_clusters: The previous tick's base clusters
                (list of {id, center, members}), or None. Consumed ONLY in
                'clojure-legacy' engine mode as the base-level k-means warm start
                (Clojure :last-clusters (:base-clusters conv), conversation.clj:409).
                Ignored in the default 'improved' mode.
            prev_group_clusterings: The previous tick's per-k group clusterings,
                or None. In 'clojure-legacy' mode this is {k: [id-carrying cluster
                dicts]} — the warm start for per-k group k-means (Clojure
                :last-clusters (last-clusterings k), conversation.clj:441). Ignored
                in 'improved' mode (where it is never even written, so it stays {}).
            prev_group_k_smoother: The previous tick's group-k-smoother state
                {last_k, last_k_count, smoothed_k}, or None. Consumed ONLY in
                'clojure-legacy' mode (conversation.clj:457). Ignored in
                'improved' mode.
        """
        import time
        start_time = time.time()
        logger.info(f"Starting two-level clustering computation ({len(self.proj)} participants)...")

        # Configuration (matching Clojure defaults)
        BASE_K = 100
        MAX_K = 5
        BASE_ITERS = 100        # Clojure :base-iters (conversation.clj:147)
        GROUP_ITERS = 100       # improved-mode group iterations (unchanged)
        # Legacy-mode group iterations: Clojure passes :cluster-iters — a key
        # kmeans IGNORES — so the group level runs kmeans' DEFAULT max-iters of
        # 20, not :group-iters (clusters.clj:303, conversation.clj:443).
        GROUP_LEGACY_ITERS = 20

        # Check if we have projections
        if not self.proj:
            self.base_clusters = []
            self.group_clusters = []
            self.subgroup_clusters = {}
            # P6a: no projections == the degenerate/empty conv. Clojure's
            # conv-update SHORT-CIRCUITS a truly-empty conv (conversation.clj:807-811)
            # and computes nothing, so the group-k smoother state is intentionally
            # LEFT FROZEN here (no advance) — faithful to Clojure, not a divergence.
            logger.info(f"Clustering completed in {time.time() - start_time:.2f}s (no projections)")
            return

        # Step 1: Filter participants (in-conv logic)
        in_conv_pids = self._get_in_conv_participants()

        # Filter projections to only include in-conv participants
        in_conv_pids_list = [pid for pid in self.proj.keys() if pid in in_conv_pids]

        if len(in_conv_pids_list) < 2:
            logger.warning(f"Not enough participants meeting threshold ({len(in_conv_pids_list)})")
            self.base_clusters = []
            self.group_clusters = []
            self.subgroup_clusters = {}
            return

        logger.info(f"Using {len(in_conv_pids_list)}/{len(self.proj)} participants for clustering")

        # Step 2: Base clustering (participants → ~100 base clusters)
        base_proj_values = np.array([self.proj[pid] for pid in in_conv_pids_list])

        # Adjust BASE_K if we have fewer participants
        actual_base_k = min(BASE_K, len(in_conv_pids_list))

        legacy_mode = resolve_engine_mode() == ENGINE_MODE_LEGACY

        logger.info(f"Computing base clusters with k={actual_base_k}...")
        if legacy_mode:
            # PR-C: base-level warm start with lineage. Clojure threads the prior
            # tick's base clusters into k-means as :last-clusters
            # (conversation.clj:403-410 -> clusters.clj:301-312 -> clean-start-
            # clusters), so base-cluster ids are STABLE across ticks, new ids
            # strictly increase, and merges keep the larger side's id. The ported
            # legacy_kmeans keys clusters to the current data by member NAME
            # (participant id), which is what lets prior members be recentered or
            # dropped. base-iters = 100 (conversation.clj:147).
            base_data = _LegacyNamedData(in_conv_pids_list, base_proj_values)
            last_base = _base_clusters_to_legacy(prev_base_clusters)
            legacy_base = legacy_kmeans(
                base_data, actual_base_k,
                last_clusters=last_base, weights=None, max_iters=BASE_ITERS)
            legacy_base.sort(key=lambda c: c['id'])  # Clojure sort-by :id (conversation.clj:406)
            base_clusters = [
                {'id': c['id'],
                 'center': np.asarray(c['center'], dtype=float).tolist(),
                 'members': list(c['members'])}
                for c in legacy_base
            ]
        else:
            # Improved (default): cold recompute, byte-for-byte unchanged.
            base_labels, base_centers, base_member_lists = kmeans_sklearn(
                base_proj_values,
                k=actual_base_k,
                max_iters=BASE_ITERS
            )

            # Convert to dictionary format with participant IDs as members
            base_clusters = []
            for cluster_id, (center, member_indices) in enumerate(zip(base_centers, base_member_lists)):
                # Map indices back to participant IDs
                member_pids = [in_conv_pids_list[idx] for idx in member_indices]
                base_clusters.append({
                    'id': cluster_id,
                    'center': center.tolist(),
                    'members': member_pids
                })

            # Keep base clusters in k-means ID order (matching Clojure's sort-by :id)
            # Do NOT sort by size or reassign IDs — that would change the encounter
            # order of centers used in group clustering's first-k-distinct initialization.
            base_clusters.sort(key=lambda c: c['id'])

        logger.info(f"Created {len(base_clusters)} base clusters")

        # Step 3: Group clustering (base clusters → 2-5 groups)
        if len(base_clusters) < 2:
            logger.warning(f"Not enough base clusters for group clustering ({len(base_clusters)})")
            self.base_clusters = base_clusters
            # Maintain consistent group-cluster schema: members are base-cluster IDs
            if len(base_clusters) == 1:
                self.group_clusters = [{
                    'id': 0,
                    'center': base_clusters[0]['center'],
                    'members': [base_clusters[0]['id']],
                }]
            else:
                self.group_clusters = []
            self.subgroup_clusters = {}
            # P6a: Clojure has NO <2-base-cluster guard. Its max-k-fn is
            # (min max-max-k (+ 2 (int (/ n 12)))) -> ALWAYS >= 2
            # (conversation.clj:273-279), so on a degenerate tick with a NON-empty
            # conv (we are past the `if not self.proj` empty short-circuit above)
            # the Clojure graph still clusters at k=2 and feeds this_k=2 to the
            # group-k smoother, ADVANCING its {last_k, last_k_count, smoothed_k}
            # state. Mirror that in legacy mode (silhouette sentinel 0.0 -> this_k=2)
            # instead of FREEZING the smoother memory — which self-corrected within
            # <=4 ticks but diverged from Clojure meanwhile. Improved mode carries
            # no smoother state, so it is unaffected.
            if legacy_mode:
                new_smoother_state, _ = group_k_smoother_update(
                    prev_group_k_smoother or {}, {2: 0.0})
                self.group_k_smoother = new_smoother_state
                logger.info(f"Legacy degenerate-tick smoother advance: "
                            f"state={new_smoother_state}")
            return

        # Prepare base cluster centers and weights
        base_centers_array = np.array([c['center'] for c in base_clusters])
        base_weights = np.array([len(c['members']) for c in base_clusters])

        # Calculate max_k for group clustering
        max_k = min(MAX_K, 2 + len(base_clusters) // 12)
        max_k = max(2, min(max_k, len(base_clusters)))  # Ensure between 2 and n_base_clusters

        logger.info(f"Computing group clusters with k range 2-{max_k}...")

        if legacy_mode:
            # PR-C: group-level warm start with lineage + weighted recentering.
            # Clojure clusters the BASE-CLUSTER CENTERS (base-clusters-proj),
            # weighted by base-cluster member counts (:weights base-clusters-
            # weights, conversation.clj:433-445), warm-starting each per-k
            # clustering from the prior tick's k-clustering (:last-clusters
            # (last-clusterings k), conversation.clj:441).
            #
            # Clojure passes :cluster-iters (a key kmeans does NOT destructure,
            # clusters.clj:303), so the group level actually runs kmeans' DEFAULT
            # max-iters (20), NOT :group-iters (100). We reproduce that
            # (GROUP_LEGACY_ITERS below); well-separated data converges long
            # before either bound, so on real conversations it is inert.
            base_ids = [c['id'] for c in base_clusters]
            base_weights_by_id = {c['id']: len(c['members']) for c in base_clusters}
            group_data = _LegacyNamedData(base_ids, base_centers_array)
            prev_gc = prev_group_clusterings or {}

            legacy_group_clusterings: Dict[int, List[Dict[str, Any]]] = {}
            silhouettes_by_k: Dict[int, float] = {}
            for k in range(2, max_k + 1):
                gc = legacy_kmeans(
                    group_data, k,
                    last_clusters=prev_gc.get(k),
                    weights=base_weights_by_id,
                    max_iters=GROUP_LEGACY_ITERS)
                gc.sort(key=lambda c: c['id'])  # Clojure sort-by :id (conversation.clj:437)
                legacy_group_clusterings[k] = gc
                # Score with the SAME silhouette the improved path uses, on the
                # legacy assignment, so the smoother sees comparable numbers.
                labels = _labels_from_id_clusters(base_ids, gc)
                score = calculate_silhouette_sklearn(base_centers_array, labels)
                silhouettes_by_k[k] = score
                logger.info(f"  k={k}: silhouette={score:.4f}")

            # Group-K smoother (PR-D): damps K flicker (K only switches after
            # :group-k-buffer=4 consecutive ticks agree) with Clojure's max-key
            # HIGHER-k-wins tie-break, threading {last_k, last_k_count,
            # smoothed_k}. self.group_clusterings holds the id-carrying cluster
            # dicts (legacy value type) — the warm start read next tick.
            new_smoother_state, selected_k = group_k_smoother_update(
                prev_group_k_smoother or {}, silhouettes_by_k)
            self.group_clusterings = legacy_group_clusterings
            self.group_k_smoother = new_smoother_state
            logger.info(f"Legacy group-k-smoother: smoothed_k={selected_k} "
                        f"state={new_smoother_state}")

            # Build production-form group_clusters from the selected clustering.
            # Members are base-cluster ids; ids carry the group-cluster lineage.
            selected = legacy_group_clusterings[selected_k]
            group_clusters = [
                {'id': c['id'],
                 'center': np.asarray(c['center'], dtype=float).tolist(),
                 'members': list(c['members'])}
                for c in selected
            ]
            group_clusters.sort(key=lambda c: c['id'])
        else:
            # Improved (default): cold recompute + best_k selection, byte-for-byte
            # unchanged.
            best_k = 2
            best_score = -1
            group_clusterings = {}

            for k in range(2, max_k + 1):
                group_labels, group_centers, group_member_lists = kmeans_sklearn(
                    base_centers_array,
                    k=k,
                    max_iters=GROUP_ITERS,
                    weights=base_weights
                )

                # Calculate silhouette score
                score = calculate_silhouette_sklearn(base_centers_array, group_labels)
                group_clusterings[k] = (group_labels, group_centers, group_member_lists, score)

                logger.info(f"  k={k}: silhouette={score:.4f}")

                if score > best_score:
                    best_score = score
                    best_k = k

            logger.info(f"Selected k={best_k} with silhouette={best_score:.4f}")

            selected_k = best_k

            # Use the selected clustering. group_clusters is never None.
            group_labels, group_centers, group_member_lists, _ = group_clusterings[selected_k]

            # Convert to dictionary format with base cluster IDs as members
            group_clusters = []
            for cluster_id, (center, member_indices) in enumerate(zip(group_centers, group_member_lists)):
                # Members are base cluster IDs (not participant IDs!)
                member_base_cluster_ids = [base_clusters[idx]['id'] for idx in member_indices]
                group_clusters.append({
                    'id': cluster_id,
                    'center': center.tolist(),
                    'members': member_base_cluster_ids
                })

            # Keep group clusters in k-means ID order (matching Clojure's
            # sort-by :id, conversation.clj:437). Do NOT sort by size or
            # reassign IDs: Clojure assigns group ids by first-k-distinct
            # encounter order over base-cluster centers (init-clusters,
            # clusters.clj:55-64) and never re-orders by size. The former
            # size-descending re-sort here was the root cause of the gid 0↔1
            # label swap vs Clojure blobs (S3-4 trace, 2026-06-11: identical
            # memberships modulo label permutation on vw-cold_start). Mirrors
            # the identical rule at the base-cluster level above.
            group_clusters.sort(key=lambda c: c['id'])

        logger.info(f"Created {len(group_clusters)} group clusters")

        # Store results
        self.base_clusters = base_clusters
        self.group_clusters = group_clusters
        self.subgroup_clusters = {}

        logger.info(f"Two-level clustering completed in {time.time() - start_time:.2f}s")

    def _unfolded_group_clusters(self) -> List[Dict[str, Any]]:
        """
        Return group_clusters with 'members' expanded from base-cluster IDs
        to participant IDs.  Downstream functions (conv_repness,
        participant_stats) need participant IDs to join against the vote matrix.
        """
        base_cluster_by_id = {c['id']: c for c in (self.base_clusters or [])}
        unfolded = []
        for gc in (self.group_clusters or []):
            participant_ids = []
            for bc_id in gc['members']:
                bc = base_cluster_by_id.get(bc_id, {})
                participant_ids.extend(bc.get('members', []))
            unfolded.append({
                'id': gc['id'],
                'center': gc['center'],
                'members': participant_ids,
            })
        return unfolded

    def _compute_repness(self) -> None:
        """
        Compute comment representativeness.
        """
        import time
        start_time = time.time()
        logger.info(f"Starting representativeness computation ({len(self.group_clusters)} groups, {self.rating_mat.shape[1]} comments)...")

        # Make sure numpy and pandas are imported
        import numpy as np
        import pandas as pd

        # Check if we have groups
        if not self.group_clusters:
            # B1 fix (D11 sub-agent review): consensus_comments must always be
            # `{'agree': [], 'disagree': []}` (dict) post-D11, never `[]` (list).
            self.repness = {
                'comment_ids': list(self.rating_mat.columns),
                'group_repness': {},
                'consensus_comments': {'agree': [], 'disagree': []}
            }
            logger.info(f"Representativeness completed in {time.time() - start_time:.2f}s (no groups)")
            return

        # Compute representativeness (needs participant IDs, not base-cluster IDs).
        # `mod_out=self.mod_out_tids` forwards moderated-out tids to the rep + consensus
        # selectors (Clojure parity per D11 / PR 9; matches repness.clj:222 and :296).
        self.repness = conv_repness(self.rating_mat,
                                    self._unfolded_group_clusters(),
                                    mod_out=self.mod_out_tids)
        logger.info(f"Representativeness completed in {time.time() - start_time:.2f}s")

    def _compute_participant_info_optimized(self, vote_matrix: pd.DataFrame, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
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
        matrix_values = vote_matrix.to_numpy(copy=True)
        
        # Convert to numeric matrix with NaN for missing values
        if not np.issubdtype(matrix_values.dtype, np.number):
            try:
                matrix_values = matrix_values.astype(float)
            except (ValueError, TypeError) as e:
                matrix_values = vote_matrix.apply(pd.to_numeric, errors='coerce').to_numpy()
        
        # Replace NaNs with zeros for correlation calculation
        matrix_values = np.nan_to_num(matrix_values, nan=0.0)
        
        # Create result structure
        result = {
            'participant_ids': vote_matrix.index,
            'stats': {}
        }
        
        prep_time = time.time() - start_time
        logger.info(f"Participant stats prep time: {prep_time:.2f}s")
        
        # For each participant, calculate statistics
        participant_count = len(vote_matrix.index)
        logger.info(f"Processing statistics for {participant_count} participants...")
        
        # OPTIMIZATION 1: Precompute mappings and lookup tables
        
        # Precompute mapping of participant IDs to indices for faster lookups
        ptpt_idx_map = {ptpt_id: idx for idx, ptpt_id in enumerate(vote_matrix.index)}
        
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
        
        # Precompute group average votes and valid comment masks
        group_avg_votes = {}
        group_valid_masks = {}

        for group_id, member_indices in group_member_indices.items():
            if len(member_indices) >= 3:  # Only calculate for groups with enough members
                # Extract the group vote matrix
                group_vote_matrix = matrix_values[member_indices, :]

                # Calculate average votes per comment for this group
                group_avg_votes[group_id] = np.mean(group_vote_matrix, axis=0)
                
                # Precompute which comments have at least 3 votes from this group
                group_valid_masks[group_id] = np.sum(group_vote_matrix != 0, axis=0) >= 3
        
        # VECTORIZED: Compute vote counts for ALL participants at once

        process_start = time.time()

        n_agree_all = np.sum(matrix_values > 0, axis=1)    # (N,)
        n_disagree_all = np.sum(matrix_values < 0, axis=1)  # (N,)
        n_pass_all = np.sum(matrix_values == 0, axis=1)     # (N,)
        n_votes_all = n_agree_all + n_disagree_all          # (N,)

        # Mask: participants with at least one real vote
        has_votes = n_votes_all > 0  # (N,) bool

        # VECTORIZED: Compute per-group correlations for ALL participants at once
        # Store as {group_id: corr_array} where corr_array is (N,)
        group_corr_arrays = {}

        for group_id, member_indices in group_member_indices.items():
            if len(member_indices) < 3 or group_id not in group_avg_votes:
                # All correlations default to 0.0
                group_corr_arrays[group_id] = np.zeros(participant_count)
                continue

            valid_mask = group_valid_masks[group_id]
            n_valid = int(np.sum(valid_mask))

            if n_valid < 3:
                group_corr_arrays[group_id] = np.zeros(participant_count)
                continue

            # P: all participants' votes on valid comments — (N, n_valid)
            P = matrix_values[:, valid_mask]
            # g: group average on valid comments — (n_valid,)
            g = group_avg_votes[group_id][valid_mask]

            # Note: ddof=0 (biased estimator) is used throughout — that matches
            # numpy.corrcoef's internal convention, so this implementation
            # produces the same correlation values as `np.corrcoef(p, g)[0, 1]`
            # would on each (participant, group) pair. Do NOT switch to ddof=1
            # ("sample" std) without changing both numerator and denominator
            # consistently; otherwise the correlation values drift.
            p_mean = P.mean(axis=1)          # (N,)
            g_mean = g.mean()                # scalar
            p_std = P.std(axis=1)            # (N,), ddof=0
            g_std = g.std()                  # scalar, ddof=0

            if g_std == 0:
                group_corr_arrays[group_id] = np.zeros(participant_count)
                continue

            # Pearson correlation, two-pass (centered) formula:
            #     corr = mean((P - p_mean)(g - g_mean)) / (p_std * g_std)
            # We use the centered formula rather than the algebraically
            # equivalent one-pass form `(mean(P*g) - p_mean*g_mean) /
            # (p_std*g_std)` because the one-pass form suffers from
            # catastrophic cancellation when the true correlation is small
            # (E[XY] ≈ E[X]*E[Y]), which is the common case in Polis data.
            # This matches numpy.corrcoef's numerical approach (and is what
            # tests/test_participant_info.py::test_matches_numpy_corrcoef
            # validates).
            P_centered = P - p_mean[:, None]                 # (N, n_valid)
            g_centered = g - g_mean                          # (n_valid,)
            cov = (P_centered @ g_centered) / n_valid        # (N,)

            # np.where evaluates both branches; suppress divide-by-zero for p_std==0
            with np.errstate(invalid='ignore', divide='ignore'):
                corr = np.where(
                    p_std > 0,
                    cov / (p_std * g_std),
                    0.0,
                )
            corr = np.nan_to_num(corr, nan=0.0)
            group_corr_arrays[group_id] = corr

        # Assemble result dicts (zero computation — just indexing)
        group_ids = list(group_member_indices.keys())

        for p_idx, participant_id in enumerate(vote_matrix.index):
            if not has_votes[p_idx]:
                continue

            result['stats'][participant_id] = {
                'n_agree': int(n_agree_all[p_idx]),
                'n_disagree': int(n_disagree_all[p_idx]),
                'n_pass': int(n_pass_all[p_idx]),
                'n_votes': int(n_votes_all[p_idx]),
                'group': ptpt_group_map.get(participant_id),
                'group_correlations': {
                    gid: float(group_corr_arrays[gid][p_idx])
                    for gid in group_ids
                }
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
        # (needs participant IDs, not base-cluster IDs)
        ptpt_stats = self._compute_participant_info_optimized(self.rating_mat, self._unfolded_group_clusters())
        
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
        if result.rating_mat.size == 0:
            # Not enough data, return early
            return result

        # Capture the PREVIOUS tick's warm-start state BEFORE the compute steps
        # overwrite it. `result` is a deepcopy of self, so result.pca /
        # result.group_clusterings / result.group_k_smoother currently hold the
        # prior tick's values (deepcopied snapshots). This mirrors Clojure,
        # whose fnks read the incoming `conv` for :start-vectors
        # (conversation.clj:385) and :group-k-smoother (conversation.clj:457).
        # In 'improved' mode (default) these are IGNORED and behavior is
        # unchanged; only 'clojure-legacy' mode consumes them.
        prev_pca = result.pca
        prev_base_clusters = getattr(result, 'base_clusters', [])
        prev_group_clusterings = getattr(result, 'group_clusterings', {})
        prev_group_k_smoother = getattr(result, 'group_k_smoother', {})

        # Compute PCA and projections
        result._compute_pca(prev_pca=prev_pca)

        # Compute clusters
        result._compute_clusters(
            prev_base_clusters=prev_base_clusters,
            prev_group_clusterings=prev_group_clusterings,
            prev_group_k_smoother=prev_group_k_smoother,
        )
        
        # Compute representativeness
        result._compute_repness()

        # Compute comment priorities (D12 / PR 11). Needs PCA + group_votes.
        result._compute_comment_priorities()

        # Compute participant info
        result._compute_participant_info()

        return result

    def _compute_comment_priorities(self) -> Dict[Any, float]:
        """
        Compute per-tid comment priorities matching Clojure
        `:comment-priorities` (conversation.clj:648-679).

        Per-tid: sum A/D/S across all groups → P = S - (A + D) → call
        `priority_metric(is_meta, A, P, S, E)` where E is the comment
        extremity computed from PCA.

        Stores the result on `self.comment_priorities` and also returns it.
        TS server `nextComment.ts::getNextPrioritizedComment` consumes this
        for weighted comment routing — pre-D12 Python emitted nothing, so
        the server fell back to uniform random selection.
        """
        if self.pca is None or self.rating_mat is None or self.rating_mat.empty:
            self.comment_priorities = {}
            return self.comment_priorities

        center = np.asarray(self.pca.get('center'))
        comps = np.asarray(self.pca.get('comps'))
        if center.size == 0 or comps.size == 0:
            self.comment_priorities = {}
            return self.comment_priorities

        # Comment projection + extremity (Clojure with-proj-and-extremtiy,
        # conversation.clj:341-352).
        cmnt_proj = pca_project_cmnts(center, comps)
        extremity_arr = compute_comment_extremity(cmnt_proj)

        # Fail closed on desync: if the PCA vectors were computed on a
        # different column set than the current rating_mat (e.g. moderation
        # changed between recomputes), zip() would silently truncate and
        # assign E=0 to the overflow tids — wrong priorities with no
        # signal. Empty priorities degrade the TS server to uniform
        # routing, which is honest; silently wrong extremities are not.
        # (Copilot review 2026-07-04, g4.)
        n_cols = len(self.rating_mat.columns)
        if len(extremity_arr) != n_cols:
            logger.error(
                f"comment_priorities: extremity length {len(extremity_arr)} "
                f"!= rating_mat column count {n_cols} (stale PCA?); "
                f"skipping priorities for this tick")
            self.comment_priorities = {}
            return self.comment_priorities

        # Column order of `center`/`comps`/`extremity_arr` matches
        # `self.rating_mat.columns` (PCA is computed on rating_mat).
        tid_extremity = dict(zip(self.rating_mat.columns, extremity_arr))

        # Per-group A/D/S aggregation. `_compute_group_votes` returns
        # {str(gid): {'n-members': N, 'votes': {tid: {A, D, S}}}}. S includes
        # PASS (line ~1222: `np.sum(~np.isnan(votes))`), matching Clojure.
        # PERF (deferred, Copilot on PR #2568): this is an O(groups ×
        # comments × members) scan on every recompute; vectorize or reuse
        # the repness-stage aggregation — tracked in the follow-up issue
        # "delphi: _compute_comment_priorities recomputes group votes on
        # every tick".
        group_votes = self._compute_group_votes()

        priorities: Dict[Any, float] = {}
        for tid in self.rating_mat.columns:
            A_total = 0
            D_total = 0
            S_total = 0
            for gv_data in group_votes.values():
                votes_for_tid = gv_data.get('votes', {}).get(
                    tid, {'A': 0, 'D': 0, 'S': 0})
                A_total += votes_for_tid.get('A', 0)
                D_total += votes_for_tid.get('D', 0)
                S_total += votes_for_tid.get('S', 0)
            # Clojure: P = S - (A + D)  (conversation.clj:661).
            P_total = S_total - (A_total + D_total)
            E = float(tid_extremity.get(tid, 0))
            is_meta = tid in self.meta_tids
            # Match key type with the rest of the codebase (int when possible).
            try:
                tid_key = int(tid)
            except (ValueError, TypeError):
                tid_key = tid
            priorities[tid_key] = float(priority_metric(
                is_meta, A_total, P_total, S_total, E))

        self.comment_priorities = priorities
        return priorities
    
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
        
        # Add cluster data (unfolded: base-cluster IDs → participant IDs)
        clusters_start = time.time()
        result['group_clusters'] = self._unfolded_group_clusters()
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
        Compute per-comment vote aggregations, matching Clojure's votes-base.

        Clojure (math/src/polismath/math/conversation.clj:593-600):
            :votes-base (plmb/fnk [bid-to-pid raw-rating-mat]
                          (->> raw-rating-mat
                            nm/colnames
                            (map ...
                              {:A (count agree?) :D (count disagree?) :S (count number?)})))

        Reads from raw_rating_mat (not the moderation-zeroed rating_mat) so
        that moderated-out columns report the actual votes cast, not the
        post-D15 zeros. 'S' is the total non-NaN count per Clojure semantics
        (number? predicate), not just pass votes.

        Returns:
            Dictionary mapping comment IDs to {'A': int, 'D': int, 'S': int}.
        """
        # raw_rating_mat for the COLUMN view (D15 parity — un-zeroed values), but
        # filtered to rating_mat.index for the ROW view so moderated-out participants
        # don't leak into per-comment counts. See _compute_user_vote_counts for the
        # same dual-filter rationale.
        mat = self.raw_rating_mat.loc[self.rating_mat.index]
        values = mat.values
        agree_mask = np.abs(values - 1.0) < 0.001
        disagree_mask = np.abs(values + 1.0) < 0.001
        valid_mask = ~np.isnan(values)

        votes_base = {}
        for j, tid in enumerate(mat.columns):
            entry = {
                'A': int(np.sum(agree_mask[:, j])),
                'D': int(np.sum(disagree_mask[:, j])),
                'S': int(np.sum(valid_mask[:, j])),
            }
            try:
                votes_base[int(tid)] = entry
            except (ValueError, TypeError):
                votes_base[tid] = entry

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

        # Expand base-cluster IDs to participant IDs (matches Clojure group-votes)
        unfolded = self._unfolded_group_clusters()

        group_votes = {}

        # Helper to count votes of a specific type for a group
        def count_votes_for_group(group_id, comment_id, vote_type):
            group = next((g for g in unfolded if g.get('id') == group_id), None)
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
                    member_idx = self.rating_mat.index.get_loc(member)
                    row_indices.append(member_idx)
                except ValueError:
                    # Skip members not found in matrix
                    continue
                    
            # Get the column index for this comment
            try:
                col_idx = self.rating_mat.columns.get_loc(comment_id)
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
        for group in unfolded:
            group_id = group.get('id')
            
            # Skip groups without ID
            if group_id is None:
                continue
                
            # Count members in this group
            n_members = len(group.get('members', []))
            
            # Get vote counts for each comment
            votes = {}
            for comment_id in self.rating_mat.columns:
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

        Uses raw_rating_mat (not rating_mat) so that votes on moderated-out
        comments are still counted. This matches Clojure's user-vote-counts
        (conversation.clj:217-225) which reads from raw-rating-mat.
        Fix D2c: see PLAN_DISCREPANCY_FIXES.md.

        Returns:
            Dictionary mapping participant IDs to vote counts
        """
        import time
        start_time = time.time()
        # raw_rating_mat for the COLUMN view (preserves moderated-out comments — D15
        # parity), but filtered to rating_mat.index for the ROW view so moderated-out
        # *participants* (mod_out_ptpts, dropped by _apply_moderation) don't leak
        # into vote counts. Both filters together give the moderation-applied state
        # with un-zeroed values, matching what Clojure produces.
        mat = self.raw_rating_mat.loc[self.rating_mat.index]
        logger.info(f"Starting _compute_user_vote_counts for {mat.shape[0]} participants")

        vote_counts = {}

        # Use more efficient approach for large datasets
        if mat.shape[0] > 1000:
            # Create a mask of non-nan values across the entire matrix
            non_nan_mask = ~np.isnan(mat.values)

            # Sum across rows using vectorized operation
            row_sums = np.sum(non_nan_mask, axis=1)

            # Convert to dictionary
            for i, pid in enumerate(mat.index):
                if i < len(row_sums):
                    vote_counts[pid] = int(row_sums[i])
                else:
                    # Fallback if dimensions don't match
                    vote_counts[pid] = 0

            logger.info(f"Computed vote counts for {len(vote_counts)} participants using vectorized approach in {time.time() - start_time:.4f}s")
        else:
            # Original approach for smaller datasets
            for i, pid in enumerate(mat.index):
                # Get row of votes for this participant
                row = mat.values[i, :]

                # Count non-nan values
                count = np.sum(~np.isnan(row))

                # Store count
                vote_counts[pid] = int(count)

            logger.info(f"Computed vote counts for {len(vote_counts)} participants using original approach in {time.time() - start_time:.4f}s")

        return vote_counts

    def _get_in_conv_participants(self) -> Set[str]:
        """
        Get participants who have voted enough to be included in clustering.

        Matches Clojure's in-conv logic from conversation.clj lines 239-266.

        Threshold: participant must have voted on at least min(7, n_comments)
        comments (Clojure parity fix D2).

        Both vote counts and n_cmts use raw_rating_mat (fix D2c), which includes
        votes on moderated-out comments. This matches Clojure, where
        zero-out-columns keeps moderated-out columns in the matrix (zeroed but
        present). Since raw_rating_mat contains all historical votes and votes
        are immutable in PostgreSQL, monotonicity is guaranteed without explicit
        persistence — a participant who once qualified can never lose votes.
        If the code is ever refactored to use delta vote processing, in-conv
        MUST be persisted to DynamoDB. See compdemocracy/polis#2358 and
        Clojure's approach in conv_man.clj:55, conversation.clj:244.

        Returns:
            Set of participant IDs that meet the threshold
        """
        n_cmts = len(self.raw_rating_mat.columns) if hasattr(self.raw_rating_mat, 'columns') else 0
        threshold = min(7, n_cmts)

        # Get vote counts for all participants
        vote_counts = self._compute_user_vote_counts()

        # Filter participants meeting threshold
        in_conv = {pid for pid, count in vote_counts.items() if count >= threshold}

        logger.info(f"Filtered {len(in_conv)}/{len(vote_counts)} participants meeting vote threshold {threshold:.1f}")

        return in_conv

    def _fold_base_clusters(self, clusters: List[Dict]) -> Dict:
        """
        Convert base cluster list to folded format for storage (matching Clojure).

        Args:
            clusters: List of base cluster dicts with 'id', 'center', 'members'

        Returns:
            Folded format: {id: [...], members: [[...]], x: [...], y: [...], count: [...]}
        """
        if not clusters:
            return {'id': [], 'members': [], 'x': [], 'y': [], 'count': []}

        return {
            'id': [c['id'] for c in clusters],
            'members': [c['members'] for c in clusters],
            'x': [c['center'][0] for c in clusters],
            'y': [c['center'][1] for c in clusters],
            'count': [len(c['members']) for c in clusters]
        }

    def _unfold_base_clusters(self, folded: Dict) -> List[Dict]:
        """
        Convert folded base clusters back to list format.

        Args:
            folded: Folded format dict

        Returns:
            List of cluster dicts
        """
        if not folded or not folded.get('id'):
            return []

        return [
            {'id': id, 'members': members, 'center': [x, y]}
            for id, members, x, y in zip(
                folded['id'], folded['members'], folded['x'], folded['y']
            )
        ]
        
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

        # Base clusters (participants → ~100 clusters) in columnar format
        # TypeScript expects {x: [], y: [], id: [], count: [], members: [[]]}
        result['base-clusters'] = self._fold_base_clusters(self.base_clusters)

        # Group clusters (base clusters → 2-5 groups)
        # Unfold base-cluster IDs to participant IDs for downstream consumers
        unfolded_gc = self._unfolded_group_clusters()
        result['group-clusters'] = unfolded_gc

        # Legacy field for backward compatibility (remove after full migration)
        result['group_clusters'] = unfolded_gc
        
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
        
        # Add tids (comment IDs) with natural sorting
        # Types are already preserved (int stays int, str stays str, etc.)
        # TODO: figure out if really needed, as per https://github.com/compdemocracy/polis/issues/2290
        result['tids'] = natsorted(self.rating_mat.columns)
        
        # Add count values with Clojure naming
        result['n'] = self.participant_count
        result['n-cmts'] = self.comment_count
        
        # Clojure parity (conversation.clj:220-228): user-vote-counts must come from
        # raw_rating_mat so that post-D15 zeroed columns don't inflate per-participant counts.
        # _compute_user_vote_counts() already routes through raw_rating_mat correctly.
        vote_counts_start = time.time()
        result['user-vote-counts'] = self._compute_user_vote_counts()
        logger.info(f"User vote counts: {time.time() - vote_counts_start:.4f}s")
        
        # Clojure parity (conversation.clj:593-600): votes-base must come from
        # raw_rating_mat so that moderated-out columns report the actual votes cast,
        # not the post-D15 zeros (which would inflate every column's 'S' count).
        votes_base_start = time.time()
        result['votes-base'] = self._compute_votes_base()
        logger.info(f"Votes base: {time.time() - votes_base_start:.4f}s")
        
        # Compute group votes with optimized approach
        group_votes_start = time.time()
        
        # Use the optimized implementation similar to to_dynamo_dict
        group_votes = {}

        if self.group_clusters:
            # Reuse the already-unfolded group clusters (computed above)
            unfolded_groups = unfolded_gc

            # Precompute indices for each participant for faster lookups
            ptpt_indices = {ptpt_id: i for i, ptpt_id in enumerate(self.rating_mat.index)}

            # Process each group
            for group in unfolded_groups:
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
                for j, comment_id in enumerate(self.rating_mat.columns):
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
            for tid in self.rating_mat.columns:
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
        
        # NOTE: base-clusters is set above via _fold_base_clusters() in the columnar
        # format that TypeScript expects: {x, y, id, count, members} where members
        # are arrays of participant IDs. Do NOT overwrite with unfolded_gc — that's
        # a list-of-dicts format that would break server/src/report.ts,
        # server/src/utils/pca.ts, and client-participation-alpha consumers.

        # Surface D11 consensus comments (Clojure parity: client-report's Majority
        # view consumes result['consensus']). Pre-Investigation-B this block was
        # hardcoded empty, which silently zeroed the Majority view regardless of
        # the D11 selection. Falls back to the empty shape when repness is missing
        # or did not produce a consensus_comments dict (older blobs, no-group convs).
        result['consensus'] = (
            self.repness.get('consensus_comments', {'agree': [], 'disagree': []})
            if self.repness else {'agree': [], 'disagree': []}
        )
        
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
        for tid in self.rating_mat.columns:
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
        
        # Clojure parity (conversation.clj:220-228): user-vote-counts come from
        # raw_rating_mat. Routed through the same helper used by to_dict so the
        # two serializers can't drift apart again (audit-discovered 2026-06-09).
        logger.info(f"[{time.time() - start_time:.2f}s] Computing user vote counts...")
        user_vote_counts = self._compute_user_vote_counts()
        result['user_vote_counts'] = user_vote_counts
        
        # Calculate included participants (meeting vote threshold)
        logger.info(f"[{time.time() - start_time:.2f}s] Computing included participants...")
        included_participants = []
        min_votes = min(7, self.comment_count)
        
        for pid, count in user_vote_counts.items():
            if count >= min_votes:
                included_participants.append(pid)  # Already converted above
        
        result['included_participants'] = included_participants
        
        # Clojure parity (conversation.clj:593-600): votes-base comes from
        # raw_rating_mat. Routed through the same helper used by to_dict; DynamoDB
        # uses different key names (agree/disagree/total vs Clojure's A/D/S) so we
        # rename on the way out. Audit-discovered 2026-06-09.
        logger.info(f"[{time.time() - start_time:.2f}s] Computing votes base structure...")
        votes_base_start = time.time()
        votes_base = {
            tid: {'agree': entry['A'], 'disagree': entry['D'], 'total': entry['S']}
            for tid, entry in self._compute_votes_base().items()
        }
        logger.info(f"[{time.time() - start_time:.2f}s] votes_base computed in {time.time() - votes_base_start:.2f}s")
        result['votes_base'] = votes_base
        
        # Compute group votes structure with optimized approach
        logger.info(f"[{time.time() - start_time:.2f}s] Computing group votes structure...")
        group_votes_start = time.time()
        
        # Initialize with empty structure
        result['group_votes'] = {}
        
        # Process groups only if they exist
        if self.group_clusters:
            # Expand base-cluster IDs to participant IDs for vote counting
            unfolded_groups = self._unfolded_group_clusters()

            # Precompute indices for each participant
            ptpt_indices = {}
            for i, ptpt_id in enumerate(self.rating_mat.index):
                ptpt_indices[ptpt_id] = i

            # Process each group
            for group in unfolded_groups:
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
                for j, comment_id in enumerate(self.rating_mat.columns):
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
            for tid in self.rating_mat.columns:
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
        
        # Convert group clusters (unfolded: base-cluster IDs → participant IDs)
        base_clusters = []
        for cluster in self._unfolded_group_clusters():
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
        
        # Surface D11 consensus comments (Clojure parity). Pre-Investigation-B
        # this block was hardcoded empty, so the DynamoDB blob never carried the
        # D11 dict even when repness produced one. Falls back to the empty shape
        # when repness is missing or didn't produce consensus_comments.
        # float_to_decimal is REQUIRED: entries carry float p-success/p-test and
        # writer Site 1 puts this dict straight into the Delphi_PCAResults Item —
        # boto3 rejects raw floats (caught by CI's e2e run, 2026-07-05; the
        # legacy writer branch converts, the pre-formatted branch did not).
        result['consensus'] = float_to_decimal(
            self.repness.get('consensus_comments', {'agree': [], 'disagree': []})
            if self.repness else {'agree': [], 'disagree': []}
        )
        
        # Add math_tick value
        current_time = int(time.time())
        math_tick = 25000 + (current_time % 10000)
        result['math_tick'] = math_tick
        
        # Process comment priorities
        if hasattr(self, 'comment_priorities') and self.comment_priorities:
            logger.info(f"[{time.time() - start_time:.2f}s] Processing comment priorities...")
            priorities = {}
            for cid, priority in self.comment_priorities.items():
                # Preserve the float VALUE as Decimal (boto3 rejects raw
                # floats). The previous int() truncation was harmless while
                # the D12.6 bug-mirror pins every priority to 49.0, but the
                # real formula (restored when issue #2571 resolves) spans
                # ~0.18–31.46 on real data: int() floors sub-1 priorities
                # to 0, which the TS server's weighted routing treats as
                # "no priority data" — those comments would never be routed.
                value = float_to_decimal(float(priority))
                try:
                    priorities[int(cid)] = value
                except (ValueError, TypeError):
                    priorities[cid] = value
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
