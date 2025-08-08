# Topic-Level Group Consensus Metric Design

## Executive Summary

This document defines a rigorous metric for measuring group consensus at the topic level, producing a value between 0 and 1 that meaningfully captures how much different opinion groups agree or disagree on a collection of comments within a topic.

## Problem Statement

Current group consensus metrics are calculated per-comment and then averaged, which fails to capture the holistic agreement patterns across a topic. We need a metric that:

1. Measures inter-group agreement across ALL comments in a topic collectively
2. Produces interpretable values between 0 (complete disagreement) and 1 (complete agreement)
3. Handles varying numbers of groups (2-5 from k-means)
4. Accounts for both voting patterns AND voting participation
5. Is statistically robust and theoretically grounded

## Proposed Metric: Inter-Group Alignment Score (IGAS)

### Core Concept

The Inter-Group Alignment Score measures the similarity of voting patterns between groups across all comments in a topic. It combines three key components:

1. **Vote Pattern Similarity**: How similarly groups vote on comments
2. **Participation Alignment**: How similarly groups choose which comments to vote on
3. **Confidence Weighting**: Higher weight for comments with more votes

### Mathematical Definition

For a topic T with comments C = {c₁, c₂, ..., cₙ} and groups G = {g₁, g₂, ..., gₖ}:

```
IGAS(T) = Σᵢ<ⱼ w_ij × S(gᵢ, gⱼ) / (k choose 2)
```

Where:
- `w_ij` is the pairwise weight between groups i and j
- `S(gᵢ, gⱼ)` is the similarity score between groups i and j
- The sum is over all unique group pairs

### Detailed Calculation

#### Step 1: Build Group Voting Matrices

For each group g, create a voting matrix V_g where:
- Rows represent comments in the topic
- Columns represent [agree_rate, disagree_rate, pass_rate, participation_rate]

```
V_g[c] = [
  agrees_c / total_votes_c,
  disagrees_c / total_votes_c,
  passes_c / total_votes_c,
  voters_c / group_size
]
```

#### Step 2: Calculate Pairwise Similarity

For each pair of groups (gᵢ, gⱼ), calculate similarity across all comments:

```python
def calculate_similarity(V_i, V_j):
    similarities = []
    weights = []
    
    for c in comments:
        # Skip if neither group voted on this comment
        if V_i[c].participation == 0 and V_j[c].participation == 0:
            continue
            
        # Calculate voting pattern similarity (cosine similarity on agree/disagree/pass)
        vote_pattern_i = V_i[c][:3]  # agree, disagree, pass rates
        vote_pattern_j = V_j[c][:3]
        
        pattern_similarity = cosine_similarity(vote_pattern_i, vote_pattern_j)
        
        # Calculate participation similarity
        participation_similarity = 1 - abs(V_i[c][3] - V_j[c][3])
        
        # Combined similarity for this comment
        comment_similarity = 0.8 * pattern_similarity + 0.2 * participation_similarity
        
        # Weight by total participation
        weight = (V_i[c][3] + V_j[c][3]) / 2
        
        similarities.append(comment_similarity)
        weights.append(weight)
    
    # Weighted average similarity
    if sum(weights) > 0:
        return sum(s * w for s, w in zip(similarities, weights)) / sum(weights)
    else:
        return 0.5  # No overlap = neutral similarity
```

#### Step 3: Calculate Group Pair Weights

Weight each group pair by their relative sizes and activity:

```python
def calculate_pair_weight(g_i, g_j, total_participants):
    size_weight = (len(g_i) + len(g_j)) / (2 * total_participants)
    activity_weight = (g_i.vote_count + g_j.vote_count) / total_topic_votes
    return (size_weight + activity_weight) / 2
```

#### Step 4: Aggregate to Final Score

```python
def calculate_IGAS(topic):
    total_score = 0
    total_weight = 0
    
    for i in range(num_groups):
        for j in range(i+1, num_groups):
            similarity = calculate_similarity(V[i], V[j])
            weight = calculate_pair_weight(groups[i], groups[j], total_participants)
            
            total_score += weight * similarity
            total_weight += weight
    
    if total_weight > 0:
        return total_score / total_weight
    else:
        return 0.5  # Default to neutral
```

### Interpretation

- **0.0 - 0.2**: Strong disagreement between groups
- **0.2 - 0.4**: Moderate disagreement
- **0.4 - 0.6**: Mixed/neutral - some agreement, some disagreement
- **0.6 - 0.8**: Moderate agreement
- **0.8 - 1.0**: Strong agreement between groups

### Key Properties

1. **Symmetric**: S(gᵢ, gⱼ) = S(gⱼ, gᵢ)
2. **Bounded**: Always produces values in [0, 1]
3. **Weighted**: Accounts for group sizes and voting activity
4. **Robust**: Handles missing data and low participation gracefully
5. **Interpretable**: Linear scale from disagreement to agreement

### Edge Cases

1. **Single Group**: Return 1.0 (perfect consensus with self)
2. **No Votes**: Return 0.5 (neutral/unknown)
3. **Non-overlapping Comments**: Groups that vote on completely different comments get similarity based on the pattern of non-participation
4. **Sparse Voting**: Comments with very few votes get lower weight

### Advantages Over Current Approach

1. **Holistic**: Considers all comments together, not individually
2. **Nuanced**: Captures both what groups vote on AND how they vote
3. **Fair**: Weights by actual participation, not just group count
4. **Meaningful**: Produces interpretable values that don't depend on k-means group count

### Implementation Notes

1. Use NumPy for efficient matrix operations
2. Cache group voting matrices for performance
3. Consider using Jensen-Shannon divergence as alternative to cosine similarity
4. Add optional parameters for tweaking weights (vote pattern vs participation)

### Alternative Formulations

#### Option 2: Variance-Based Approach
```
IGAS = 1 - (average_within_topic_variance / maximum_possible_variance)
```

#### Option 3: Entropy-Based Approach
```
IGAS = 1 - (H(votes|group) / H_max)
```

Where H(votes|group) is the conditional entropy of votes given group membership.

### Validation Strategy

1. Test on known consensus topics (should score > 0.8)
2. Test on known divisive topics (should score < 0.3)
3. Compare with human judgments of topic consensus
4. Ensure stability across different k values (2-5 groups)

## Recommendation

Implement the Inter-Group Alignment Score (IGAS) as defined above. It provides a theoretically sound, practically useful metric that captures the nuanced reality of group agreement patterns within topics. The metric is robust to the k-means constraint while providing meaningful differentiation between topics with varying levels of inter-group consensus.

### Next Steps

1. Implement the IGAS calculation in the topicStats route
2. Store pre-calculated IGAS values in DynamoDB for performance
3. Add to the topicStats display with clear interpretation guidelines
4. Validate on real conversation data
5. Consider creating a simpler "consensus category" field (high/medium/low) based on IGAS thresholds