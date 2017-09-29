const drawBeeswarm = (data, onHoverCallback) => {

  function type(d) {
    if (!d.value) return;
    d.value = +d.value;
    return d;
  }

  const url = "https://gist.githubusercontent.com/mbostock/6526445e2b44303eebf21da3b6627320/raw/1635fd4a3f08f090003be7b84284c266ea708a78/flare.csv";

  var svg = d3.select("#beeswarmAttachPointD3"),
      margin = {top: 40, right: 40, bottom: 40, left: 40},
      width = svg.attr("width") - margin.left - margin.right,
      height = svg.attr("height") - margin.top - margin.bottom;

  var formatValue = d3.format(",d");

  var x = d3.scaleLinear()
      .rangeRound([0, width]);


  var g = svg.append("g")
      .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    x.domain(d3.extent(data, function(d) { return d.extremity; }));

    var simulation = d3.forceSimulation(data)
        .force("x", d3.forceX(function(d) {
          return x(d.extremity);
        }).strength(1))
        .force("y", d3.forceY(height / 2))
        .force("collide", d3.forceCollide(4))
        .stop();

    for (var i = 0; i < 120; ++i) simulation.tick();

    g.append("g")
        .attr("class", "axis axis--x")
        .attr("transform", "translate(0," + height + ")")
        .call(d3.axisBottom(x).ticks(3, ".0s"));

    svg.append("text")
      .attr("transform", "translate(" + (width/2) + " ," + (height + margin.top + 40) + ")")
        .style("text-anchor", "middle")
        .text("← less divisive - more divisive →");

    var cell = g.append("g")
        .attr("class", "cells")
      .selectAll("g").data(d3.voronoi()
          .extent([[-margin.left, -margin.top], [width + margin.right, height + margin.top]])
          .x(function(d) { return d.x; })
          .y(function(d) { return d.y; })
        .polygons(data)).enter().append("g")
        .on("mouseenter", (d) => {
          console.log('mouseenter', d)
          onHoverCallback(d);
        })

    cell.append("circle")
        .attr("r", 3)
        .attr("cx", function(d) { return d.data.x; })
        .attr("cy", function(d) { return d.data.y; });

    cell.append("path")
        .attr("d", function(d) { return "M" + d.join("L") + "Z"; });

    cell.append("title")
        .text(function(d) { return d.data.id + "\n" + formatValue(d.data.value); });

}

export default drawBeeswarm;
