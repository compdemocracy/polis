# Smart Comment Filtering for Multi-Layer Batch Reports

## 🚨 CRITICAL ARCHITECTURAL ISSUE

**The two report interfaces use DIFFERENT API endpoints and data sources:**

- **TopicReport.jsx**: Uses `/api/v3/delphi` → Gets LLM topic names directly from DynamoDB tables
- **CommentsReport.jsx**: Uses `/api/v3/delphi/reports` → Gets narrative reports from NarrativeReports table

**Impact**: 
- TopicReport dropdown always appears if LLM topics exist
- CommentsReport dropdown only appears if narrative reports have been generated
- Users see inconsistent behavior between the two interfaces
- Data can be out of sync between the two views

**This needs to be addressed for consistent UX.**

## Executive Summary

This document outlines the implementation plan for adding intelligent comment filtering to the Polis batch report system. The goal is to stay within API token limits while maximizing report quality by selecting the most statistically significant comments based on established Polis metrics.

## Background

### Current State
- ✅ Python batch system processes all layers (not just layer 0)  
- ✅ Multi-layer topic reports working via Anthropic Batch API
- ❌ No comment filtering → risk of exceeding API limits on large conversations
- ❌ Missing global sections (groups, group_informed_consensus, uncertainty)

### Target State
- 🎯 Intelligent comment selection using Polis statistical metrics
- 🎯 Global sections integrated into batch system
- 🎯 Dynamic limits based on conversation size and layer granularity
- 🎯 Coarse-grained layers get highest quality subset of comments
- 🎯 UI separation between global sections and topic picker

## Technical Architecture

### 1. Comment Filtering Metrics

#### A. Comment Extremity (`comment_extremity`)
**Purpose**: Identifies comments that strongly divide opinion groups
**Calculation**: 
```python
# Maximum difference in voting percentages between any two groups
for group_i, group_j in all_group_pairs:
    agree_diff = abs(group_i_agree_pct - group_j_agree_pct)
    disagree_diff = abs(group_i_disagree_pct - group_j_disagree_pct) 
    pass_diff = abs(group_i_pass_pct - group_j_pass_pct)
    max_diff = max(agree_diff, disagree_diff, pass_diff)

comment_extremity = average(max_diff_across_all_pairs)
```
**Range**: 0.0 to 1.0+ (higher = more divisive)
**Filter Threshold**: `> 1.0` for groups section

#### B. Group Aware Consensus (`group_aware_consensus`) 
**Purpose**: Identifies comments with broad agreement across all groups
**Calculation**:
```python
# Laplace-smoothed probability multiplication
consensus = 1.0
for group in all_groups:
    prob = (group_agree_count + 1.0) / (group_total_votes + 2.0)
    consensus *= prob
```
**Range**: 0.0 to 1.0 (higher = more consensus)
**Filter Thresholds** (by group count):
- 2 groups: `> 0.7`
- 3 groups: `> 0.47`  
- 4 groups: `> 0.32`
- 5+ groups: `> 0.24`

#### C. Uncertainty Ratio
**Purpose**: Identifies comments where many participants were unsure
**Calculation**: `passes / total_votes >= 0.2`

### 2. Global Sections Implementation

#### Section Definitions
```python
GLOBAL_SECTIONS = [
    {
        "name": "groups",
        "template": "subtaskPrompts/groups.xml",
        "filter": lambda c: c.get("comment_extremity", 0) > 1.0,
        "description": "Comments that divide opinion groups"
    },
    {
        "name": "group_informed_consensus", 
        "template": "subtaskPrompts/group_informed_consensus.xml",
        "filter": lambda c: c.get("group_aware_consensus", 0) > get_gac_threshold(c.get("num_groups", 2)),
        "description": "Comments with broad cross-group agreement"
    },
    {
        "name": "uncertainty",
        "template": "subtaskPrompts/uncertainty.xml", 
        "filter": lambda c: c.get("passes", 0) / max(c.get("votes", 1), 1) >= 0.2,
        "description": "Comments with high uncertainty/unsure responses"
    }
]
```

### 3. Dynamic Comment Limits Strategy

#### Token Limit Management
- **API Limit**: Stay well under Anthropic's limits (~200K tokens)
- **Safety Margin**: Target ~30K tokens per request
- **Dynamic Scaling**: Fewer comments for coarse layers with more total comments

#### Layer-Based Limits
```python
def get_comment_limit(layer_id, total_layers, comment_count):
    """Calculate dynamic comment limit based on layer granularity"""
    
    base_limits = {
        "global_sections": 50,  # Fixed limit for global sections
        "fine_layers": 100,     # More comments for specific topics  
        "medium_layers": 75,    # Balanced approach
        "coarse_layers": 50     # Fewer, highest quality comments
    }
    
    # Classify layer
    if layer_id == 0:
        category = "fine_layers"
    elif layer_id == total_layers - 1:
        category = "coarse_layers"  
    else:
        category = "medium_layers"
        
    # Scale down for very large conversations
    limit = base_limits[category]
    if comment_count > 10000:
        limit = int(limit * 0.5)  # Halve limits for huge conversations
    elif comment_count > 5000:
        limit = int(limit * 0.75) # Reduce by 25% for large conversations
        
    return limit
```

### 4. Implementation Phases

#### Phase 1: Core Infrastructure ✨
1. **Metric Calculation Module**
   - Extract group voting data from DynamoDB
   - Calculate extremity and consensus metrics
   - Store results for filtering

2. **Filtering Engine** 
   - Implement filter functions matching Node.js logic
   - Sort comments by metric relevance
   - Apply dynamic limits

#### Phase 2: Global Sections Integration ⚡
1. **Batch System Updates**
   - Add global sections to `get_topics()` method
   - Create separate processing path for global vs topic sections
   - Update section naming and template handling

2. **Template Integration**
   - Port Node.js templates to Python system
   - Ensure XML structure compatibility
   - Test prompt generation

#### Phase 3: UI Enhancement 🎨
1. **Report Component Updates**
   - Separate global sections from topic dropdown
   - Add dedicated global sections UI area
   - Update routing and display logic

2. **User Experience**
   - Clear labeling of global vs topic-specific insights
   - Intuitive navigation between section types
   - Performance optimization for large conversations

#### Phase 4: Testing & Optimization 🔬
1. **Large Conversation Testing**
   - Test with 1K, 5K, 10K+ comment conversations
   - Validate filtering effectiveness
   - Measure processing time and token usage

2. **Quality Assurance**
   - Compare filtered vs unfiltered report quality
   - Ensure statistical significance of selected comments
   - A/B test different filtering thresholds

### 5. Key Benefits

#### For Users
- **Faster Processing**: Stay within API limits for large conversations
- **Better Insights**: Focus on statistically significant comments
- **Complete Picture**: Get both global overview and topic-specific details
- **Scalability**: System works for conversations of any size

#### For System
- **Cost Efficiency**: Reduce API costs via intelligent filtering
- **Reliability**: Avoid timeouts and failures on large datasets
- **Maintainability**: Centralized filtering logic with clear metrics
- **Extensibility**: Easy to add new filtering criteria

### 6. Success Metrics

#### Technical Metrics
- **Token Usage**: <30K tokens per batch request
- **Processing Time**: <5 minutes for 10K comment conversations  
- **Success Rate**: >95% batch completion rate
- **Coverage**: Capture top 10% most significant comments

#### Quality Metrics
- **Statistical Relevance**: Selected comments represent key patterns
- **User Satisfaction**: Reports provide actionable insights
- **Completeness**: Both consensus and divisive viewpoints captured
- **Scalability**: Performance maintained across conversation sizes

## Implementation Timeline

### Week 1: Infrastructure
- [ ] Implement metric calculation module
- [ ] Create filtering engine with dynamic limits
- [ ] Unit tests for filtering logic

### Week 2: Global Sections  
- [ ] Add global sections to batch system
- [ ] Port and test XML templates
- [ ] Integration testing

### Week 3: UI Enhancement
- [ ] Update report components for section separation
- [ ] Implement global sections display
- [ ] User experience testing

### Week 4: Testing & Launch
- [ ] Large conversation testing
- [ ] Performance optimization
- [ ] Production deployment

## Risk Mitigation

### Technical Risks
- **Metric Accuracy**: Extensive testing against Node.js implementation
- **Performance**: Optimize database queries and calculations
- **Token Estimation**: Conservative limits with monitoring

### User Experience Risks  
- **Information Loss**: Careful selection maintains representativeness
- **Confusion**: Clear UI separation and labeling
- **Regression**: Comprehensive testing of existing functionality

## Conclusion

This implementation provides a robust foundation for scaling Polis narrative reports to conversations of any size while maintaining the statistical rigor and insight quality that makes Polis valuable. The combination of intelligent filtering and global sections will deliver the most comprehensive and actionable reports possible within API constraints.

The fractal nature of applying filtering at multiple layers ensures that users get the right level of detail for their needs - from broad thematic overviews to specific topical insights - all powered by mathematically rigorous selection criteria.