d3.functor = function functor(v) {
  return typeof v === "function" ? v : function() {
    return v;
  };
};

(function() {

// Inspired by http://informationandvisualization.de/blog/box-plot
d3.box = function() {
  var width = 1,
      height = 1,
      duration = 0,
      domain = null,
      value = Number,
      whiskers = boxWhiskers,
      quartiles = boxQuartiles,
	  showLabels = true, // whether or not to show text labels
	  numBars = 4,
	  curBar = 1,
      tickFormat = null;

  // For each small multiple…
  function box(g) {
    g.each(function(data, i) {
      //d = d.map(value).sort(d3.ascending);
	  //var boxIndex = data[0];
	  //var boxIndex = 1;
	  var d = data[1].sort(d3.ascending);

	 // console.log(boxIndex);
	  //console.log(d);

      var g = d3.select(this),
          n = d.length,
          min = d[0],
          max = d[n - 1];

      // Compute quartiles. Must return exactly 3 elements.
      var quartileData = d.quartiles = quartiles(d);

      // Compute whiskers. Must return exactly 2 elements, or null.
      var whiskerIndices = whiskers && whiskers.call(this, d, i),
          whiskerData = whiskerIndices && whiskerIndices.map(function(i) { return d[i]; });

      // Compute outliers. If no whiskers are specified, all data are "outliers".
      // We compute the outliers as indices, so that we can join across transitions!
      var outlierIndices = whiskerIndices
          ? d3.range(0, whiskerIndices[0]).concat(d3.range(whiskerIndices[1] + 1, n))
          : d3.range(n);

      // Compute the new x-scale.
      var x1 = d3.scaleLinear()
          .domain(domain && domain.call(this, d, i) || [min, max])
          .range([height, 0]);

      // Retrieve the old x-scale, if this is an update.
      var x0 = this.__chart__ || d3.scaleLinear()
          .domain([0, Infinity])
		 // .domain([0, max])
          .range(x1.range());

      // Stash the new scale.
      this.__chart__ = x1;

      // Note: the box, median, and box tick elements are fixed in number,
      // so we only have to handle enter and update. In contrast, the outliers
      // and other elements are variable, so we need to exit them! Variable
      // elements also fade in and out.

      // Update center line: the vertical line spanning the whiskers.
      var center = g.selectAll("line.center")
          .data(whiskerData ? [whiskerData] : []);

	 //vertical line
      center.enter().insert("line", "rect")
          .attr("class", "center")
          .attr("x1", width / 2)
          .attr("y1", function(d) { return x0(d[0]); })
          .attr("x2", width / 2)
          .attr("y2", function(d) { return x0(d[1]); })
          .style("opacity", 1e-6)
        .transition()
          .duration(duration)
          .style("opacity", 1)
          .attr("y1", function(d) { return x1(d[0]); })
          .attr("y2", function(d) { return x1(d[1]); });

      center.transition()
          .duration(duration)
          .style("opacity", 1)
          .attr("y1", function(d) { return x1(d[0]); })
          .attr("y2", function(d) { return x1(d[1]); });

      center.exit().transition()
          .duration(duration)
          .style("opacity", 1e-6)
          .attr("y1", function(d) { return x1(d[0]); })
          .attr("y2", function(d) { return x1(d[1]); })
          .remove();

      // Update innerquartile box.
      var box = g.selectAll("rect.box")
          .data([quartileData]);

      box.enter().append("rect")
          .attr("class", "box")
          .attr("x", 0)
          .attr("y", function(d) { return x0(d[2]); })
          .attr("width", width)
          .attr("height", function(d) { return x0(d[0]) - x0(d[2]); })
        .transition()
          .duration(duration)
          .attr("y", function(d) { return x1(d[2]); })
          .attr("height", function(d) { return x1(d[0]) - x1(d[2]); });

      box.transition()
          .duration(duration)
          .attr("y", function(d) { return x1(d[2]); })
          .attr("height", function(d) { return x1(d[0]) - x1(d[2]); });

      // Update median line.
      var medianLine = g.selectAll("line.median")
          .data([quartileData[1]]);

      medianLine.enter().append("line")
          .attr("class", "median")
          .attr("x1", 0)
          .attr("y1", x0)
          .attr("x2", width)
          .attr("y2", x0)
        .transition()
          .duration(duration)
          .attr("y1", x1)
          .attr("y2", x1);

      medianLine.transition()
          .duration(duration)
          .attr("y1", x1)
          .attr("y2", x1);

      // Update whiskers.
      var whisker = g.selectAll("line.whisker")
          .data(whiskerData || []);

      whisker.enter().insert("line", "circle, text")
          .attr("class", "whisker")
          .attr("x1", 0)
          .attr("y1", x0)
          .attr("x2", 0 + width)
          .attr("y2", x0)
          .style("opacity", 1e-6)
        .transition()
          .duration(duration)
          .attr("y1", x1)
          .attr("y2", x1)
          .style("opacity", 1);

      whisker.transition()
          .duration(duration)
          .attr("y1", x1)
          .attr("y2", x1)
          .style("opacity", 1);

      whisker.exit().transition()
          .duration(duration)
          .attr("y1", x1)
          .attr("y2", x1)
          .style("opacity", 1e-6)
          .remove();

      // Update outliers.
      var outlier = g.selectAll("circle.outlier")
          .data(outlierIndices, Number);

      outlier.enter().insert("circle", "text")
          .attr("class", "outlier")
          .attr("r", 5)
          .attr("cx", width / 2)
          .attr("cy", function(i) { return x0(d[i]); })
          .style("opacity", 1e-6)
        .transition()
          .duration(duration)
          .attr("cy", function(i) { return x1(d[i]); })
          .style("opacity", 1);

      outlier.transition()
          .duration(duration)
          .attr("cy", function(i) { return x1(d[i]); })
          .style("opacity", 1);

      outlier.exit().transition()
          .duration(duration)
          .attr("cy", function(i) { return x1(d[i]); })
          .style("opacity", 1e-6)
          .remove();

      // Compute the tick format.
      var format = tickFormat || x1.tickFormat(8);

      // Update box ticks.
      var boxTick = g.selectAll("text.box")
          .data(quartileData);
	 if(showLabels == true) {
      boxTick.enter().append("text")
          .attr("class", "box")
          .attr("dy", ".3em")
          .attr("dx", function(d, i) { return i & 1 ? 6 : -6 })
          .attr("x", function(d, i) { return i & 1 ?  + width : 0 })
          .attr("y", x0)
          .attr("text-anchor", function(d, i) { return i & 1 ? "start" : "end"; })
          .text(format)
        .transition()
          .duration(duration)
          .attr("y", x1);
	}

      boxTick.transition()
          .duration(duration)
          .text(format)
          .attr("y", x1);

      // Update whisker ticks. These are handled separately from the box
      // ticks because they may or may not exist, and we want don't want
      // to join box ticks pre-transition with whisker ticks post-.
      var whiskerTick = g.selectAll("text.whisker")
          .data(whiskerData || []);
	if(showLabels == true) {
      whiskerTick.enter().append("text")
          .attr("class", "whisker")
          .attr("dy", ".3em")
          .attr("dx", 6)
          .attr("x", width)
          .attr("y", x0)
          .text(format)
          .style("opacity", 1e-6)
        .transition()
          .duration(duration)
          .attr("y", x1)
          .style("opacity", 1);
	 }
      whiskerTick.transition()
          .duration(duration)
          .text(format)
          .attr("y", x1)
          .style("opacity", 1);

      whiskerTick.exit().transition()
          .duration(duration)
          .attr("y", x1)
          .style("opacity", 1e-6)
          .remove();
    });
    // d3.timer.flush();
  }

  box.width = function(x) {
    if (!arguments.length) return width;
    width = x;
    return box;
  };

  box.height = function(x) {
    if (!arguments.length) return height;
    height = x;
    return box;
  };

  box.tickFormat = function(x) {
    if (!arguments.length) return tickFormat;
    tickFormat = x;
    return box;
  };

  box.duration = function(x) {
    if (!arguments.length) return duration;
    duration = x;
    return box;
  };

  box.domain = function(x) {
    if (!arguments.length) return domain;
    domain = x == null ? x : d3.functor(x);
    return box;
  };

  box.value = function(x) {
    if (!arguments.length) return value;
    value = x;
    return box;
  };

  box.whiskers = function(x) {
    if (!arguments.length) return whiskers;
    whiskers = x;
    return box;
  };

  box.showLabels = function(x) {
    if (!arguments.length) return showLabels;
    showLabels = x;
    return box;
  };

  box.quartiles = function(x) {
    if (!arguments.length) return quartiles;
    quartiles = x;
    return box;
  };

  return box;
};

function boxWhiskers(d) {
  return [0, d.length - 1];
}

function boxQuartiles(d) {
  return [
    d3.quantile(d, .25),
    d3.quantile(d, .5),
    d3.quantile(d, .75)
  ];
}

})();

/*********************************************************************
**********************************************************************
                          Draw box plot
**********************************************************************
*********************************************************************/

const drawBoxPlot = () => {

  var labels = true; // show the text labels beside individual boxplots?

  var margin = {top: 30, right: 50, bottom: 70, left: 50};
  var  width = 800 - margin.left - margin.right;
  var height = 400 - margin.top - margin.bottom;

  var min = Infinity,
      max = -Infinity;

  // parse in the data
  d3.csv("https://gist.githubusercontent.com/jensgrubert/7789216/raw/2d40368c5e8dcc88f26e8e80e2128bd4c2adc942/data.csv", function(error, csv) {
  	// using an array of arrays with
  	// data[n][2]
  	// where n = number of columns in the csv file
  	// data[i][0] = name of the ith column
  	// data[i][1] = array of values of ith column

  	var data = [];
  	data[0] = [];
  	data[1] = [];
  	data[2] = [];
  	data[3] = [];
  	// add more rows if your csv file has more columns

  	// add here the header of the csv file
  	data[0][0] = "Q1";
  	data[1][0] = "Q2";
  	data[2][0] = "Q3";
  	data[3][0] = "Q4";
  	// add more rows if your csv file has more columns

  	data[0][1] = [];
  	data[1][1] = [];
  	data[2][1] = [];
  	data[3][1] = [];

  	csv.forEach(function(x) {
  		var v1 = Math.floor(x.Q1),
  			v2 = Math.floor(x.Q2),
  			v3 = Math.floor(x.Q3),
  			v4 = Math.floor(x.Q4);
  			// add more variables if your csv file has more columns

  		var rowMax = Math.max(v1, Math.max(v2, Math.max(v3,v4)));
  		var rowMin = Math.min(v1, Math.min(v2, Math.min(v3,v4)));

  		data[0][1].push(v1);
  		data[1][1].push(v2);
  		data[2][1].push(v3);
  		data[3][1].push(v4);
  		 // add more rows if your csv file has more columns

  		if (rowMax > max) max = rowMax;
  		if (rowMin < min) min = rowMin;
  	});

  	var chart = d3.box()
  		.whiskers(iqr(1.5))
  		.height(height)
  		.domain([min, max])
  		.showLabels(labels);

  	var svg = d3.select("#boxPlot").append("svg")
  		.attr("width", width + margin.left + margin.right)
  		.attr("height", height + margin.top + margin.bottom)
  		.attr("class", "box")
  		.append("g")
  		.attr("transform", "translate(" + margin.left + "," + margin.top + ")");

      // // the x-axis
    	// var x = d3.scale.ordinal()
    	// 	.domain( data.map(function(d) { console.log(d); return d[0] } ) )
    	// 	.rangeRoundBands([0 , width], 0.7, 0.3);

      var x = d3.scaleBand()
          .domain(data.map(function(d) { console.log(d); return d[0] } ))
          .range([0, width])
          .paddingInner(0.7)
          .paddingOuter(0.3)

  	var xAxis = d3.axisBottom()
  		.scale(x)

  	// the y-axis
  	var y = d3.scaleLinear()
  		.domain([min, max])
  		.range([height + margin.top, 0 + margin.top]);

  	var yAxis = d3.axisLeft()
      .scale(y)

  	// draw the boxplots
  	svg.selectAll(".box")
        .data(data)
  	  .enter().append("g")
  		.attr("transform", function(d) { return "translate(" +  x(d[0])  + "," + margin.top + ")"; } )
        .call(chart.width(x.bandwidth()));


  	// add a title
  	svg.append("text")
          .attr("x", (width / 2))
          .attr("y", 0 + (margin.top / 2))
          .attr("text-anchor", "middle")
          .style("font-size", "18px")
          //.style("text-decoration", "underline")
          .text("Revenue 2012");

  	 // draw y axis
  	svg.append("g")
          .attr("class", "y axis")
          .call(yAxis)
  		.append("text") // and text1
  		  .attr("transform", "rotate(-90)")
  		  .attr("y", 6)
  		  .attr("dy", ".71em")
  		  .style("text-anchor", "end")
  		  .style("font-size", "16px")
  		  .text("Revenue in €");

  	// draw x axis
  	svg.append("g")
        .attr("class", "x axis")
        .attr("transform", "translate(0," + (height  + margin.top + 10) + ")")
        .call(xAxis)
  	  .append("text")             // text label for the x axis
          .attr("x", (width / 2) )
          .attr("y",  10 )
  		.attr("dy", ".71em")
          .style("text-anchor", "middle")
  		.style("font-size", "16px")
          .text("Quarter");
  });

  // Returns a function to compute the interquartile range.
  function iqr(k) {
    return function(d, i) {
      var q1 = d.quartiles[0],
          q3 = d.quartiles[2],
          iqr = (q3 - q1) * k,
          i = -1,
          j = d.length;
      while (d[++i] < q1 - iqr);
      while (d[--j] > q3 + iqr);
      return [i, j];
    };
  }

}

export default drawBoxPlot;
