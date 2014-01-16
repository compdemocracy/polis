define([
], {
  // Return the {x: {min: #, max: #}, y: {min: #, max: #}}
  computeXySpans: function(points) {
    var spans = {
      x: { min: Infinity, max: -Infinity },
      y: { min: Infinity, max: -Infinity }
    };
    for (var i = 0; i < points.length; i++) {
      if (points[i].data && points[i].data.projection) {
        spans.x.min = Math.min(spans.x.min, points[i].data.projection[0]);
        spans.x.max = Math.max(spans.x.max, points[i].data.projection[0]);
        spans.y.min = Math.min(spans.y.min, points[i].data.projection[1]);
        spans.y.max = Math.max(spans.y.max, points[i].data.projection[1]);
      }
    }
    return spans;
  }
});
