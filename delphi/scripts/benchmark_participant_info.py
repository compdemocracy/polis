#!/usr/bin/env python3
"""
A/B benchmark: old per-participant loop vs new vectorized implementation
of _compute_participant_info_optimized.

Runs both versions on the same real data and reports wall-clock times.

Usage (from delphi/):
    uv run python scripts/benchmark_participant_info.py
    uv run python scripts/benchmark_participant_info.py --include-local
    uv run python scripts/benchmark_participant_info.py --datasets biodiversity
    uv run python scripts/benchmark_participant_info.py --runs 5
"""

import argparse
import time
import types
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from polismath.conversation.conversation import Conversation
from polismath.regression.datasets import discover_datasets
from polismath.regression.utils import prepare_votes_data


# ---------------------------------------------------------------------------
# Old implementation (copy-pasted from git parent, pre-vectorization)
# ---------------------------------------------------------------------------

def _old_loop_impl(self, vote_matrix: pd.DataFrame, group_clusters: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Original per-participant loop implementation."""
    if not group_clusters:
        return {}

    matrix_values = vote_matrix.to_numpy(copy=True)

    if not np.issubdtype(matrix_values.dtype, np.number):
        try:
            matrix_values = matrix_values.astype(float)
        except (ValueError, TypeError):
            matrix_values = vote_matrix.apply(pd.to_numeric, errors='coerce').to_numpy()

    matrix_values = np.nan_to_num(matrix_values, nan=0.0)

    result = {'participant_ids': vote_matrix.index, 'stats': {}}

    participant_count = len(vote_matrix.index)
    ptpt_idx_map = {ptpt_id: idx for idx, ptpt_id in enumerate(vote_matrix.index)}

    ptpt_group_map = {}
    for group in group_clusters:
        for member in group.get('members', []):
            ptpt_group_map[member] = group.get('id', 0)

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

    group_avg_votes = {}
    group_valid_masks = {}
    for group_id, member_indices in group_member_indices.items():
        if len(member_indices) >= 3:
            group_vote_matrix = matrix_values[member_indices, :]
            group_avg_votes[group_id] = np.mean(group_vote_matrix, axis=0)
            group_valid_masks[group_id] = np.sum(group_vote_matrix != 0, axis=0) >= 3

    for p_idx, participant_id in enumerate(vote_matrix.index):
        if p_idx >= matrix_values.shape[0]:
            continue

        participant_votes = matrix_values[p_idx, :]
        n_agree = np.sum(participant_votes > 0)
        n_disagree = np.sum(participant_votes < 0)
        n_pass = np.sum(participant_votes == 0)
        n_votes = n_agree + n_disagree

        if n_votes == 0:
            continue

        participant_group = ptpt_group_map.get(participant_id)
        group_agreements = {}

        for group_id, member_indices in group_member_indices.items():
            if len(member_indices) < 3:
                group_agreements[group_id] = 0.0
                continue
            if group_id not in group_avg_votes or group_id not in group_valid_masks:
                group_agreements[group_id] = 0.0
                continue

            g_votes = group_avg_votes[group_id]
            valid_mask = group_valid_masks[group_id]

            if np.sum(valid_mask) >= 3:
                p_votes = participant_votes[valid_mask]
                g_votes_valid = g_votes[valid_mask]
                p_std = np.std(p_votes)
                g_std = np.std(g_votes_valid)

                if p_std > 0 and g_std > 0:
                    correlation = np.corrcoef(p_votes, g_votes_valid)[0, 1]
                    if not np.isnan(correlation):
                        group_agreements[group_id] = correlation
                    else:
                        group_agreements[group_id] = 0.0
                else:
                    group_agreements[group_id] = 0.0
            else:
                group_agreements[group_id] = 0.0

        result['stats'][participant_id] = {
            'n_agree': int(n_agree),
            'n_disagree': int(n_disagree),
            'n_pass': int(n_pass),
            'n_votes': int(n_votes),
            'group': participant_group,
            'group_correlations': group_agreements
        }

    return result


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------

def run_benchmark(dataset_name: str, n_runs: int = 3) -> dict:
    """Run both implementations on a dataset, return timing results."""
    # Load data and run pipeline up to the point where participant info is needed
    votes_dict, metadata = prepare_votes_data(dataset_name)
    conv = Conversation(dataset_name)
    conv = conv.update_votes(votes_dict, recompute=True)

    vote_matrix = conv.rating_mat
    group_clusters = conv._unfolded_group_clusters()

    n_participants = len(vote_matrix)
    n_comments = vote_matrix.shape[1] if len(vote_matrix) > 0 else 0
    n_groups = len(group_clusters)

    print(f"\n{'='*60}")
    print(f"Dataset: {dataset_name}")
    print(f"  {n_participants} participants × {n_comments} comments × {n_groups} groups")
    print(f"  {n_runs} runs per implementation")
    print(f"{'='*60}")

    # --- Benchmark old (loop) implementation ---
    old_times = []
    for i in range(n_runs):
        # Bind old implementation to the conv instance
        bound = types.MethodType(_old_loop_impl, conv)
        t0 = time.perf_counter()
        old_result = bound(vote_matrix, group_clusters)
        elapsed = time.perf_counter() - t0
        old_times.append(elapsed)
        if i == 0:
            old_stats = old_result.get('stats', {})

    # --- Benchmark new (vectorized) implementation ---
    new_times = []
    for i in range(n_runs):
        t0 = time.perf_counter()
        new_result = conv._compute_participant_info_optimized(vote_matrix, group_clusters)
        elapsed = time.perf_counter() - t0
        new_times.append(elapsed)
        if i == 0:
            new_stats = new_result.get('stats', {})

    # --- Verify equivalence ---
    assert set(old_stats.keys()) == set(new_stats.keys()), "Participant ID mismatch!"
    max_corr_diff = 0.0
    for pid in old_stats:
        for gid in old_stats[pid]['group_correlations']:
            old_c = old_stats[pid]['group_correlations'][gid]
            new_c = new_stats[pid]['group_correlations'][gid]
            max_corr_diff = max(max_corr_diff, abs(float(old_c) - float(new_c)))
    assert max_corr_diff < 1e-10, f"Correlation mismatch: max diff = {max_corr_diff}"

    old_median = sorted(old_times)[len(old_times) // 2]
    new_median = sorted(new_times)[len(new_times) // 2]
    speedup = old_median / new_median if new_median > 0 else float('inf')

    print(f"\n  Old (loop):       median {old_median:.4f}s  (times: {', '.join(f'{t:.4f}s' for t in old_times)})")
    print(f"  New (vectorized): median {new_median:.4f}s  (times: {', '.join(f'{t:.4f}s' for t in new_times)})")
    print(f"  Speedup:          {speedup:.1f}x")
    print(f"  Max corr diff:    {max_corr_diff:.2e}")

    return {
        'dataset': dataset_name,
        'n_participants': n_participants,
        'n_comments': n_comments,
        'n_groups': n_groups,
        'old_median': old_median,
        'new_median': new_median,
        'speedup': speedup,
        'old_times': old_times,
        'new_times': new_times,
    }


def main():
    parser = argparse.ArgumentParser(description="Benchmark participant info: old loop vs vectorized")
    parser.add_argument('--include-local', action='store_true', help="Include private datasets")
    parser.add_argument('--datasets', type=str, default=None, help="Comma-separated dataset names")
    parser.add_argument('--runs', type=int, default=3, help="Number of runs per implementation (>=1)")
    args = parser.parse_args()

    if args.runs < 1:
        parser.error("--runs must be a positive integer (got %d)" % args.runs)

    all_datasets = discover_datasets(include_local=args.include_local)
    valid = [name for name, info in all_datasets.items() if info.is_valid]

    if args.datasets:
        requested = {d.strip() for d in args.datasets.split(',')}
        valid = [d for d in valid if d in requested]

    if not valid:
        print("No datasets found. Use --include-local or --datasets.")
        return

    results = []
    for ds in sorted(valid):
        r = run_benchmark(ds, n_runs=args.runs)
        results.append(r)

    # Summary table
    print(f"\n\n{'='*80}")
    print("SUMMARY")
    print(f"{'='*80}")
    print(f"{'Dataset':<25} {'Size':<25} {'Old (s)':<12} {'New (s)':<12} {'Speedup':<10}")
    print(f"{'-'*80}")
    for r in results:
        size = f"{r['n_participants']}p × {r['n_comments']}c × {r['n_groups']}g"
        print(f"{r['dataset']:<25} {size:<25} {r['old_median']:<12.4f} {r['new_median']:<12.4f} {r['speedup']:<10.1f}x")


if __name__ == '__main__':
    main()
