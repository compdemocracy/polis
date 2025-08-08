import React, { useEffect, useRef } from 'react';

/**
 * TopicScatterplot Component
 * 
 * A standalone, reusable scatterplot visualization for topic statistics using Plotly.js
 * 
 * @component
 * @param {Object} props - Component props
 * @param {Array<Object>} props.data - Array of topic data objects
 * @param {string} props.data[].topic_name - Name of the topic (displayed in tooltip)
 * @param {number} props.data[].consensus - Topic consensus value (0-1, displayed on y-axis)
 * @param {number} props.data[].avg_votes_per_comment - Average votes per comment (displayed on x-axis)
 * @param {number} props.data[].comment_count - Number of comments (determines bubble size)
 * @param {string} [props.data[].layer] - Optional layer identifier for grouping
 * @param {Object} [props.data[].additional_info] - Optional additional data for tooltips
 * 
 * @param {Object} [props.config] - Configuration options
 * @param {string} [props.config.title] - Chart title
 * @param {string} [props.config.xAxisLabel] - X-axis label (default: "Average Votes per Comment")
 * @param {string} [props.config.yAxisLabel] - Y-axis label (default: "Topic Consensus")
 * @param {number} [props.config.width] - Chart width (default: responsive)
 * @param {number} [props.config.height] - Chart height (default: 500)
 * @param {number} [props.config.bubbleOpacity] - Bubble opacity (default: 0.6)
 * @param {number} [props.config.minBubbleSize] - Minimum bubble size in pixels (default: 10)
 * @param {number} [props.config.maxBubbleSize] - Maximum bubble size in pixels (default: 60)
 * 
 * @param {Function} [props.onHover] - Callback when hovering over a point
 * @param {Function} [props.onClick] - Callback when clicking on a point
 * 
 * @example
 * const topicData = [
 *   {
 *     topic_name: "Environmental Protection",
 *     consensus: 0.85,
 *     avg_votes_per_comment: 45.2,
 *     comment_count: 23,
 *     layer: "Layer 0"
 *   },
 *   // ... more topics
 * ];
 * 
 * <TopicScatterplot 
 *   data={topicData}
 *   config={{
 *     title: "Topic Analysis",
 *     height: 600,
 *     bubbleOpacity: 0.7
 *   }}
 *   onClick={(point) => console.log('Clicked:', point)}
 * />
 */
const TopicScatterplot = ({ data, config = {}, onHover, onClick }) => {
  const plotRef = useRef(null);
  
  // Default configuration
  const defaultConfig = {
    xAxisLabel: "Average Votes per Comment",
    yAxisLabel: "Topic Consensus",
    height: 500,
    bubbleOpacity: 0.6,
    minBubbleSize: 10,
    maxBubbleSize: 60
  };
  
  const mergedConfig = { ...defaultConfig, ...config };
  
  useEffect(() => {
    if (!window.Plotly) {
      console.error("Plotly.js is not loaded. Please include Plotly.js in your HTML.");
      return;
    }
    
    if (!data || data.length === 0) {
      console.warn("No data provided to TopicScatterplot");
      return;
    }
    
    // Calculate bubble sizes based on comment count
    const commentCounts = data.map(d => d.comment_count || 0);
    const minComments = Math.min(...commentCounts);
    const maxComments = Math.max(...commentCounts);
    
    // Scale function for bubble sizes
    const scaleSize = (count) => {
      if (maxComments === minComments) return mergedConfig.minBubbleSize;
      const normalized = (count - minComments) / (maxComments - minComments);
      return mergedConfig.minBubbleSize + 
        (normalized * (mergedConfig.maxBubbleSize - mergedConfig.minBubbleSize));
    };
    
    // Apply optional transformations for positioning
    const xOriginal = data.map(d => d.avg_votes_per_comment || 0);
    const xValues = data.map(d => {
      const val = d.avg_votes_per_comment || 0;
      if (mergedConfig.xTransform === 'pow2') return Math.pow(val, 2);
      if (mergedConfig.xTransform === 'pow3') return Math.pow(val, 3);
      if (mergedConfig.xTransform === 'sqrt') return Math.sqrt(val);
      if (mergedConfig.xTransform === 'pow1.5') return Math.pow(val, 1.5);
      return val;
    });
    
    const yValues = data.map(d => {
      const val = d.consensus || 0;
      if (mergedConfig.yTransform === 'pow2') return Math.pow(val, 2);
      if (mergedConfig.yTransform === 'pow3') return Math.pow(val, 3);
      if (mergedConfig.yTransform === 'sqrt') return Math.sqrt(val);
      if (mergedConfig.yTransform === 'pow1.5') return Math.pow(val, 1.5);
      return val;
    });
    
    // Calculate custom tick values for transformed axes
    let xTickVals, xTickText;
    let yTickVals, yTickText;
    
    if (mergedConfig.xTransform === 'sqrt') {
      // Dynamically calculate nice tick values based on data range
      const maxX = Math.max(...xOriginal);
      const minX = Math.min(...xOriginal.filter(x => x > 0)) || 0;
      
      // Calculate order of magnitude
      const magnitude = Math.pow(10, Math.floor(Math.log10(maxX)));
      const normalizedMax = maxX / magnitude;
      
      // Determine step size based on range
      let step;
      if (normalizedMax <= 1) step = magnitude * 0.1;
      else if (normalizedMax <= 2) step = magnitude * 0.2;
      else if (normalizedMax <= 5) step = magnitude * 0.5;
      else step = magnitude;
      
      // Generate tick values
      const tickValues = [];
      const tickLabels = [];
      
      for (let val = 0; val <= maxX * 1.1; val += step) {
        if (val === 0 || val >= minX * 0.9) {
          tickValues.push(Math.sqrt(val));
          tickLabels.push(Math.round(val).toString());
        }
      }
      
      // Ensure we have the max value
      if (tickValues[tickValues.length - 1] < Math.sqrt(maxX)) {
        tickValues.push(Math.sqrt(maxX));
        tickLabels.push(Math.round(maxX).toString());
      }
      
      xTickVals = tickValues;
      xTickText = tickLabels;
    }
    
    // Calculate custom tick values for y-axis with pow2 transform
    if (mergedConfig.yTransform === 'pow2') {
      const yOriginal = data.map(d => d.consensus || 0);
      const maxY = Math.max(...yOriginal);
      const minY = Math.min(...yOriginal.filter(y => y > 0)) || 0;
      
      // Generate nice tick values for consensus (0 to 1 range typically)
      const tickValues = [];
      const tickLabels = [];
      
      // For consensus values, use fixed intervals
      const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      
      for (const val of steps) {
        if (val >= minY * 0.9 && val <= maxY * 1.1) {
          tickValues.push(Math.pow(val, 2));
          tickLabels.push(val.toFixed(1));
        }
      }
      
      yTickVals = tickValues;
      yTickText = tickLabels;
    }
    
    // Store original values for custom hover text
    const originalValues = data.map(d => ({
      x: d.avg_votes_per_comment || 0,
      y: d.consensus || 0
    }));
    
    // Prepare Plotly data
    const plotData = [{
      x: xValues,
      y: yValues,
      mode: 'markers',
      type: 'scatter',
      marker: {
        size: data.map(d => scaleSize(d.comment_count || 0)),
        color: mergedConfig.useColorScale ? yValues : data.map(d => {
          if (mergedConfig.colorFunction) {
            return mergedConfig.colorFunction(d);
          }
          return 'rgba(66, 133, 244, 1)'; // Default Google blue
        }),
        colorscale: mergedConfig.colorScale || 'RdYlGn',
        reversescale: mergedConfig.reverseScale || false,
        showscale: mergedConfig.showColorScale || false,
        opacity: mergedConfig.bubbleOpacity,
        line: {
          color: 'rgba(0, 0, 0, 0.2)',
          width: 1
        }
      },
      text: data.map(d => {
        // Build hover text
        let hoverText = `<b>${d.topic_name}</b><br>`;
        hoverText += `Consensus: ${d.consensus.toFixed(3)}<br>`;
        hoverText += `Avg Votes/Comment: ${d.avg_votes_per_comment.toFixed(1)}<br>`;
        hoverText += `Comments: ${d.comment_count}`;
        
        if (d.layer !== undefined) {
          hoverText += `<br>Layer: ${d.layer}`;
        }
        
        // Add any additional info
        if (d.additional_info) {
          Object.entries(d.additional_info).forEach(([key, value]) => {
            hoverText += `<br>${key}: ${value}`;
          });
        }
        
        return hoverText;
      }),
      hovertemplate: '%{text}<extra></extra>',
      customdata: data // Store full data for click events
    }];
    
    // Layout configuration
    const layout = {
      title: mergedConfig.title || '',
      xaxis: {
        title: mergedConfig.xAxisLabel,
        zeroline: false,
        gridcolor: 'rgba(0,0,0,0.1)',
        type: mergedConfig.xAxisType || 'linear',
        tickmode: xTickVals ? 'array' : 'auto',
        tickvals: xTickVals,
        ticktext: xTickText
      },
      yaxis: {
        title: mergedConfig.yAxisLabel,
        zeroline: false,
        gridcolor: 'rgba(0,0,0,0.1)',
        type: mergedConfig.yAxisType || 'linear',
        tickmode: yTickVals ? 'array' : 'auto',
        tickvals: yTickVals,
        ticktext: yTickText,
        tickformat: yTickVals ? undefined : (mergedConfig.yAxisTickFormat || ''),
        exponentformat: mergedConfig.yAxisType === 'pow' ? 'e' : undefined
      },
      hovermode: 'closest',
      showlegend: false,
      height: mergedConfig.height,
      plot_bgcolor: 'rgba(0,0,0,0)',
      paper_bgcolor: 'rgba(0,0,0,0)',
      margin: {
        l: 80,
        r: 40,
        t: mergedConfig.title ? 60 : 40,
        b: 60
      }
    };
    
    // Plotly configuration
    const plotlyConfig = {
      responsive: true,
      displayModeBar: false // Hide the toolbar for cleaner look
    };
    
    // Create the plot
    window.Plotly.newPlot(plotRef.current, plotData, layout, plotlyConfig);
    
    // Add event handlers
    if (onClick) {
      plotRef.current.on('plotly_click', (eventData) => {
        if (eventData.points && eventData.points.length > 0) {
          const point = eventData.points[0];
          onClick(point.customdata);
        }
      });
    }
    
    if (onHover) {
      plotRef.current.on('plotly_hover', (eventData) => {
        if (eventData.points && eventData.points.length > 0) {
          const point = eventData.points[0];
          onHover(point.customdata);
        }
      });
    }
    
    // Cleanup
    return () => {
      if (plotRef.current) {
        window.Plotly.purge(plotRef.current);
      }
    };
  }, [data, mergedConfig, onClick, onHover]);
  
  return (
    <div 
      ref={plotRef} 
      style={{ width: '100%' }}
      data-testid="topic-scatterplot"
    />
  );
};

export default TopicScatterplot;