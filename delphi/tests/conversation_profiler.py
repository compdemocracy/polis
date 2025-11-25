"""
Profiling utilities for tracking performance in the Conversation class.
"""

import time
import sys
import os
from functools import wraps
import cProfile
import pstats
from io import StringIO
from typing import Dict, Any, Callable, List
from copy import deepcopy

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.conversation.conversation import Conversation

# Store the original methods to restore later
ORIGINAL_METHODS = {}

# Container for profiling data
profile_data = {
    'method_times': {},
    'call_counts': {},
    'detailed_timing': []
}

def timeit_decorator(method_name):
    """
    Decorator that times the execution of a method and logs the result.
    """
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start_time = time.time()
            
            # Get optional context
            context = kwargs.pop('_profiling_context', '')
            
            # Log start
            detail = {
                'method': method_name,
                'start_time': start_time,
                'context': context,
                'status': 'started'
            }
            profile_data['detailed_timing'].append(detail)
            
            # Print start for immediate feedback
            elapsed = time.time() - profile_data.get('process_start_time', start_time)
            print(f"[{elapsed:.2f}s] STARTED {method_name} {context}")
            
            try:
                result = func(*args, **kwargs)
                
                # Calculate execution time
                end_time = time.time()
                execution_time = end_time - start_time
                
                # Update profiling data
                if method_name not in profile_data['method_times']:
                    profile_data['method_times'][method_name] = 0
                    profile_data['call_counts'][method_name] = 0
                
                profile_data['method_times'][method_name] += execution_time
                profile_data['call_counts'][method_name] += 1
                
                # Log completion
                detail = {
                    'method': method_name,
                    'end_time': end_time,
                    'duration': execution_time,
                    'context': context,
                    'status': 'completed'
                }
                profile_data['detailed_timing'].append(detail)
                
                # Print completion for immediate feedback
                elapsed = time.time() - profile_data.get('process_start_time', start_time)
                print(f"[{elapsed:.2f}s] COMPLETED {method_name} in {execution_time:.2f}s {context}")
                
                return result
            except Exception as e:
                # Log error
                end_time = time.time()
                execution_time = end_time - start_time
                
                detail = {
                    'method': method_name,
                    'end_time': end_time,
                    'duration': execution_time,
                    'context': context,
                    'status': 'error',
                    'error': str(e)
                }
                profile_data['detailed_timing'].append(detail)
                
                # Print error for immediate feedback
                elapsed = time.time() - profile_data.get('process_start_time', start_time)
                print(f"[{elapsed:.2f}s] ERROR in {method_name}: {str(e)} after {execution_time:.2f}s {context}")
                
                raise
                
        return wrapper
    return decorator

def instrument_conversation_class():
    """
    Instruments the Conversation class methods with timing decorators.
    """
    print("Instrumenting Conversation class with timing decorators...")
    
    # Methods to profile
    methods_to_profile = [
        'update_votes',
        'update_moderation',
        'recompute',
        '_apply_moderation',
        '_compute_vote_stats',
        '_compute_pca',
        '_compute_clusters',
        '_compute_repness',
        '_compute_participant_info',
        '_get_clean_matrix'
    ]
    
    # Capture original methods
    for method_name in methods_to_profile:
        if hasattr(Conversation, method_name):
            ORIGINAL_METHODS[method_name] = getattr(Conversation, method_name)
            
            # Replace with timed version
            original_method = getattr(Conversation, method_name)
            timed_method = timeit_decorator(method_name)(original_method)
            setattr(Conversation, method_name, timed_method)
    
    # Add special instrumentation for update_votes to track internal steps
    original_update_votes = ORIGINAL_METHODS['update_votes']
    
    @wraps(original_update_votes)
    def detailed_update_votes(self, votes, recompute=True):
        """Instrumented update_votes with detailed timing for each step."""
        # Set process start time if not already set
        if 'process_start_time' not in profile_data:
            profile_data['process_start_time'] = time.time()
            
        start_time = time.time()
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] STARTED update_votes with {len(votes.get('votes', []))} votes")
        
        # Create a copy to avoid modifying the original
        step_start = time.time()
        result = deepcopy(self)
        step_time = time.time() - step_start
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] Step 1: deepcopy completed in {step_time:.2f}s")
        
        # Extract vote data
        step_start = time.time()
        vote_data = votes.get('votes', [])
        last_vote_timestamp = votes.get('lastVoteTimestamp', self.last_updated)
        
        if not vote_data:
            return result
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] Step 2: vote data extraction completed in {time.time() - step_start:.2f}s")
        
        # Process votes - this is likely the bottleneck
        step_start = time.time()
        vote_count = 0
        
        # Process in batches to track progress
        batch_size = 5000
        total_votes = len(vote_data)
        
        for batch_start in range(0, total_votes, batch_size):
            batch_time = time.time()
            batch_end = min(batch_start + batch_size, total_votes)
            batch_votes = vote_data[batch_start:batch_end]
            
            for vote in batch_votes:
                try:
                    ptpt_id = str(vote.get('pid'))  # Ensure string
                    comment_id = str(vote.get('tid'))  # Ensure string
                    vote_value = vote.get('vote')
                    created = vote.get('created', last_vote_timestamp)
                    
                    # Skip invalid votes
                    if ptpt_id is None or comment_id is None or vote_value is None:
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
                        print(f"Error converting vote value: {e}")
                        vote_value = None
                    
                    # Skip null votes or unknown format
                    if vote_value is None:
                        continue
                    
                    # UPDATE MATRIX - this might be slow
                    sub_step_start = time.time()
                    result.raw_rating_mat = result.raw_rating_mat.update(
                        ptpt_id, comment_id, vote_value
                    )
                    vote_count += 1
                    
                    # Log very slow matrix updates
                    sub_step_time = time.time() - sub_step_start
                    if sub_step_time > 0.1:  # Log only unusually slow updates
                        elapsed = time.time() - profile_data.get('process_start_time', start_time)
                        print(f"[{elapsed:.2f}s] Slow matrix update for pid={ptpt_id}, tid={comment_id}: {sub_step_time:.4f}s")
                        
                except Exception as e:
                    elapsed = time.time() - profile_data.get('process_start_time', start_time)
                    print(f"[{elapsed:.2f}s] Error processing vote: {e}")
                    continue
            
            # Log batch progress
            batch_time = time.time() - batch_time
            elapsed = time.time() - profile_data.get('process_start_time', start_time)
            print(f"[{elapsed:.2f}s] Processed votes {batch_start+1}-{batch_end}/{total_votes} ({batch_time:.2f}s, {batch_time/len(batch_votes):.4f}s per vote)")
        
        step_time = time.time() - step_start
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] Step 3: vote processing completed in {step_time:.2f}s for {vote_count} valid votes ({step_time/max(vote_count, 1):.4f}s per vote)")
        
        # Update last updated timestamp
        step_start = time.time()
        result.last_updated = max(
            last_vote_timestamp, 
            result.last_updated
        )
        step_time = time.time() - step_start
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] Step 4: timestamp update completed in {step_time:.2f}s")
        
        # Update count stats
        step_start = time.time()
        result.participant_count = len(result.raw_rating_mat.rownames())
        result.comment_count = len(result.raw_rating_mat.colnames())
        step_time = time.time() - step_start
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] Step 5: count stats update completed in {step_time:.2f}s")
        
        # Apply moderation and create filtered rating matrix
        step_start = time.time()
        result._apply_moderation()
        step_time = time.time() - step_start
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] Step 6: moderation applied in {step_time:.2f}s")
        
        # Compute vote stats
        step_start = time.time()
        result._compute_vote_stats()
        step_time = time.time() - step_start
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] Step 7: vote stats computation completed in {step_time:.2f}s")
        
        # Recompute clustering if requested
        if recompute:
            step_start = time.time()
            try:
                result = result.recompute()
                step_time = time.time() - step_start
                elapsed = time.time() - profile_data.get('process_start_time', start_time)
                print(f"[{elapsed:.2f}s] Step 8: recomputation completed in {step_time:.2f}s")
            except Exception as e:
                elapsed = time.time() - profile_data.get('process_start_time', start_time)
                print(f"[{elapsed:.2f}s] Error during recompute: {e}")
                # If recompute fails, return the conversation with just the new votes
        
        total_time = time.time() - start_time
        elapsed = time.time() - profile_data.get('process_start_time', start_time)
        print(f"[{elapsed:.2f}s] COMPLETED update_votes in {total_time:.2f}s")
        
        # Update profiling data
        if 'update_votes' not in profile_data['method_times']:
            profile_data['method_times']['update_votes'] = 0
            profile_data['call_counts']['update_votes'] = 0
            
        profile_data['method_times']['update_votes'] += total_time
        profile_data['call_counts']['update_votes'] += 1
        
        return result
    
    # Replace the update_votes method with our instrumented version
    setattr(Conversation, 'update_votes', detailed_update_votes)
    
    print("Instrumentation complete!")
    
def restore_original_methods():
    """
    Restores the original methods of the Conversation class.
    """
    print("Restoring original Conversation class methods...")
    
    for method_name, original_method in ORIGINAL_METHODS.items():
        setattr(Conversation, method_name, original_method)
    
    print("Original methods restored!")

def print_profiling_summary():
    """
    Prints a summary of the profiling data.
    """
    print("\n===== Profiling Summary =====")
    
    # Sort methods by execution time (descending)
    methods_by_time = sorted(
        profile_data['method_times'].items(),
        key=lambda x: x[1],
        reverse=True
    )
    
    print("\nMethod execution times (sorted by total time):")
    print("-" * 70)
    print(f"{'Method':<30} {'Total Time (s)':<15} {'Calls':<10} {'Avg Time (s)':<15}")
    print("-" * 70)
    
    for method, total_time in methods_by_time:
        calls = profile_data['call_counts'].get(method, 0)
        avg_time = total_time / max(calls, 1)
        print(f"{method:<30} {total_time:<15.2f} {calls:<10} {avg_time:<15.2f}")
    
    # Slow matrix updates
    if 'slow_matrix_updates' in profile_data and profile_data['slow_matrix_updates']:
        print("\nSlow Matrix Updates (> 0.05s):")
        print("-" * 70)
        print(f"{'Row':<20} {'Col':<20} {'Time (s)':<10} {'Matrix Dims':<20}")
        print("-" * 70)
        
        # Sort by time (descending)
        slow_updates = sorted(
            profile_data['slow_matrix_updates'],
            key=lambda x: x['time'],
            reverse=True
        )
        
        # Show top 10 slowest
        for update in slow_updates[:10]:
            print(f"{update['row']:<20} {update['col']:<20} {update['time']:<10.4f} {update['matrix_dims']:<20}")
        
        print(f"\nTotal slow matrix updates: {len(slow_updates)}")
    
    print("\n===== End of Profiling Summary =====")