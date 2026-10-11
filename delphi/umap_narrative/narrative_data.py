"""Pure narrative selection and XML formatting shared with legacy batch reports."""
import logging
import xml.etree.ElementTree as ET
from xml.dom.minidom import parseString
logger = logging.getLogger(__name__)

class PolisConverter:
    """Convert between CSV and XML formats for Polis data."""
    
    @staticmethod
    def convert_to_xml(comment_data):
        """
        Convert comment data to XML format.
        
        Args:
            comment_data: List of dictionaries with comment data
            
        Returns:
            String with XML representation of the comment data
        """
        # Create root element
        root = ET.Element("polis-comments")
        
        # Process each comment
        for record in comment_data:
            # Extract base comment data
            comment = ET.SubElement(root, "comment", {
                "id": str(record.get("comment-id", "")),
                "votes": str(record.get("total-votes", 0)),
                "agrees": str(record.get("total-agrees", 0)),
                "disagrees": str(record.get("total-disagrees", 0)),
                "passes": str(record.get("total-passes", 0)),
            })
            
            # Add comment text
            text = ET.SubElement(comment, "text")
            text.text = record.get("comment", "")
            
            # Process group data
            group_keys = []
            for key in record.keys():
                if key.startswith("group-") and key.count("-") >= 2:
                    group_id = key.split("-")[1]
                    if group_id not in group_keys:
                        group_keys.append(group_id)
            
            # Add data for each group
            for group_id in group_keys:
                group = ET.SubElement(comment, f"group-{group_id}", {
                    "votes": str(record.get(f"group-{group_id}-votes", 0)),
                    "agrees": str(record.get(f"group-{group_id}-agrees", 0)),
                    "disagrees": str(record.get(f"group-{group_id}-disagrees", 0)),
                    "passes": str(record.get(f"group-{group_id}-passes", 0)),
                })
        
        # Convert to string with pretty formatting
        rough_string = ET.tostring(root, 'utf-8')
        reparsed = parseString(rough_string)
        return reparsed.toprettyxml(indent="  ")

class NarrativeSelection:
    def filter_topics(self, comment, topic_cluster_id=None, topic_layer_id=None, topic_citations=None, sample_comments=None, filter_type=None, filter_threshold=None):
        """Filter for comments that are part of a specific topic or meet global section criteria."""
        # Get comment ID
        comment_id = comment.get('comment_id')
        if comment_id is None:
            return False
        
        # Handle global section filtering
        if filter_type is not None:
            return self._apply_global_filter(comment, filter_type, filter_threshold)
        
        # Handle layer-specific topic filtering (existing logic)
        if topic_cluster_id is not None and topic_layer_id is not None:
            # Get the cluster ID for the specified layer
            layer_cluster_key = f'layer{topic_layer_id}_cluster_id'
            comment_cluster_id = comment.get(layer_cluster_key)
            if comment_cluster_id is not None:
                # Debug logging for cluster 0
                if str(topic_cluster_id) == "0" and comment_id in [1, 2, 3]:  # Log first few comments
                    logger.info(f"DEBUG: Checking comment {comment_id} - layer{topic_layer_id}_cluster_id={comment_cluster_id}, topic_cluster_id={topic_cluster_id}")
                    logger.info(f"DEBUG: String comparison: '{str(comment_cluster_id)}' == '{str(topic_cluster_id)}' = {str(comment_cluster_id) == str(topic_cluster_id)}")
                
                # Simple string comparison is more reliable across different numeric types
                if str(comment_cluster_id) == str(topic_cluster_id):
                    return True
                
        # Check if this comment ID is in our topic citations
        if topic_citations and str(comment_id) in [str(c) for c in topic_citations]:
            return True
            
        # If we have sample comments and not enough filtered comments,
        # try to match based on text similarity
        if sample_comments and len(sample_comments) > 0:
            comment_text = comment.get('comment', '')
            if not comment_text:
                return False
                
            # Check if this comment text matches any sample comment
            for sample in sample_comments:
                # Skip non-string samples
                if not isinstance(sample, str) or not sample:
                    continue
                    
                # Simple substring match rather than complex word comparison
                if sample.lower() in comment_text.lower() or comment_text.lower() in sample.lower():
                    return True
        
        return False
    
    def _apply_global_filter(self, comment, filter_type, filter_threshold):
        """
        Apply global section filtering based on Polis statistical metrics.
        
        Args:
            comment: Comment data dictionary
            filter_type: Type of filter ('comment_extremity', 'group_aware_consensus', 'uncertainty_ratio')
            filter_threshold: Threshold value for filtering (or 'dynamic' for group_aware_consensus)
            
        Returns:
            Boolean indicating whether comment passes the filter
        """
        try:
            if filter_type == "comment_extremity":
                # Filter for comments that divide opinion groups (extremity > 1.0)
                extremity = comment.get('comment_extremity', 0)
                return extremity > filter_threshold
                
            elif filter_type == "group_aware_consensus":
                # Filter for comments with broad cross-group agreement
                # Uses dynamic thresholds based on number of groups
                consensus = comment.get('group_aware_consensus', 0)
                num_groups = comment.get('num_groups', 2)
                
                # Get dynamic threshold based on group count (matches Node.js logic)
                if filter_threshold == "dynamic":
                    if num_groups == 2:
                        threshold = 0.7
                    elif num_groups == 3:
                        threshold = 0.47
                    elif num_groups == 4:
                        threshold = 0.32
                    else:  # 5+ groups
                        threshold = 0.24
                else:
                    threshold = filter_threshold
                    
                return consensus > threshold
                
            elif filter_type == "uncertainty_ratio":
                # Filter for comments with high uncertainty/unsure responses (>= 20% pass votes)
                passes = comment.get('passes', 0)
                votes = comment.get('votes', 0)
                
                if votes == 0:
                    return False
                    
                uncertainty_ratio = passes / votes
                return uncertainty_ratio >= filter_threshold
                
            else:
                logger.warning(f"Unknown filter type: {filter_type}")
                return False
                
        except Exception as e:
            logger.error(f"Error applying global filter {filter_type}: {str(e)}")
            return False
    
    def _get_dynamic_comment_limit(self, layer_id=None, total_layers=None, comment_count=None, filter_type=None):
        """
        Calculate dynamic comment limit based on layer granularity and conversation size.
        Implements the fractal approach where coarse layers get fewer, higher quality comments.
        
        Args:
            layer_id: Current layer ID (None for global sections)
            total_layers: Total number of available layers  
            comment_count: Total number of comments in conversation
            filter_type: Type of filter (for global sections)
            
        Returns:
            Integer comment limit for this section
        """
        try:
            # Base limits for different categories
            base_limits = {
                "global_sections": 50,   # Fixed limit for global sections
                "fine_layers": 100,      # More comments for specific topics (layer 0)
                "medium_layers": 75,     # Balanced approach (middle layers)
                "coarse_layers": 50      # Fewer, highest quality comments (top layer)
            }
            
            # Determine category
            if filter_type is not None:
                # This is a global section
                category = "global_sections"
            elif layer_id is not None and total_layers is not None:
                # This is a layer-specific topic
                if layer_id == 0:
                    category = "fine_layers"  # Most specific layer
                elif layer_id == total_layers - 1:
                    category = "coarse_layers"  # Most general layer
                else:
                    category = "medium_layers"  # Middle layers
            else:
                # Fallback to medium limit
                category = "medium_layers"
            
            # Get base limit
            limit = base_limits[category]
            
            # Scale down for very large conversations to manage token usage
            if comment_count is not None:
                if comment_count > 10000:
                    # Halve limits for huge conversations (>10k comments)
                    limit = int(limit * 0.5)
                elif comment_count > 5000:
                    # Reduce by 25% for large conversations (5k-10k comments)
                    limit = int(limit * 0.75)
                elif comment_count > 2000:
                    # Reduce by 10% for medium-large conversations (2k-5k comments)
                    limit = int(limit * 0.9)
            
            # Ensure minimum limit
            limit = max(limit, 10)
            
            logger.debug(f"Dynamic comment limit: category={category}, base={base_limits[category]}, "
                        f"final={limit}, comment_count={comment_count}, layer_id={layer_id}")
            
            return limit
            
        except Exception as e:
            logger.error(f"Error calculating dynamic comment limit: {str(e)}")
            # Fallback to conservative limit
            return 50
    
    def _select_high_quality_comments(self, comments, limit, filter_type=None):
        """
        Select the highest quality comments based on Polis statistical metrics.
        
        Args:
            comments: List of comment dictionaries
            limit: Maximum number of comments to select
            filter_type: Type of filter being applied (affects sorting priority)
            
        Returns:
            List of selected high-quality comments
        """
        if len(comments) <= limit:
            return comments
            
        try:
            # Create sorting key based on filter type and available metrics
            def get_sort_key(comment):
                # Base score starts with vote count (engagement indicator)
                votes = comment.get('votes', 0)
                vote_score = int(votes) if isinstance(votes, (int, float)) else 0
                
                # Add metric-specific scoring
                if filter_type == "comment_extremity":
                    # For extremity filtering, prioritize highly divisive comments
                    extremity = comment.get('comment_extremity', 0)
                    metric_score = extremity * 1000  # Scale up for sorting
                elif filter_type == "group_aware_consensus":
                    # For consensus filtering, prioritize high agreement comments
                    consensus = comment.get('group_aware_consensus', 0)
                    metric_score = consensus * 1000  # Scale up for sorting
                elif filter_type == "uncertainty_ratio":
                    # For uncertainty filtering, prioritize comments with high pass rates
                    passes = comment.get('passes', 0)
                    total_votes = comment.get('votes', 1)
                    uncertainty = passes / max(total_votes, 1)
                    metric_score = uncertainty * 1000  # Scale up for sorting
                else:
                    # For topic filtering, use a combination of votes and engagement
                    agrees = comment.get('agrees', 0)
                    disagrees = comment.get('disagrees', 0)
                    total_engagement = int(agrees) + int(disagrees) if isinstance(agrees, (int, float)) and isinstance(disagrees, (int, float)) else 0
                    metric_score = total_engagement
                
                # Combine scores (metric score is primary, vote count is secondary)
                return (metric_score, vote_score)
            
            # Sort comments by quality score (descending)
            sorted_comments = sorted(comments, key=get_sort_key, reverse=True)
            
            # Select top comments up to limit
            selected = sorted_comments[:limit]
            
            logger.info(f"Selected {len(selected)} high-quality comments from {len(comments)} "
                       f"(filter_type={filter_type}, limit={limit})")
            
            return selected
            
        except Exception as e:
            logger.error(f"Error selecting high-quality comments: {str(e)}")
            # Fallback to simple vote-based selection
            try:
                sorted_comments = sorted(comments, 
                                       key=lambda c: int(c.get('votes', 0)) if isinstance(c.get('votes'), (int, float)) else 0, 
                                       reverse=True)
                return sorted_comments[:limit]
            except Exception:
                # Last resort: return first N comments
                return comments[:limit]
    
    async def get_comments_as_xml(self, conversation_data: dict, filter_func=None, filter_args=None):
        """Get comments as XML from pre-fetched data."""
        try:
            # Use the data passed as an argument
            data = conversation_data
            
            if not data:
                logger.error("Received empty conversation data.")
                return ""
            
            # Apply filter if provided
            filtered_comments = data["processed_comments"]
            
            if filter_func:
                if filter_args:
                    filtered_comments = [c for c in filtered_comments if filter_func(c, **filter_args)]
                else:
                    filtered_comments = [c for c in filtered_comments if filter_func(c)]
            
            # Apply dynamic comment limiting with intelligent selection
            if filter_func == self.filter_topics and len(filtered_comments) > 0:
                # Get context for dynamic limit calculation
                total_comment_count = len(data["processed_comments"])
                
                # Extract layer and filter information from filter_args
                layer_id = None
                total_layers = None
                filter_type = None
                
                if filter_args:
                    layer_id = filter_args.get('topic_layer_id')
                    filter_type = filter_args.get('filter_type')
                    
                    # Estimate total layers from conversation data (could be improved)
                    # For now, we'll determine this dynamically or use a reasonable default
                    if layer_id is not None:
                        # Try to determine total layers from available cluster data
                        # This is a heuristic - in practice you might want to pass this explicitly
                        total_layers = max(layer_id + 1, 3)  # Assume at least 3 layers if we have layer data
                
                # Calculate dynamic limit
                comment_limit = self._get_dynamic_comment_limit(
                    layer_id=layer_id,
                    total_layers=total_layers, 
                    comment_count=total_comment_count,
                    filter_type=filter_type
                )
                
                # Apply intelligent comment selection if we exceed the limit
                if len(filtered_comments) > comment_limit:
                    logger.info(f"Applying dynamic comment limit: {len(filtered_comments)} -> {comment_limit} "
                               f"(layer_id={layer_id}, filter_type={filter_type}, total_comments={total_comment_count})")
                    
                    # Use intelligent selection based on Polis metrics
                    filtered_comments = self._select_high_quality_comments(
                        filtered_comments, 
                        comment_limit, 
                        filter_type=filter_type
                    )
                else:
                    logger.info(f"No limiting needed: {len(filtered_comments)} comments <= limit of {comment_limit}")
            else:
                # For non-topic filtering, use a conservative limit to avoid token issues
                max_comments = 100
                if len(filtered_comments) > max_comments:
                    logger.info(f"Applying conservative limit: {len(filtered_comments)} -> {max_comments}")
                    filtered_comments = self._select_high_quality_comments(filtered_comments, max_comments)
            
            # Convert to XML
            xml = PolisConverter.convert_to_xml(filtered_comments)
            
            return xml
        except Exception as e:
            logger.error(f"Error in get_comments_as_xml: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return ""
    
