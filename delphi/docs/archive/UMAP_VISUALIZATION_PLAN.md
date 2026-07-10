# UMAP Spatial Visualization Plan

## Overview
Create a 2D scatter plot visualization showing all topic clusters in their actual UMAP coordinate space, with convex hulls defining semantic zones. This will be displayed as its own visualization card above the circle pack on the TopicHierarchy route.

## Implementation Approach

### 1. Data Fetching
- Fetch all UMAP coordinates for all 360 clusters using the proximity endpoint
- Get coordinates for all layers (0, 1, 2, 3) simultaneously
- Include topic names and cluster metadata

### 2. Visualization Components
- **Scatter Plot**: All clusters as points in 2D UMAP space
- **Convex Hulls**: Boundaries around each layer's cluster groups
- **Color Coding**: Different colors for each layer (0=finest, 3=coarsest)
- **Interactive Labels**: Hover to see topic names
- **Zoom/Pan**: D3 zoom behavior for exploration

### 3. Layout Structure
```jsx
<div className="visualization-container">
  {/* UMAP Spatial Visualization - NEW */}
  <div className="umap-card">
    <h3>Topic Spatial Distribution</h3>
    <p>UMAP projection showing semantic neighborhoods</p>
    <div ref={umapRef} className="umap-visualization"></div>
  </div>
  
  {/* Circle Pack Visualization - EXISTING */}
  <div className="circle-pack-card">
    <h3>Topic Hierarchy</h3>
    <div ref={circlePackRef} className="circle-pack-visualization"></div>
  </div>
</div>
```

### 4. Technical Implementation

#### Data Structure
```javascript
// Expected data format from proximity endpoint
const umapData = [
  {
    cluster_id: "layer0_43",
    layer: 0,
    topic_name: "Improving Bowling Green Healthcare",
    umap_x: 12.5,
    umap_y: 8.2,
    size: 15
  },
  // ... all 360 clusters
];
```

#### D3 Visualization Code
```javascript
const createUMAPVisualization = () => {
  // 1. Set up SVG with zoom behavior
  // 2. Create scales for UMAP coordinates
  // 3. Plot all points as circles
  // 4. Calculate and draw convex hulls for each layer
  // 5. Add hover interactions and labels
  // 6. Color code by layer
}
```

#### Convex Hull Generation
```javascript
// Group clusters by layer and generate hulls
const layerGroups = d3.group(data, d => d.layer);
layerGroups.forEach((clusters, layer) => {
  const points = clusters.map(d => [xScale(d.umap_x), yScale(d.umap_y)]);
  const hull = d3.polygonHull(points);
  // Draw hull polygon
});
```

### 5. Visual Design
- **Point sizes**: Proportional to cluster size
- **Colors**: Layer-based (blues for Layer 0 → reds for Layer 3)
- **Hulls**: Semi-transparent fills with contrasting borders
- **Typography**: Clear labels for topic names on hover
- **Grid**: Subtle background grid for spatial reference

### 6. Interactions
- **Hover**: Show topic name and cluster details
- **Click**: Highlight related clusters or navigate to topic details
- **Zoom**: Mouse wheel zoom with pan
- **Layer toggle**: Show/hide specific layers

### 7. Benefits
- **True Spatial Relationships**: Shows actual semantic neighborhoods
- **Zone Identification**: Clear boundaries between topic areas
- **Scalability**: Can handle all 360 clusters simultaneously
- **Complementary**: Works alongside circle pack for different perspectives
- **Interactive**: Allows exploration of topic landscape

### 8. API Requirements
- Modify proximity endpoint to return all clusters at once
- Include UMAP coordinates, topic names, sizes, and layer info
- Ensure efficient data transfer for all 360 points

This visualization will reveal the actual "topology" of topic space rather than artificial hierarchical containers, showing where topics naturally cluster in semantic space.

## DynamoDB Query Commands (Development Only)

**IMPORTANT**: These scan commands are for development/debugging only. In production, we use proper query operations through the API endpoints, not direct DynamoDB scans.

### Useful Development Queries

#### Get All Clusters for Conversation
```bash
# Count total clusters
aws dynamodb scan --table-name Delphi_CommentClustersStructureKeywords \
  --filter-expression "conversation_id = :cid" \
  --expression-attribute-values '{":cid":{"S":"40523"}}' \
  --endpoint-url http://localhost:8000 | jq '.Items | length'

# Count by layer
aws dynamodb scan --table-name Delphi_CommentClustersStructureKeywords \
  --filter-expression "conversation_id = :cid" \
  --expression-attribute-values '{":cid":{"S":"40523"}}' \
  --endpoint-url http://localhost:8000 | \
  jq '.Items | group_by(.layer_id.N) | map({layer: .[0].layer_id.N, count: length})'
```

#### Trace Topic Hierarchy Chains
```bash
# Get specific cluster with parent info
aws dynamodb scan --table-name Delphi_CommentClustersStructureKeywords \
  --filter-expression "conversation_id = :cid AND cluster_key = :key" \
  --expression-attribute-values '{":cid":{"S":"40523"}, ":key":{"S":"layer3_0"}}' \
  --endpoint-url http://localhost:8000 | \
  jq '.Items[0] | {cluster: .cluster_key.S, layer: .layer_id.N, parent: .parent_cluster}'

# Find all children of a parent cluster
aws dynamodb scan --table-name Delphi_CommentClustersStructureKeywords \
  --filter-expression "conversation_id = :cid" \
  --expression-attribute-values '{":cid":{"S":"40523"}}' \
  --endpoint-url http://localhost:8000 | \
  jq '.Items | map(select(.parent_cluster.M.cluster_id.N == "5" and .parent_cluster.M.layer_id.N == "2")) | map(.cluster_key.S)'
```

#### Get Topic Names
```bash
# Get topic name for specific cluster
aws dynamodb scan --table-name Delphi_CommentClustersLLMTopicNames \
  --filter-expression "conversation_id = :cid AND topic_key = :key" \
  --expression-attribute-values '{":cid":{"S":"40523"}, ":key":{"S":"layer0_43"}}' \
  --endpoint-url http://localhost:8000 | jq '.Items[0].topic_name.S'
```

#### Find Branching Structure
```bash
# Find parents with multiple children
aws dynamodb scan --table-name Delphi_CommentClustersStructureKeywords \
  --filter-expression "conversation_id = :cid" \
  --expression-attribute-values '{":cid":{"S":"40523"}}' \
  --endpoint-url http://localhost:8000 | \
  jq '.Items | group_by(.parent_cluster.M.cluster_id.N) | map({parent_id: .[0].parent_cluster.M.cluster_id.N, parent_layer: .[0].parent_cluster.M.layer_id.N, children_count: length}) | map(select(.children_count > 1))'
```

#### Sample Tree Traversal (Healthcare Branch)
```
🏥 "Improving Bowling Green Healthcare" (layer0_43 - ROOT)
   └── merges into "Healthcare in Bowling Green" (layer1_11)
       └── merges into "Improved Healthcare Options" (layer2_5)
           └── merges into "Healthcare in the Future" (layer3_0)
```

### Production API Endpoints (Use These Instead)

#### For UMAP Visualization Data
```javascript
// Get all UMAP coordinates for all clusters
fetch(`/api/v3/topicMod/proximity?conversation_id=${conversationId}&layer_id=all`)

// Get topics with names
fetch(`/api/v3/topicMod/topics?conversation_id=${conversationId}`)

// Get hierarchy structure
fetch(`/api/v3/topicMod/hierarchy?conversation_id=${conversationId}`)
```

### Key Insights from Data Exploration
1. **Linear Chains**: Most topic relationships are linear chains rather than branching trees
2. **Layer Structure**: 237 Layer 0 → 82 Layer 1 → 31 Layer 2 → 10 Layer 3
3. **Parent Direction**: "Parent" means "merges into" (Layer 0 → Layer 1 → Layer 2 → Layer 3)
4. **Root Clusters**: Some clusters at each layer have no parents (multiple entry points)
5. **Semantic Progression**: Topics flow from specific issues → local scope → broader concepts → future visions

### Why UMAP Visualization is Better
The hierarchical tree structure shows mostly linear chains, which doesn't provide meaningful spatial containment for circle packing. UMAP coordinates will show the actual semantic neighborhoods and clustering zones that exist in the topic space.