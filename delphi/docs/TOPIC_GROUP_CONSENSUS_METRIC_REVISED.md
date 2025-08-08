# Topic-Level Group Consensus Metric - Revised Design

## Executive Summary

This document presents a statistically rigorous metric for measuring inter-group consensus at the topic level, incorporating critical improvements to handle exposure bias, missing data, and calibration. The revised Inter-Group Alignment Score (IGAS) produces interpretable values with uncertainty estimates and proper null model calibration.

## Core Improvements from Critique

1. **Separation of exposure from choice**: Distinguishes "didn't see" from "chose not to vote"
2. **Proper statistical foundations**: Jensen-Shannon divergence, Dirichlet smoothing, bootstrap CIs
3. **Calibrated baselines**: Null model via permutation testing instead of arbitrary thresholds
4. **Robust weighting**: Overlap-based weights that don't double-count or favor large groups
5. **Explicit handling of undefined cases**: NA instead of arbitrary defaults

## Mathematical Framework

### Data Model

For each group g and comment c, we track:
- **A_{g,c}**: Number of agrees
- **D_{g,c}**: Number of disagrees  
- **P_{g,c}**: Number of passes
- **E_{g,c}**: Number of participants exposed to comment
- **N_{g,c}** = A_{g,c} + D_{g,c} + P_{g,c}: Total votes

### Smoothed Vote Distributions

Apply Dirichlet smoothing with α = 0.5 (Jeffreys prior):

```
p̃_{g,c} = [A_{g,c} + α, D_{g,c} + α, P_{g,c} + α] / (N_{g,c} + 3α)
```

### Similarity Metric: Jensen-Shannon Divergence

For groups i and j on comment c:
```
s^out_{ij,c} = 1 - JSD(p̃_{i,c}, p̃_{j,c})
```

Where JSD ∈ [0,1] is the Jensen-Shannon divergence.

### Overlap Weighting

Weight by voting overlap:
```
w_{ij,c} = min(N_{i,c}, N_{j,c})
```

Or alternatively: `w_{ij,c} = sqrt(N_{i,c} × N_{j,c})`

### Per-Pair Metrics

#### Outcome Consensus
Only include comments where both groups have sufficient data:
- E_{i,c} ≥ e_min (default: 10)
- E_{j,c} ≥ e_min
- N_{i,c} ≥ n_min (default: 5)
- N_{j,c} ≥ n_min

```
S^out_{ij} = Σ_c w_{ij,c} × s^out_{ij,c} / Σ_c w_{ij,c}
```

#### Attention Overlap
```
S^att_{ij} = |{c: E_{i,c} ≥ e_min} ∩ {c: E_{j,c} ≥ e_min}| / 
             |{c: E_{i,c} ≥ e_min} ∪ {c: E_{j,c} ≥ e_min}|
```

#### Combined Score
```
S_{ij} = β × S^out_{ij} + (1-β) × S^att_{ij}
```
With β = 0.85 (outcome-focused but accounting for attention patterns)

### Final Aggregation

Weight pairs by their total overlap:
```
W_{ij} = Σ_c w_{ij,c}
```

```
IGAS = Σ_{i<j} W_{ij} × S_{ij} / Σ_{i<j} W_{ij}
```

## Calibration and Uncertainty

### Null Model
1. For each comment, permute group labels B=200 times
2. Recompute IGAS for each permutation
3. Extract E_null[IGAS] and sd_null[IGAS]
4. Report z-score: `z = (IGAS - E_null) / sd_null`

### Bootstrap Confidence Intervals
1. Resample comments with replacement B=1000 times
2. Compute IGAS for each bootstrap sample
3. Report 95% CI as [2.5th percentile, 97.5th percentile]

### Interpretation
Instead of fixed thresholds, report:
- **Calibrated percentile**: "This topic shows more consensus than X% of random groupings"
- **Effect size**: z-score magnitude
- **Uncertainty**: ±1 SE or 95% CI

## Implementation Details

### Edge Cases
- **Single group**: Return NA with message "Inter-group consensus not defined for single group"
- **No votes**: Return NA with coverage statistics
- **No overlap**: Report based on attention overlap only (S^out undefined)

### Algorithm

```python
def compute_IGAS(topic_data):
    groups = topic_data.groups
    comments = topic_data.comments
    
    # Parameters
    alpha = 0.5  # Dirichlet smoothing
    n_min = 5    # Min votes per group per comment
    e_min = 10   # Min exposure per group per comment
    beta = 0.85  # Outcome vs attention weight
    
    # Step 1: Compute pairwise similarities
    pair_scores = {}
    pair_weights = {}
    
    for i in range(len(groups)):
        for j in range(i+1, len(groups)):
            outcome_scores = []
            outcome_weights = []
            
            for c in comments:
                # Check sufficient data
                if (E[i,c] >= e_min and E[j,c] >= e_min and
                    N[i,c] >= n_min and N[j,c] >= n_min):
                    
                    # Smooth vote distributions
                    p_i = dirichlet_smooth(A[i,c], D[i,c], P[i,c], alpha)
                    p_j = dirichlet_smooth(A[j,c], D[j,c], P[j,c], alpha)
                    
                    # Compute similarity
                    sim = 1 - jensen_shannon_divergence(p_i, p_j)
                    weight = min(N[i,c], N[j,c])
                    
                    outcome_scores.append(sim)
                    outcome_weights.append(weight)
            
            # Aggregate outcome similarity
            if sum(outcome_weights) > 0:
                S_out = sum(s*w for s,w in zip(outcome_scores, outcome_weights)) / sum(outcome_weights)
                coverage = len(outcome_scores) / len(comments)
            else:
                S_out = None
                coverage = 0
            
            # Compute attention overlap
            exposed_i = {c for c in comments if E[i,c] >= e_min}
            exposed_j = {c for c in comments if E[j,c] >= e_min}
            S_att = len(exposed_i & exposed_j) / len(exposed_i | exposed_j) if exposed_i | exposed_j else 0
            
            # Combine
            if S_out is not None:
                S_ij = beta * S_out + (1-beta) * S_att
            else:
                S_ij = S_att  # Fallback to attention only
            
            pair_scores[(i,j)] = S_ij
            pair_weights[(i,j)] = sum(outcome_weights)
    
    # Step 2: Aggregate across pairs
    if sum(pair_weights.values()) > 0:
        IGAS = sum(pair_scores[p] * pair_weights[p] for p in pair_scores) / sum(pair_weights.values())
    else:
        return None, "Insufficient data for inter-group comparison"
    
    # Step 3: Calibration
    null_scores = []
    for _ in range(200):
        # Permute group labels within each comment
        permuted_data = permute_group_labels(topic_data)
        null_score = compute_IGAS_raw(permuted_data)
        null_scores.append(null_score)
    
    E_null = np.mean(null_scores)
    sd_null = np.std(null_scores)
    z_score = (IGAS - E_null) / sd_null if sd_null > 0 else 0
    
    # Step 4: Bootstrap CI
    bootstrap_scores = []
    for _ in range(1000):
        resampled_comments = resample_with_replacement(comments)
        boot_score = compute_IGAS_raw(topic_data, resampled_comments)
        bootstrap_scores.append(boot_score)
    
    ci_lower = np.percentile(bootstrap_scores, 2.5)
    ci_upper = np.percentile(bootstrap_scores, 97.5)
    
    return {
        'IGAS': IGAS,
        'z_score': z_score,
        'ci_lower': ci_lower,
        'ci_upper': ci_upper,
        'null_mean': E_null,
        'null_sd': sd_null,
        'coverage': coverage,
        'pair_details': pair_scores
    }
```

## Alternative Metrics (Sanity Checks)

### 1. Intraclass Correlation Coefficient (ICC)
```python
def compute_ICC(topic_data):
    # Convert to scalar opinion per group per comment
    opinions = {}
    for g in groups:
        for c in comments:
            if N[g,c] >= n_min:
                opinions[g,c] = (A[g,c] - D[g,c]) / (A[g,c] + D[g,c] + 2*alpha)
    
    # Compute variance components
    within_var = compute_within_group_variance(opinions)
    total_var = compute_total_variance(opinions)
    
    ICC = 1 - (within_var / total_var) if total_var > 0 else 0
    return ICC
```

### 2. Normalized Mutual Information
```python
def compute_NMI_consensus(topic_data):
    # Compute I(Vote; Group | Comment)
    MI = mutual_information(votes, groups, given=comments)
    H_max = entropy(votes, given=comments)
    
    # High MI = groups predict votes = low consensus
    consensus = 1 - (MI / H_max) if H_max > 0 else 0.5
    return consensus
```

## Production Checklist

- [ ] Implement Jensen-Shannon divergence with numerical stability
- [ ] Add exposure tracking to data pipeline
- [ ] Create efficient permutation test implementation
- [ ] Add caching for bootstrap/null computations
- [ ] Build monitoring for clustering stability
- [ ] Create API endpoint with full result structure
- [ ] Add frontend visualization of uncertainty
- [ ] Document pass vote handling options
- [ ] Validate against human-labeled consensus examples

## API Response Format

```json
{
  "topic_id": "layer0_cluster5",
  "consensus": {
    "IGAS": 0.743,
    "confidence_interval": [0.712, 0.771],
    "z_score": 2.34,
    "interpretation": {
      "percentile": 89.3,
      "category": "high",
      "description": "Higher consensus than 89% of random groupings"
    },
    "coverage": {
      "comments_included": 0.82,
      "pairs_with_data": 1.0
    },
    "decomposition": {
      "outcome_contribution": 0.631,
      "attention_contribution": 0.112
    }
  },
  "alternative_metrics": {
    "ICC": 0.689,
    "NMI_consensus": 0.701
  },
  "metadata": {
    "num_groups": 4,
    "computation_time_ms": 127,
    "version": "2.0"
  }
}
```

## Summary

This revised metric addresses all major statistical concerns while remaining interpretable and actionable. The separation of exposure from choice, proper uncertainty quantification, and calibrated interpretation make this suitable for production use in ranking topics by genuine inter-group consensus rather than artifacts of data collection or arbitrary thresholds.