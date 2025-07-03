"""
Priority calculation formulas and utilities.

This module contains the core priority calculation logic extracted from the 
original Clojure implementation, making it reusable across different contexts.
"""

class PriorityCalculator:
    """Stateless priority calculation using Clojure-derived formulas."""
    
    META_PRIORITY = 7.0
    
    @staticmethod
    def importance_metric(A: int, P: int, S: int, E: float) -> float:
        """
        Calculate importance metric (direct port from Clojure).
        
        Formula: (1 - p) * (E + 1) * a
        Where:
        - p = pass rate with Laplace smoothing: (P + 1) / (S + 2)
        - a = agree rate with Laplace smoothing: (A + 1) / (S + 2)
        - E = extremity value from group analysis
        
        Args:
            A: Number of agree votes
            P: Number of pass votes  
            S: Total number of votes
            E: Extremity value (0.0 to 1.0)
            
        Returns:
            Importance metric value
        """
        # Laplace smoothing to avoid division by zero and handle small samples
        p = (P + 1.0) / (S + 2.0)  # Pass rate
        a = (A + 1.0) / (S + 2.0)  # Agree rate
        
        # Core importance formula from Clojure implementation
        return (1.0 - p) * (E + 1.0) * a
    
    @staticmethod
    def priority_metric(is_meta: bool, A: int, P: int, S: int, E: float) -> float:
        """
        Calculate priority metric (direct port from Clojure).
        
        For meta comments: returns META_PRIORITY^2 (49)
        For regular comments: (importance * scaling_factor)^2
        
        The scaling factor helps newer comments (with fewer votes) bubble up:
        scaling_factor = 1 + (8 * 2^(-S/5))
        
        Args:
            is_meta: Whether the comment is a meta comment
            A: Number of agree votes
            P: Number of pass votes
            S: Total number of votes
            E: Extremity value (0.0 to 1.0)
            
        Returns:
            Priority metric value
        """
        if is_meta:
            return PriorityCalculator.META_PRIORITY ** 2  # 49
        else:
            # Calculate base importance using extremity and vote patterns
            importance = PriorityCalculator.importance_metric(A, P, S, E)
            
            # Scaling factor helps new comments bubble up
            # As S increases, the scaling factor approaches 1
            # For S=0: factor = 1 + 8 = 9 (big boost for new comments)
            # For S=5: factor = 1 + 4 = 5 (moderate boost)
            # For S=25: factor ≈ 1 (minimal boost for well-voted comments)
            scaling_factor = 1.0 + (8.0 * (2.0 ** (-S / 5.0)))
            
            # Square the result to amplify differences
            return (importance * scaling_factor) ** 2

    @classmethod
    def calculate_comment_priority(cls, comment_stats: dict, extremity_value: float, is_meta: bool = False) -> int:
        """
        Convenience method to calculate priority from comment statistics.
        
        Args:
            comment_stats: Dict with 'agree', 'disagree', 'total' vote counts
            extremity_value: Extremity value from group analysis (0.0 to 1.0)
            is_meta: Whether this is a meta comment
            
        Returns:
            Priority value as integer
            
        Example:
            >>> stats = {'agree': 15, 'disagree': 3, 'total': 25}
            >>> priority = PriorityCalculator.calculate_comment_priority(stats, 0.7)
            >>> print(f"Priority: {priority}")
        """
        A = int(comment_stats.get('agree', 0))
        D = int(comment_stats.get('disagree', 0))
        S = int(comment_stats.get('total', 0))
        
        # Calculate pass votes: total votes minus explicit agree/disagree
        P = S - (A + D)
        
        # Ensure non-negative pass votes
        P = max(0, P)
        
        # Calculate priority using the core formulas
        priority = cls.priority_metric(is_meta, A, P, S, extremity_value)
        
        # Return as integer (matching existing system expectations)
        return int(priority)
    
    @classmethod
    def validate_inputs(cls, A: int, P: int, S: int, E: float) -> bool:
        """
        Validate priority calculation inputs.
        
        Args:
            A: Number of agree votes
            P: Number of pass votes
            S: Total number of votes
            E: Extremity value
            
        Returns:
            True if inputs are valid, False otherwise
        """
        # Check non-negative vote counts
        if A < 0 or P < 0 or S < 0:
            return False
            
        # Check that agree + pass <= total votes
        if A + P > S:
            return False
            
        # Check extremity is in valid range
        if E < 0.0 or E > 1.0:
            return False
            
        return True
    
    @classmethod
    def explain_priority(cls, comment_stats: dict, extremity_value: float, is_meta: bool = False) -> dict:
        """
        Calculate priority and return detailed breakdown for debugging.
        
        Args:
            comment_stats: Dict with vote counts
            extremity_value: Extremity value
            is_meta: Whether this is a meta comment
            
        Returns:
            Dict with priority value and calculation breakdown
        """
        A = int(comment_stats.get('agree', 0))
        D = int(comment_stats.get('disagree', 0))
        S = int(comment_stats.get('total', 0))
        P = max(0, S - (A + D))
        
        if is_meta:
            return {
                'priority': int(cls.META_PRIORITY ** 2),
                'is_meta': True,
                'meta_priority_base': cls.META_PRIORITY,
                'explanation': f"Meta comment priority: {cls.META_PRIORITY}^2 = {int(cls.META_PRIORITY ** 2)}"
            }
        
        # Calculate components
        pass_rate = (P + 1.0) / (S + 2.0)
        agree_rate = (A + 1.0) / (S + 2.0)
        importance = cls.importance_metric(A, P, S, extremity_value)
        scaling_factor = 1.0 + (8.0 * (2.0 ** (-S / 5.0)))
        priority = cls.priority_metric(is_meta, A, P, S, extremity_value)
        
        return {
            'priority': int(priority),
            'is_meta': False,
            'votes': {'agree': A, 'disagree': D, 'pass': P, 'total': S},
            'rates': {'pass_rate': pass_rate, 'agree_rate': agree_rate},
            'extremity': extremity_value,
            'importance': importance,
            'scaling_factor': scaling_factor,
            'explanation': f"Priority = (importance * scaling)^2 = ({importance:.3f} * {scaling_factor:.3f})^2 = {priority:.1f}"
        }