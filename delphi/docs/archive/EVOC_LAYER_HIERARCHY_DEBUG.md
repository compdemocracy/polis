# EVōC Layer Hierarchy Debug Investigation

**Date**: 2025-06-20  
**Issue**: Circle pack visualization showing incorrect hierarchy - all Layer 0 clusters as roots instead of nested structure  
**Status**: INVESTIGATING - Need to verify EVōC layer ordering and Delphi storage logic

## Problem Statement

The circle pack visualization is showing all 360 clusters as flat siblings instead of a true hierarchical nesting. Investigation reveals:

1. **DynamoDB Structure**: All Layer 0 clusters have `parent_cluster: null` and are treated as roots
2. **Expected Structure**: Layer 3 (coarsest) should contain Layer 2, which should contain Layer 1, which should contain Layer 0 (finest)
3. **Actual Structure**: Layer 1 clusters have `parent_cluster` pointing to Layer 0 clusters

## Key Questions to Answer

1. **How does EVōC order its cluster_layers_?** (Fine-to-coarse or coarse-to-fine?)
2. **What are the parent-child relationships supposed to represent?** (Containment or merge history?)
3. **Is there a bug in the Delphi storage logic?** (Are we storing relationships backwards?)

## Evidence Collected

### 1. EVōC Documentation (GitHub)
**Source**: https://github.com/TutteInstitute/evoc/blob/main/evoc/clustering.py  
**Finding**: "each layer is a clustering of the data into a different number of clusters; the earlier the cluster vector is in this list the finer the granularity of clustering."

**Interpretation**: 
- Layer 0 = finest granularity (most clusters)
- Layer 1 = coarser (fewer clusters)
- Layer 2 = even coarser
- Layer 3 = coarsest (fewest clusters)

### 2. DynamoDB Actual Data Structure

**Query**: `Delphi_CommentClustersStructureKeywords` for conversation 40523

**Layer Distribution**:
- Layer 0: 237 clusters
- Layer 1: 82 clusters  
- Layer 2: 31 clusters
- Layer 3: 10 clusters

**Sample Layer 0 Item**:
```json
{
  "cluster_key": "layer0_0",
  "layer_id": "0",
  "parent_cluster": null,
  "child_clusters": [{"cluster_id": "0", "layer_id": "1"}]
}
```

**Sample Layer 1 Item**:
```json
{
  "cluster_key": "layer1_0", 
  "layer_id": "1",
  "parent_cluster": {"cluster_id": "1", "layer_id": "0"},
  "child_clusters": null
}
```

**Observation**: Layer 0 (finest) has no parents, Layer 1 (coarser) has Layer 0 parents. This suggests Layer 0 is treated as "root" level.

### 3. Delphi Storage Code Analysis

**File**: `/delphi/umap_narrative/polismath_commentgraph/utils/converter.py`  
**Lines**: 936-939, 947-951

```python
parent_cluster = {
    'layer_id': layer_id - 1,  # PARENT is layer_id - 1
    'cluster_id': int(parent_id)
}

child_clusters = [
    {
        'layer_id': layer_id + 1,  # CHILDREN are layer_id + 1
        'cluster_id': int(child_id)
    }
]
```

**Analysis**: 
- Layer N has parents in Layer N-1
- Layer N has children in Layer N+1
- This makes Layer 0 the root level (no parents)
- This makes Layer 3 the deepest level (no children)

## Tests Needed

### Test 1: EVōC Layer Ordering Verification
**Goal**: Confirm that EVōC layer_id=0 is truly the finest granularity

```python
# Create controlled test data with known cluster structure
# Run EVōC clustering
# Verify cluster count decreases as layer_id increases
```

### Test 2: Semantic Verification  
**Goal**: Verify that higher layer_id clusters actually contain/represent multiple lower layer_id clusters

```python
# For each Layer 1 cluster, find all Layer 0 clusters that "belong" to it
# Verify semantic coherence - do Layer 0 clusters within a Layer 1 parent make sense?
```

### Test 3: Algorithm Logic Verification
**Goal**: Understand what EVōC's hierarchical structure actually represents

**Questions**:
- Are higher layers created by merging lower layers?
- Are layers created independently with different granularity parameters?
- What does "parent-child" mean in the context of hierarchical clustering?

### Test 4: Circle Pack Expectation Verification
**Goal**: Confirm what the visualization should look like

**Expected for Circle Pack**:
- Largest circles = Layer 3 (10 clusters, coarsest topics)
- Medium circles = Layer 2 (31 clusters) nested inside Layer 3
- Smaller circles = Layer 1 (82 clusters) nested inside Layer 2  
- Smallest circles = Layer 0 (237 clusters) nested inside Layer 1

**Current Reality**:
- All Layer 0 clusters (237) shown as top-level siblings
- No nesting structure visible

## Hypotheses

### Hypothesis A: Delphi Storage Bug
**Theory**: The parent-child relationships are stored backwards in DynamoDB  
**Evidence**: Layer 1 has Layer 0 parents (backwards from intuitive containment)  
**Fix**: Invert the relationship storage logic

### Hypothesis B: Misunderstanding EVōC
**Theory**: EVōC layers represent merge history, not containment hierarchy  
**Evidence**: Need to investigate what cluster_layers_ actually represents  
**Fix**: Build containment hierarchy differently

### Hypothesis C: Both are Correct
**Theory**: The storage is correct, but circle pack needs different data interpretation  
**Evidence**: Need to verify the intended use case  
**Fix**: Transform the data for visualization

## Next Steps

1. **Run Controlled EVōC Test** - Create synthetic data with known structure
2. **Verify Semantic Clustering** - Check if relationships make sense
3. **Check EVōC Source Code** - Understand cluster_layers_ generation
4. **Test Visualization Logic** - Confirm circle pack expectations
5. **Document Findings** - Update this document with results

## Test Results

### ✅ Test 1: EVōC Layer Ordering CONFIRMED
**Controlled test with synthetic data (200 samples, 4 known clusters)**:
- Layer 0: 21 clusters (finest granularity)
- Layer 1: 9 clusters (coarser)  
- Layer 2: 4 clusters (coarsest)

**CONCLUSION**: EVōC definitely orders layers from fine-to-coarse (Layer 0 = finest)

### ✅ Test 2: Polis Data Relationship Analysis
**Layer distribution in conversation 40523**:
- Layer 0: 237 clusters (finest)
- Layer 1: 82 clusters
- Layer 2: 31 clusters  
- Layer 3: 10 clusters (coarsest)

**Relationship direction**:
- 173/237 Layer 0 clusters have Layer 1 children
- 82/82 Layer 1 clusters have Layer 0 parents
- Only 82/173 relationships are bidirectionally consistent

### ❌ Test 3: The REAL Problem Identified

**The storage relationships represent MERGE HISTORY, not CONTAINMENT:**

1. **Multiple Layer 0 clusters merge into single Layer 1 clusters**
   - Example: L0 clusters [0, 1, 10] all point to L1 cluster 0 as their child
   - But L1 cluster 0 only has ONE parent (L0 cluster 1)

2. **This is merge/aggregation, NOT containment hierarchy**
   - Layer 0 clusters don't "contain" Layer 1 clusters
   - Multiple Layer 0 clusters "merge into" single Layer 1 clusters

## Root Cause Found

**The parent-child relationships in DynamoDB represent the clustering algorithm's merge process, NOT spatial containment suitable for circle pack visualization.**

For circle pack visualization, we need **containment hierarchy** where:
- 1 Layer 3 cluster contains multiple Layer 2 clusters
- 1 Layer 2 cluster contains multiple Layer 1 clusters  
- 1 Layer 1 cluster contains multiple Layer 0 clusters

But EVōC stores **merge relationships** where:
- Multiple Layer 0 clusters merge into 1 Layer 1 cluster
- Multiple Layer 1 clusters merge into 1 Layer 2 cluster

## Solution

**We need to INVERT the relationships for circle pack visualization:**
1. Start with Layer 3 (coarsest) as roots
2. Each Layer 3 cluster contains the Layer 2 clusters that merged into it
3. Each Layer 2 cluster contains the Layer 1 clusters that merged into it
4. Each Layer 1 cluster contains the Layer 0 clusters that merged into it

This requires building the containment hierarchy by **following the merge relationships backwards**.

---

**Status**: ✅ ROOT CAUSE IDENTIFIED - Need to invert merge relationships to create containment hierarchy for circle pack