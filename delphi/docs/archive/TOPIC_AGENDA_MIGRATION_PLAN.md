# Topic Agenda Migration Plan: React to Astro Architecture

## Executive Summary

This document outlines the strategy for migrating the topic/narrative visualization system from the React-based client-report to the new Astro-based participation interface, designed to handle conversations at scale (1M participants × 10M comments).

## Current State Analysis

### React Client-Report Architecture
- **Technology**: React SPA with client-side rendering
- **Data Loading**: All comments loaded at once (max 999)
- **Topic System**: TopicMapNarrativeReport combines visualizations and narratives
- **API Pattern**: Multiple REST endpoints, no pagination
- **Performance**: Works for thousands of comments, breaks at scale

### Astro Client-Participation Architecture
- **Technology**: Astro with SSR and selective hydration
- **Data Loading**: Minimal initial data for voting flow
- **Topic System**: Currently none
- **API Pattern**: Single participationInit endpoint
- **Performance**: Optimized for fast initial loads

## Pre-Computation Strategy for 1M × 10M Scale

### What to Pre-compute in Delphi

#### 1. Topic Hierarchies and Metadata
```python
# Pre-computed and stored in DynamoDB
{
  "conversation_id": "7rx4dsesj2",
  "topic_hierarchy": {
    "global_topics": ["consensus", "divisive", "uncertain"],
    "layer_0": {"count": 5, "topics": [...]},
    "layer_1": {"count": 15, "topics": [...]},
    "layer_2": {"count": 45, "topics": [...]}
  },
  "metadata": {
    "total_comments": 10000000,
    "total_participants": 1000000,
    "last_updated": "2025-01-16T10:00:00Z"
  }
}
```

#### 2. Citation Indices
```python
# Pre-computed citation mappings
{
  "topic_key": "layer_1_cluster_3",
  "citations": {
    "comment_ids": [234, 567, 891, ...],  # Top 100 most relevant
    "total_cited": 1523,
    "relevance_scores": {...}
  }
}
```

#### 3. Aggregated Statistics
```python
# Pre-computed per topic
{
  "topic_key": "layer_1_cluster_3",
  "stats": {
    "participant_count": 125000,
    "vote_distribution": {
      "agree": 450000,
      "disagree": 230000,
      "pass": 120000
    },
    "engagement_score": 0.82
  }
}
```

#### 4. Narrative Summaries
```python
# Pre-generated, versioned narratives
{
  "topic_key": "layer_1_cluster_3",
  "narrative_versions": [{
    "version": "v1",
    "generated_at": "2025-01-16T09:00:00Z",
    "summary": "Brief 2-3 sentence summary...",
    "full_narrative": "Detailed narrative with citations..."
  }]
}
```

#### 5. Visualization Artifacts
- Static PNG/SVG previews at multiple resolutions
- Simplified data for interactive visualizations (max 10K points)
- Pre-computed UMAP projections with LOD (levels of detail)

### What to Compute on Client

#### 1. User-Specific Filtering
- Personal vote history overlay
- Friend group comparisons
- Custom time range filtering

#### 2. Interactive Exploration
- Zoom/pan on visualizations
- Real-time search within cached data
- Dynamic grouping/sorting

#### 3. Progressive Loading
- Initial view with summary data
- Detailed data loaded on demand
- Infinite scroll for comment lists

## Migration Architecture

### Phase 1: Data Infrastructure (Weeks 1-4)

#### 1.1 Delphi Pipeline Extensions
```python
# New pre-computation jobs
class TopicAgendaPrecompute:
    def __init__(self, zid):
        self.zid = zid
        
    def compute_topic_summaries(self):
        # Generate lightweight topic summaries
        
    def build_citation_index(self):
        # Create efficient citation lookups
        
    def generate_visualization_lods(self):
        # Multiple levels of detail for viz
```

#### 1.2 DynamoDB Schema Updates
```sql
-- New tables for pre-computed data
Delphi_TopicAgenda
  - conversation_id (PK)
  - topic_key (SK)
  - summary_data
  - citation_index
  - stats
  
Delphi_TopicAgendaCache
  - cache_key (PK)
  - ttl
  - compressed_data
```

#### 1.3 API Gateway Layer
```typescript
// New GraphQL schema for efficient queries
type TopicAgenda {
  id: ID!
  conversation: Conversation!
  topics(layer: Int, limit: Int): [Topic!]!
  globalAnalysis: GlobalAnalysis!
}

type Topic {
  key: String!
  name: String!
  summary: String!
  stats: TopicStats!
  citations(limit: Int, offset: Int): CitationPage!
  narrative(version: String): Narrative
}
```

### Phase 2: Astro Component Development (Weeks 5-8)

#### 2.1 Component Architecture
```astro
---
// src/pages/agenda/[conversation_id].astro
import TopicAgendaLayout from '@layouts/TopicAgendaLayout.astro';
import TopicSelector from '@components/TopicSelector';
import TopicVisualization from '@components/TopicVisualization';
import TopicNarrative from '@components/TopicNarrative';

const { conversation_id } = Astro.params;

// Server-side data fetch
const agendaData = await fetchTopicAgenda(conversation_id);
---

<TopicAgendaLayout>
  <TopicSelector 
    client:load 
    topics={agendaData.topics} 
    conversationId={conversation_id}
  />
  
  <TopicVisualization 
    client:visible 
    initialData={agendaData.vizPreview}
    conversationId={conversation_id}
  />
  
  <TopicNarrative 
    client:idle 
    topicKey={agendaData.defaultTopic}
    conversationId={conversation_id}
  />
</TopicAgendaLayout>
```

#### 2.2 Progressive Enhancement Strategy
```typescript
// React component with progressive loading
export function TopicNarrative({ topicKey, conversationId }) {
  const [narrative, setNarrative] = useState(null);
  const [citations, setCitations] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  
  // Initial load of narrative summary
  useEffect(() => {
    loadNarrativeSummary(topicKey);
  }, [topicKey]);
  
  // Lazy load full narrative on interaction
  const loadFullNarrative = async () => {
    const data = await fetchFullNarrative(topicKey);
    setNarrative(data);
  };
  
  // Virtual scrolling for citations
  const citationObserver = useInfiniteScroll(() => {
    loadMoreCitations();
  });
}
```

### Phase 3: Performance Optimizations (Weeks 9-12)

#### 3.1 Caching Strategy
```typescript
// Multi-level caching
class TopicAgendaCache {
  // Browser cache (IndexedDB)
  async getFromLocal(key: string) {
    return await idb.get('topic-agenda', key);
  }
  
  // CDN cache (CloudFront)
  async getFromCDN(key: string) {
    return await fetch(`${CDN_URL}/agenda/${key}`, {
      headers: { 'Cache-Control': 'max-age=3600' }
    });
  }
  
  // Redis cache (server-side)
  async getFromRedis(key: string) {
    return await redis.get(`agenda:${key}`);
  }
}
```

#### 3.2 Data Compression
```typescript
// Efficient data formats
interface CompressedComment {
  i: number;        // id (shortened key)
  t: string;        // text (compressed)
  v: [number, number, number]; // votes [agree, disagree, pass]
  p: number;        // participant_id
  c: number;        // created_at (timestamp)
}

// Compression utilities
const compressComments = (comments: Comment[]): CompressedComment[] => {
  return comments.map(c => ({
    i: c.tid,
    t: lz.compress(c.text),
    v: [c.agrees, c.disagrees, c.passes],
    p: c.pid,
    c: c.created_at
  }));
};
```

#### 3.3 WebAssembly Modules
```rust
// High-performance client-side processing
#[wasm_bindgen]
pub fn filter_citations(
    comments: &[u8], 
    citation_ids: &[u32]
) -> Vec<u8> {
    // Efficient binary search and filtering
}

#[wasm_bindgen]
pub fn compute_local_stats(
    votes: &[u8],
    participant_filter: Option<&[u32]>
) -> Statistics {
    // Fast client-side statistics
}
```

### Phase 4: API Evolution (Weeks 13-16)

#### 4.1 GraphQL Implementation
```graphql
# Efficient querying for large datasets
query GetTopicAgenda($conversationId: ID!, $layer: Int) {
  topicAgenda(conversationId: $conversationId) {
    topics(layer: $layer, first: 20) {
      edges {
        node {
          key
          name
          summary
          stats {
            participantCount
            voteCount
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

#### 4.2 Subscription Support
```graphql
# Real-time updates for active conversations
subscription TopicUpdates($conversationId: ID!) {
  topicAgenda(conversationId: $conversationId) {
    topicUpdated {
      key
      stats {
        voteCount
        participantCount
      }
    }
  }
}
```

## Implementation Timeline

### Milestone 1: Infrastructure (Month 1)
- [ ] Delphi pre-computation pipeline
- [ ] DynamoDB schema updates
- [ ] API gateway setup
- [ ] Caching layer implementation

### Milestone 2: Core Features (Month 2)
- [ ] Astro page templates
- [ ] React components for interactivity
- [ ] Progressive loading implementation
- [ ] Basic visualization integration

### Milestone 3: Scale Testing (Month 3)
- [ ] Load testing with 1M participants
- [ ] Performance optimization
- [ ] WebAssembly module integration
- [ ] CDN configuration

### Milestone 4: Polish & Launch (Month 4)
- [ ] UI/UX refinements
- [ ] A/B testing framework
- [ ] Monitoring and analytics
- [ ] Gradual rollout plan

## Performance Targets

### Initial Load
- Time to First Byte: < 200ms
- Time to Interactive: < 1.5s
- Initial Bundle Size: < 150KB

### Runtime Performance
- Topic Switch: < 100ms
- Citation Load: < 50ms per batch
- Visualization Pan/Zoom: 60 FPS

### Scale Targets
- Support 1M concurrent users
- Handle 10M comments per conversation
- Sub-second response for all queries

## Risk Mitigation

### Technical Risks
1. **DynamoDB throttling**: Implement exponential backoff and request sharding
2. **Memory constraints**: Use virtual scrolling and data windowing
3. **Network latency**: Edge caching and regional deployments

### Migration Risks
1. **Feature parity**: Gradual feature rollout with fallback to React
2. **Data consistency**: Dual-write period with validation
3. **User adoption**: A/B testing and gradual rollout

## Success Metrics

### Performance KPIs
- 90th percentile load time < 2s
- API response time < 100ms
- Client memory usage < 500MB

### User Experience KPIs
- Task completion rate > 90%
- User engagement increase > 20%
- Support ticket reduction > 30%

## Conclusion

This migration plan provides a roadmap for transforming the topic/narrative system from a traditional React SPA to a modern, scalable Astro-based architecture. By leveraging server-side rendering, progressive enhancement, and strategic pre-computation, we can deliver a superior user experience even at massive scale.

The phased approach allows for iterative development and testing, ensuring each component is optimized before moving to the next phase. With careful attention to performance metrics and user experience, this migration will position Polis to handle the next generation of large-scale conversations.