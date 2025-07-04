# Spatial Topic Prioritization System (STPS)

## Executive Summary

The Spatial Topic Prioritization System (STPS) is a core component of pol.is designed for **national-scale agenda setting**. It enables intelligent filtering and prioritization of topics across hierarchical layers using spatial proximity in UMAP embedding space. By leveraging the semantic relationships encoded in UMAP coordinates, STPS allows users to set broad priorities at coarse layers and automatically discover related topics at finer layers, creating a **cascading spatial filter** through the topic hierarchy.

## System Overview

### Core Concept

Topics that are spatially close in UMAP space are semantically related. When a user prioritizes topics at Layer 3 (coarsest), STPS uses **density estimation** around those priority topics to identify semantically related topics in Layer 2. This process cascades down through all layers (3→2→1→0), creating an intelligent agenda-setting workflow that preserves semantic coherence.

### Key Innovation

Rather than using simple centroid-based distance calculations, STPS employs **Gaussian density estimation** to account for:

- Variable cluster shapes and sizes
- Overlapping semantic neighborhoods
- Non-uniform topic distributions in UMAP space
- Gradual semantic transitions between related topics

## Technical Architecture

### Data Requirements

#### Input Data

1. **UMAP Coordinates**

   - All comments with (x, y) coordinates in UMAP embedding space
   - Obtained from: `/api/v3/topicMod/proximity?conversation_id=${id}&layer_id=all`
   - Structure: `{comment_id, umap_x, umap_y, clusters: {0: id, 1: id, 2: id, 3: id}}`

2. **Hierarchical Cluster Assignments**

   - Each comment assigned to clusters at layers 0-3
   - Layer 0: Finest granularity (most clusters)
   - Layer 3: Coarsest granularity (fewest clusters)
   - Stored in: `Delphi_CommentHierarchicalClusterAssignments`

3. **Topic Metadata**
   - Topic names, descriptions, comment counts per cluster
   - Obtained from: `/api/v3/topicMod/topics?conversation_id=${id}`
   - Maps cluster IDs to human-readable topic labels

#### Derived Data (Computed)

1. **Cluster Point Collections**

   - All UMAP points grouped by `(layer, cluster_id)`
   - Used for density calculations and spatial operations

2. **Density Surfaces**

   - 2D Gaussian density maps for each cluster at each layer
   - Grid-based sampling with configurable resolution
   - Precomputed for performance in production

3. **Spatial Proximity Matrices**
   - Cross-layer proximity relationships
   - Distance/overlap metrics between clusters across layers
   - Cached for real-time filtering

### Core Algorithms

#### 1. Density Estimation

**Gaussian Kernel Density Estimation:**

```
density(x, y) = Σ exp(-(distance²) / (2 * σ²))
```

Where:

- `distance = √((x - point.x)² + (y - point.y)²)`
- `σ = radius / 3` (standard deviation)
- `radius = 25` (configurable density neighborhood)

**Grid Sampling:**

- Sample density at regular grid points (default: 4px spacing)
- Create continuous density surface for each cluster
- Store significant density values (threshold: 0.1)

#### 2. Spatial Proximity Detection

**Density Overlap Method:**

```
proximity_score = ∫∫ min(density_A(x,y), density_B(x,y)) dx dy
```

This measures the **spatial overlap** between density surfaces of clusters in different layers.

**Distance-Based Method (Fallback):**

```
distance = √((centroid_A.x - centroid_B.x)² + (centroid_A.y - centroid_B.y)²)
proximity = exp(-distance / threshold)
```

#### 3. Cascading Filter Algorithm

**Layer-by-Layer Filtering:**

1. **Layer 3 (Start):** User sets priorities (LOW/MEDIUM/HIGH/SPAM)
2. **Layer 2 Filter:**
   - Find density surfaces of HIGH/MEDIUM priority Layer 3 clusters
   - Calculate overlap with all Layer 2 cluster density surfaces
   - Show only Layer 2 clusters with proximity_score > threshold
3. **Layer 1 Filter:** Same process using Layer 2 priorities
4. **Layer 0 Filter:** Same process using Layer 1 priorities

**Thresholds (Configurable):**

- HIGH priority clusters: Include clusters with proximity_score > 0.3
- MEDIUM priority clusters: Include clusters with proximity_score > 0.2
- Adaptive thresholds based on cluster size and density

## Implementation Phases

### Phase 1: Client-Side Prototype (Current)

**Status:** In Development
**Location:** `/client-report/src/components/topicPrioritize/`

**Capabilities:**

- Fetch UMAP data from existing API
- Compute density surfaces in browser
- Real-time spatial filtering as user sets priorities
- Interactive layer navigation with spatial constraints

**Limitations:**

- Performance constraints for large datasets
- Recomputes spatial relationships on each interaction
- No persistence of spatial proximity data

### Phase 2: Server-Side Computation (Next)

**Status:** Planned
**Location:** `/delphi/umap_narrative/` pipeline

**Server-Side Precomputation:**

1. **During UMAP Pipeline:**

   - Compute density surfaces for all clusters at all layers
   - Calculate spatial proximity matrices between layers
   - Store in `Delphi_SpatialProximityCache` table

2. **API Enhancements:**

   - `/api/v3/topicMod/spatial-proximity?conversation_id=${id}&layer=${n}`
   - Returns precomputed proximity relationships
   - Fast filtering based on cached spatial data

3. **Storage Schema:**

```sql
Delphi_SpatialProximityCache:
- conversation_id (string)
- source_layer (number)
- source_cluster_id (number)
- target_layer (number)
- target_cluster_id (number)
- proximity_score (number)
- density_overlap (number)
- centroid_distance (number)
- created_at (timestamp)
```

### Phase 3: Advanced Spatial Features (Future)

**Status:** Research

**Multi-Dimensional Proximity:**

- Extend beyond 2D UMAP to n-dimensional semantic space
- More sophisticated density estimation methods
- Machine learning-based proximity prediction

**Dynamic Threshold Optimization:**

- Adaptive thresholds based on conversation characteristics
- User behavior learning for personalized filtering
- A/B testing of different proximity algorithms

## User Experience Design

### Interaction Flow

1. **Layer 3 (Coarsest Topics):**

   - User sees 8-15 broad topics (e.g., "Healthcare," "Education," "Urban Planning")
   - Click to cycle: LOW → MEDIUM → HIGH → SPAM/TRASH
   - Visual feedback: Progressive border darkening, background changes

2. **Layer 2 (Filtered Topics):**

   - Shows only topics spatially related to HIGH/MEDIUM Layer 3 selections
   - Count reduces from ~31 to ~12 topics (example)
   - Header indicates "(spatially filtered)"
   - User continues prioritization

3. **Layer 1 & 0 (Progressive Refinement):**
   - Further spatial filtering based on Layer 2 priorities
   - Increasingly specific topics emerge
   - Maintains semantic coherence throughout

### Visual Design Principles

**Spatial Feedback:**

- Border thickness/darkness indicates priority level
- Filtered topics show spatial relationship hints
- Count changes demonstrate filtering effectiveness

**Cognitive Load Reduction:**

- Start broad (Layer 3), refine incrementally
- Only show relevant topics at each layer
- Clear priority progression (LOW→MEDIUM→HIGH→SPAM)

**Agenda Setting Focus:**

- Optimized for national-scale conversation prioritization
- Balances comprehensiveness with focus
- Preserves semantic relationships during filtering

## Performance Considerations

### Computational Complexity

**Density Estimation:**

- O(n \* g) where n = points, g = grid cells
- For 10,000 comments, ~1-2 seconds computation time
- Scales linearly with conversation size

**Spatial Proximity:**

- O(c1 \* c2) where c1, c2 = cluster counts in adjacent layers
- Typically ~300 cluster pairs per layer transition
- Milliseconds for proximity lookup with precomputation

**Real-Time Performance Targets:**

- Client-side filtering: <100ms response time
- Server-side precomputation: <5 minutes for 50k comment conversation
- API response: <50ms for proximity data

### Optimization Strategies

**Precomputation (Phase 2):**

- Calculate spatial relationships during UMAP pipeline
- Store proximity matrices in DynamoDB
- Serve cached results via API

**Progressive Loading:**

- Load Layer 3 data immediately
- Fetch deeper layer data on demand
- Cache spatial relationships in browser

**Algorithmic Optimizations:**

- Spatial indexing (QuadTree) for fast proximity queries
- Hierarchical density approximation
- GPU acceleration for density computation (future)

## Data Storage Requirements

### New DynamoDB Tables

#### `Delphi_SpatialProximityCache`

```
Primary Key: conversation_id + source_layer + source_cluster_id
Sort Key: target_layer + target_cluster_id
Attributes:
- proximity_score (number, 0.0-1.0)
- density_overlap (number)
- centroid_distance (number)
- spatial_method (string: "density" | "centroid")
- created_at (timestamp)
- expires_at (timestamp, TTL)
```

#### `Delphi_ClusterDensitySurfaces`

```
Primary Key: conversation_id + layer + cluster_id
Attributes:
- density_grid (binary: compressed grid data)
- centroid_x, centroid_y (numbers)
- bounding_box (object: {min_x, min_y, max_x, max_y})
- point_count (number)
- max_density (number)
- grid_resolution (number)
- created_at (timestamp)
```

#### `Delphi_UserTopicPriorities` (Future)

```
Primary Key: conversation_id + user_id
Attributes:
- priority_map (object: {topic_key: priority_level})
- spatial_filter_active (boolean)
- last_updated (timestamp)
- session_id (string)
```

### Storage Estimates

**Per Conversation (50k comments):**

- SpatialProximityCache: ~50KB (sparse matrix)
- ClusterDensitySurfaces: ~200KB (compressed grids)
- Total additional storage: <1MB per conversation

**DynamoDB Costs:**

- Read/Write capacity scales with user activity
- Proximity cache accessed on layer navigation
- Density surfaces loaded once per session

## Integration Points

### Frontend Integration

**TopicPrioritize Component:**

- Spatial filtering logic integrated into topic rendering
- Real-time updates as user sets priorities
- Visual feedback for spatial relationships

**API Consumption:**

- `/api/v3/topicMod/spatial-proximity` for cached relationships
- `/api/v3/topicMod/proximity` for raw UMAP data (Phase 1)
- Graceful fallback to non-spatial mode if data unavailable

### Backend Integration

**UMAP Pipeline Enhancement:**

- Add spatial computation step after UMAP generation
- Integrate with existing `run_pipeline.py` workflow
- Store spatial data alongside topic generation

**API Layer:**

- New endpoints for spatial proximity data
- Enhanced existing endpoints with spatial metadata
- Performance monitoring for spatial queries

### Monitoring & Analytics

**Performance Metrics:**

- Spatial computation time per conversation
- API response times for proximity queries
- User interaction patterns with spatial filtering

**Quality Metrics:**

- Spatial filtering effectiveness (user satisfaction)
- Semantic coherence of filtered topics
- False positive/negative rates in proximity detection

## Research & Development Opportunities

### Short-Term Improvements

**Algorithm Refinement:**

- Optimize density estimation parameters
- Test different proximity scoring methods
- Validate spatial filtering effectiveness

**User Experience:**

- A/B testing of different interaction models
- Accessibility improvements for spatial interfaces
- Mobile optimization for touch interactions

### Long-Term Research

**Advanced Spatial Methods:**

- Machine learning-based proximity prediction
- Multi-modal embedding spaces (text + metadata)
- Temporal evolution of spatial relationships

**Scalability Research:**

- Distributed spatial computation
- Incremental updates to spatial relationships
- Cross-conversation spatial pattern learning

## Success Metrics

### Technical Metrics

- **Performance:** <100ms client-side filtering, <50ms API response
- **Accuracy:** >80% user satisfaction with spatial filtering relevance
- **Scalability:** Handle 100k+ comment conversations

### User Experience Metrics

- **Efficiency:** 50% reduction in time to identify relevant topics
- **Comprehensiveness:** 90% of important topics discovered through spatial filtering
- **Usability:** Users successfully navigate layer hierarchy without training

### Business Impact Metrics

- **Adoption:** Spatial filtering used in >70% of prioritization sessions
- **Quality:** Improved agenda-setting outcomes (measurable via follow-up surveys)
- **Scale:** System deployed for national-level pol.is conversations

## Risk Mitigation

### Technical Risks

- **Performance degradation:** Implement fallback to non-spatial mode
- **Data quality issues:** Robust validation of UMAP coordinates
- **Algorithm limitations:** Multiple proximity detection methods

### User Experience Risks

- **Complexity overload:** Progressive disclosure of spatial features
- **Misleading filtering:** Clear indication of filtered vs. total topics
- **Accessibility concerns:** Alternative navigation methods

### Operational Risks

- **Storage costs:** Efficient compression and TTL policies
- **Computational costs:** Precomputation during off-peak hours
- **Data consistency:** Atomic updates to spatial relationships

## Conclusion

The Spatial Topic Prioritization System represents a significant advancement in pol.is's capacity for intelligent agenda setting. By leveraging the semantic structure encoded in UMAP embeddings, STPS enables users to efficiently navigate large topic hierarchies while preserving thematic coherence. The system's phased implementation approach allows for iterative refinement while delivering immediate value through client-side prototyping.

The long-term vision extends beyond simple proximity filtering to encompass adaptive, learning-based spatial relationship detection that improves with usage. This positions pol.is as a leading platform for large-scale democratic discourse, capable of handling national-level conversations while maintaining semantic precision and user agency.

---

**Document Version:** 1.0  
**Created:** 2024-06-23  
**Author:** Claude Code Assistant  
**Status:** System Design - Phase 1 Implementation Active
