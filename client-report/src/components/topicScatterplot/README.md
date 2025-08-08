# TopicScatterplot Component

A standalone, reusable scatterplot visualization component for displaying topic statistics using Plotly.js.

## Features

- **Interactive scatter plot** with hover tooltips showing detailed information
- **Bubble sizing** based on comment count
- **Transparent bubbles** to see overlapping data points
- **Responsive design** that adapts to container width
- **Customizable** appearance and behavior
- **Event handlers** for click and hover interactions

## Prerequisites

This component requires Plotly.js to be loaded in your application. Add this script tag to your HTML:

```html
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
```

## Installation

Copy the `TopicScatterplot.jsx` file to your project's components directory.

## Usage

### Basic Example

```jsx
import TopicScatterplot from './components/topicScatterplot/TopicScatterplot';

const topicData = [
  {
    topic_name: "Environmental Protection",
    consensus: 0.85,
    avg_votes_per_comment: 45.2,
    comment_count: 23
  },
  {
    topic_name: "Economic Growth",
    consensus: 0.42,
    avg_votes_per_comment: 38.7,
    comment_count: 45
  }
  // ... more topics
];

function MyComponent() {
  return (
    <TopicScatterplot data={topicData} />
  );
}
```

### Advanced Example with Configuration

```jsx
<TopicScatterplot 
  data={topicData}
  config={{
    title: "Topic Consensus vs Engagement",
    xAxisLabel: "Average Votes per Comment (Engagement)",
    yAxisLabel: "Topic Consensus",
    height: 600,
    bubbleOpacity: 0.7,
    minBubbleSize: 15,
    maxBubbleSize: 70
  }}
  onClick={(topic) => {
    console.log('Selected topic:', topic);
    // Navigate to topic details, open modal, etc.
  }}
  onHover={(topic) => {
    console.log('Hovering over:', topic.topic_name);
  }}
/>
```

## Props

### `data` (required)
Array of topic objects. Each object must contain:

| Property | Type | Description |
|----------|------|-------------|
| `topic_name` | string | Name of the topic (shown in tooltip) |
| `consensus` | number | Topic consensus value (0-1, shown on y-axis) |
| `avg_votes_per_comment` | number | Average votes per comment (shown on x-axis) |
| `comment_count` | number | Number of comments (determines bubble size) |
| `layer` | string/number | Optional layer identifier |
| `additional_info` | object | Optional extra data for tooltips |

### `config` (optional)
Configuration object with the following options:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `title` | string | - | Chart title |
| `xAxisLabel` | string | "Average Votes per Comment" | X-axis label |
| `yAxisLabel` | string | "Topic Consensus" | Y-axis label |
| `width` | number | responsive | Chart width |
| `height` | number | 500 | Chart height in pixels |
| `bubbleOpacity` | number | 0.6 | Opacity of bubbles (0-1) |
| `minBubbleSize` | number | 10 | Minimum bubble size in pixels |
| `maxBubbleSize` | number | 60 | Maximum bubble size in pixels |

### `onClick` (optional)
Callback function triggered when a bubble is clicked. Receives the full data object for the clicked topic.

### `onHover` (optional)
Callback function triggered when hovering over a bubble. Receives the full data object for the hovered topic.

## Data Format Details

### Consensus Value
- Should be between 0 and 1
- Will be displayed as a percentage on the y-axis
- 1 = 100% consensus (everyone agrees)
- 0 = 0% consensus (highly divisive)

### Average Votes per Comment
- Represents engagement level
- Higher values indicate more participant interaction

### Comment Count
- Used to scale bubble sizes
- Larger topics (more comments) will have bigger bubbles

## Styling

The component uses:
- Google blue color (#4285F4) for bubbles
- Transparent bubbles (60% opacity by default)
- Clean, minimal design with subtle gridlines
- No toolbar for cleaner appearance

## Integration Notes

1. **Container**: The component will fill 100% of its parent container's width
2. **Responsiveness**: The chart automatically resizes when the window changes
3. **Performance**: Suitable for up to ~200 topics without performance issues
4. **Accessibility**: Includes proper hover text for screen readers

## Example Data Preparation

```javascript
// Transform your topic stats data for the scatterplot
const scatterplotData = Object.entries(topicsData).flatMap(([layerId, topics]) => 
  Object.entries(topics).map(([clusterId, topic]) => ({
    topic_name: topic.topic_name,
    consensus: 1 - (statsData[topic.topic_key]?.divisiveness || 0),
    avg_votes_per_comment: statsData[topic.topic_key]?.vote_density || 0,
    comment_count: statsData[topic.topic_key]?.comment_count || 0,
    layer: layerId,
    additional_info: {
      cluster_id: clusterId,
      total_votes: statsData[topic.topic_key]?.total_votes || 0
    }
  }))
);
```

## Troubleshooting

### Chart not appearing
- Ensure Plotly.js is loaded before the component renders
- Check browser console for errors
- Verify data array is not empty

### Tooltips not showing
- Make sure your data objects have all required properties
- Check that consensus values are between 0 and 1

### Performance issues
- Consider reducing data points if you have more than 200 topics
- Disable animations if needed