# Topic Moderation Components

This directory contains the React components for the Topic-Based Moderation system in pol.is.

## Components

### `index.js` - TopicModeration
Main container component with tabbed navigation between different views:
- Topics Tree view
- Proximity Map visualization  
- Statistics dashboard

### `topic-tree.js` - TopicTree
Hierarchical display of topics organized by layers:
- Layer selection (0, 1, 2, or all)
- Topic cards with moderation controls
- Bulk topic-level actions (Accept/Reject/Meta)
- Navigation to detailed comment view

### `topic-detail.js` - TopicDetail  
Detailed view of comments within a specific topic:
- Individual comment display with selection
- Bulk comment selection and actions
- UMAP coordinate display
- Moderation status tracking

### `proximity-visualization.js` - ProximityVisualization
SVG-based UMAP visualization:
- Interactive scatter plot of comment positions
- Cluster grouping visualization
- Color coding by moderation status
- Layer selection for different granularities

### `topic-stats.js` - TopicStats
Statistics and progress tracking:
- Moderation completion rates
- Status distribution (pending/accepted/rejected/meta)
- Progress bars and visual indicators
- Overview dashboard

## Usage

The components are integrated into the conversation admin interface at:
`/m/:conversation_id/topics`

## Dependencies

- React with hooks
- theme-ui for styling
- React Router for navigation
- SVG manipulation for visualizations

## Data Flow

1. Components fetch data from `/api/v3/topicMod/*` endpoints
2. Real-time polling for updates (60-second intervals)
3. Optimistic UI updates for moderation actions
4. Error handling with retry mechanisms

## Styling

Uses theme-ui variants and custom CSS in `topic-moderation.css` for:
- Hover effects and transitions
- Status-based color coding
- Responsive design
- Loading states and animations