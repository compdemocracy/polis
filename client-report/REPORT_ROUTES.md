# Polis Client Report Routes Directory

This document provides a comprehensive overview of all available report routes in the Polis client-report application. All routes follow the pattern `/{routeType}/{report_id}`.

## Available Routes

### 1. `/report/{report_id}`
**Component:** Standard Report (default)  
**Description:** The main comprehensive report view showing overview, groups, consensus statements, and participant statistics.  
**Features:**
- Participant and vote statistics
- Opinion group analysis
- Consensus and divisive statements
- Metadata and demographics

### 2. `/narrativeReport/{report_id}`
**Component:** NarrativeOverview  
**Description:** A narrative-style report presenting the conversation analysis in a more readable, story-like format.  
**Features:**
- Narrative summaries of group perspectives
- Key themes and insights
- Contextual analysis of the conversation

### 3. `/commentsReport/{report_id}`
**Component:** CommentsReport  
**Description:** Detailed view of all comments in the conversation with voting patterns and analysis.  
**Features:**
- Full list of all comments
- Vote breakdowns (agree/disagree/pass)
- Comment filtering and sorting
- Consensus metrics for each comment

### 4. `/topicReport/{report_id}`
**Component:** TopicReport  
**Description:** Topic-based analysis showing AI-generated narrative summaries for different topics.  
**Features:**
- Dropdown selector for different topics
- Side-by-side narrative and cited comments
- Cross-group consensus analysis
- Topic-specific insights

### 5. `/topicsVizReport/{report_id}`
**Component:** TopicsVizReport  
**Description:** Visual representation of topics and their relationships.  
**Features:**
- Interactive topic visualization
- Topic clustering and relationships
- Visual exploration of conversation themes

### 6. `/exportReport/{report_id}`
**Component:** ExportReport  
**Description:** Data export interface for downloading conversation data.  
**Features:**
- Export conversation data in various formats
- Download raw data for further analysis
- Customizable export options

### 7. `/topicPrioritize/{report_id}`
**Component:** TopicPrioritize  
**Description:** Interface for prioritizing topics based on various metrics.  
**Features:**
- Topic ranking and prioritization
- Multi-criteria topic evaluation
- Decision support for topic selection

### 8. `/topicPrioritizeSimple/{report_id}`
**Component:** TopicPrioritizeSimple  
**Description:** Simplified version of topic prioritization interface.  
**Features:**
- Streamlined topic prioritization
- Basic ranking functionality
- User-friendly interface for quick decisions

### 9. `/topicAgenda/{report_id}`
**Component:** TopicAgenda  
**Description:** Agenda-building tool based on conversation topics.  
**Features:**
- Create meeting agendas from topics
- Organize discussion points
- Export agenda items

### 10. `/topicHierarchy/{report_id}`
**Component:** TopicHierarchy  
**Description:** Hierarchical view of topics showing parent-child relationships.  
**Features:**
- Tree-like topic structure
- Topic dependencies and relationships
- Drill-down navigation through topic levels

### 11. `/topicStats/{report_id}`
**Component:** TopicStats  
**Description:** Statistical analysis of topics with detailed metrics and visualizations.  
**Features:**
- Topic statistics dashboard
- Comment count and vote density per topic
- Group-aware consensus metrics
- Interactive visualizations (scatterplot, beeswarm)
- Navigate to individual topic pages
- Collective statement generation
- Layer distribution analysis

### 12. `/topicMapNarrativeReport/{report_id}`
**Component:** TopicMapNarrativeReport  
**Description:** Combined view showing topic mapping with narrative reports.  
**Features:**
- Overview statistics
- Topic visualization integration
- Narrative topic reports
- Raw data export

## Usage Examples

```
http://localhost:5010/report/2arcefpshi
http://localhost:5010/commentsReport/2arcefpshi
http://localhost:5010/topicStats/2arcefpshi
http://localhost:5010/narrativeReport/2arcefpshi
```

## Route Detection

The application uses pathname-based routing:
1. Extracts the route type from the URL path
2. Extracts the report_id from the URL path
3. Renders the appropriate component based on the route type

## Adding New Routes

To add a new report route:
1. Create your component in the appropriate directory
2. Import it in `app.jsx`
3. Add a new conditional block in the render logic:
```javascript
if (route_type === "yourNewRoute") {
  console.log("RENDERING: YourNewComponent");
  return (
    <YourNewComponent
      report_id={report_id}
      // ... other props
    />
  );
}
```

## Notes

- All routes require a valid `report_id` parameter
- Routes are case-sensitive
- The default route (`/report/{report_id}`) shows the standard comprehensive report
- Some routes may require additional data to be loaded (e.g., math object, comments)
- Routes handle their own data fetching and error states