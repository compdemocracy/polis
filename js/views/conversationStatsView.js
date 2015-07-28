//var display = require("../util/display");
// var eb = require("../eventBus");
var template = require('../tmpl/conversationStats');
var PolisModelView = require("../lib/PolisModelView");
var Utils = require("../util/utils");
// var Constants = require("../util/constants");

// var isIE8 = Utils.isIE8();

module.exports =  PolisModelView.extend({
  name: "conversationStatsView",
  template: template,
  events: {
  },
  context: function() {
    var ctx = PolisModelView.prototype.context.apply(this, arguments);
    return ctx;
  },
  renderParticipantGraph: function(data, color) {
    var vis = d3.select("#ptptCountsVis");
    var w = 1000;
    var h = 200;
    var margins = {
      top: 20,
      right: 20,
      bottom: 20,
      left: 50
    };
    var strokeWidth = 2;
    var ptpts = data;
    var first = ptpts[0];
    var last = ptpts[ptpts.length-1];
    var xScale = d3.time.scale()
      .range([margins.left, w - margins.right])
      .domain([first.created, last.created]);

    var yScale = d3.scale.linear()
      .range([h - margins.top, margins.bottom])
      .domain([ptpts[0].count, ptpts[ptpts.length-1].count]);

    var xAxis = d3.svg.axis()
      .scale(xScale)
      .orient("bottom")
      .tickSize(-h, 0)
      .tickPadding(6);

    var yAxis = d3.svg.axis()
      .scale(yScale)
      .tickSize(-w, 0)
      .tickPadding(6)
      .orient("left");

    vis.append("clipPath")
        .attr("id", "clip")
      .append("rect")
        .attr("x", xScale(first.created) - strokeWidth)
        // .attr("y", yScale(1))
        .attr("width", w)
        .attr("height", h);

    vis.append("g")
      .classed("x", true)
      .classed("axis", true)
      .attr("transform", "translate(0," + (h - margins.bottom) + ")");


    vis.append("svg:g")
      .classed("y", true)
      .classed("axis", true)
      .attr("transform", "translate(" + (margins.left) + ",0)");



    var lineGen = d3.svg.line()
      .x(function(d) {
        return xScale(d.created);
      })
      .y(function(d) {
        return yScale(d.count);
      });

// var line = d3.svg.line()
//     .interpolate("step-after")
//     .x(function(d) { return x(d.date); })
//     .y(function(d) { return y(d.value); });



    vis.append('path')
      .classed('line', true)
      .attr("clip-path", "url(#clip)")
      .attr('stroke', color)
      .attr('stroke-width', strokeWidth)
      .attr('fill', 'none');

    vis.select('path.line').data([ptpts]);


    var zoom = d3.behavior.zoom()
      .on("zoom", draw);
    zoom.x(xScale);

    vis.append("rect")
      .attr("class", "pane")
      .attr("width", w)
      .attr("height", h)
      .style("cursor", "move")
      .style("fill", "rgba(0,0,0,0)")
      .style("pointer-events", "all")
      .call(zoom);

    function draw() {
      vis.select("g.x.axis").call(xAxis);
      vis.select("g.y.axis").call(yAxis);
      // vis.select("path.area").attr("d", area);
      vis.select("path.line").attr("d", lineGen);
    }

    draw();

  },
  checkForLatestStats: function() {
    var that = this;
    $.get("/api/v3/conversationStats?conversation_id=" + this.model.get("conversation_id")).then(function(stats) {
      
      // loop over each array, and create objects like {count: ++i, created}, then create a line plot with count as y, and created as x
      var keys = _.keys(stats);
      keys = [keys[0]]; // TODO remove
      _.each(keys, function(key) {
        var vals = stats[key];
        var i = 1;
        var data = _.map(vals, function(created) {
          return {
            count: i++,
            created: created
          };
        });
        var now = _.extend({}, data[data.length-1]);
        now.created = Date.now()+0; // straight line to current time
        data.push(now);
        that.model.set(key, data);

        that.renderParticipantGraph(data, "black");
      });


    }, function(error) {
      console.warn("error fetching stats");
    });
  },
  initialize: function(options) {
    Handlebones.View.prototype.initialize.apply(this, arguments);
    var that = this;

    setInterval(function() {
      if (!Utils.isHidden()) {
        that.checkForLatestStats();
      }
    }, 60*1000);
    this.checkForLatestStats();

  } // end initialize
});