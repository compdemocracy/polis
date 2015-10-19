//var display = require("../util/display");
// var eb = require("../eventBus");
var template = require('../tmpl/conversationStats');
var PolisModelView = require("../lib/PolisModelView");
var Utils = require("../util/utils");
// var Constants = require("../util/constants");

// var isIE8 = Utils.isIE8();

var colors = {
  voteTimes: "steelblue",
  firstVoteTimes: "orange",
  commentTimes: "steelblue",
  firstCommentTimes: "red",
  viewTimes: "steelblue",
};
var names = {
  voteTimes: "Votes",
  firstVoteTimes: "Participants",
  commentTimes: "Comments",
  firstCommentTimes: "Commenters",
  viewTimes: "Viewers",
};

module.exports =  PolisModelView.extend({
  name: "conversationStatsView",
  template: template,
  events: {
  },
  context: function() {
    var ctx = PolisModelView.prototype.context.apply(this, arguments);
    ctx.viewTimesColor = colors.viewTimes;
    ctx.firstVoteTimesColor = colors.firstVoteTimes;
    ctx.firstCommentTimesColor = colors.firstCommentTimes;
    ctx.votesColor = colors.voteTimes;
    ctx.commentsColor = colors.commentTimes;
    return ctx;
  },
  renderParticipantGraph: function(id, datasetNamesToRender) {
    var vis = d3.select(id);
    var w = 550;
    var h = 200;
    var margins = {
      top: 20,
      right: 20,
      bottom: 20,
      left: 50
    };
    var strokeWidth = 2;

    var times = this.model.get("times");
    times = _.pick(times, datasetNamesToRender);
    var keys = _.keys(times);
    var datasets = _.values(times);

    var dataSetWithEarlisetEntry = Utils.argMin(datasets, function(dataset) {
      if (!dataset.length) {
        return Infinity;
      }
      return dataset[0].created;
    });
    var first = dataSetWithEarlisetEntry[0];

    var dataSetWithLastEntry = Utils.argMax(datasets, function(dataset) {
      if (!dataset.length) {
        return -Infinity;
      }
      return dataset[dataset.length - 1].created;
    });
    var last = dataSetWithLastEntry[dataSetWithLastEntry.length - 1];

    var xScale = d3.time.scale()
      .range([margins.left, w - margins.right])
      .domain([first.created, last.created]);

    var dataSetWithLowestCount = Utils.argMin(datasets, function(dataset) {
      if (!dataset.length) {
        return Infinity;
      }
      return dataset[0].count;
    });

    var dataSetWithHighestCount = Utils.argMax(datasets, function(dataset) {
      if (!dataset.length) {
        return -Infinity;
      }
      return dataset[dataset.length - 1].count;
    });

    var yScale = d3.scale.linear()
      .range([h - margins.top, margins.bottom])
      .domain([
        dataSetWithLowestCount[0].count,
        dataSetWithHighestCount[dataSetWithHighestCount.length-1].count,
      ]);

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
      .style({
        "font-size": "9px"
      })
      .attr("transform", "translate(0," + (h - margins.bottom) + ")");


    vis.append("svg:g")
      .classed("y", true)
      .classed("axis", true)
      .style({
        "font-size": "10px"
      })
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

    _.each(times, function(data, name) {
      var color = colors[name];
      console.log(color, data.length);
      vis.append('path')
        .classed('line', true)
        .classed('line_' + name, true)
        .attr("clip-path", "url(#clip)")
        .attr('stroke', color)
        .attr('stroke-width', strokeWidth)
        .attr('fill', 'none')
        .data([data])
        // .attr('d', lineGen)
        ;

      // vis.select('path.line');
    });


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
      vis.selectAll("path.line").attr("d", lineGen);
    }

    draw();

  },

  renderVotesHistogram: function(id, values) {

    function isInVis(d) {
      return d.n_votes >= 7;
    }

    // A formatter for counts.
    var formatCount = d3.format(",.0f");

    var margin = {top: 10, right: 60, bottom: 60, left: 60},
        width = 960 - margin.left - margin.right,
        height = 500 - margin.top - margin.bottom;

    var numItems = Math.min(20, values.length);
    var x = d3.scale.linear()
        .domain([0, values.length-1])
        .range([0, width]);

    // var logValues = _.map(values, function(v) {
    //   return {
    //     val: v,
    //     logVal: Math.log(v),
    //   };
    // })


    // var N = _.reduce(values, function(memo, count) {
    //   if (count > 0) {
    //     return memo + 1;
    //   } else {
    //     return memo;
    //   }
    // }, 0);
    // Generate a histogram using N uniformly-spaced bins.
    // debugger;

    // var bins = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610];


    // var data = d3.layout.histogram()
    //     // .bins(
    //     .bins(x.ticks(numItems))
    //     (values);
    var data = (function() {
      var x = 0;
      var step = 1;
      return values.map(function(v, i) {
        if (i === 1) {
          v = 0; // don't show number of people who voted once. We currently prompt for social auth after one vote, and the user then changes identity, leaving a ptpt object who only voted once.
        }
        var histItem = {};
        histItem.dx = step;
        histItem.x = x;
        histItem.y = v;
        histItem.n_ptpts = v;
        histItem.n_votes = i;
        x += step;
        return histItem;
      });

    }());


    var tip = d3.tip()
      .attr('class', 'd3-tip')
      .offset(function(d) {
        var yOffset = -10;
        var xOffset = 0;

        var barTop = y(d.y);
        if (barTop < height/3) {
          yOffset = 140; // don't go beyond top
        }
        if (x(d.x) < 3*width/4) {
          xOffset = 100;
        }
        return [yOffset, xOffset];
      })
      .html(function(d) {
        var extraText = isInVis(d) ? "" : "<div style='max-width: 150px'>These participants are not shown in vis due to low vote count</div>";
        return "<span style='color:red'>" + d.n_ptpts + " voted " + d.n_votes + " times</span>" + extraText;
      })
    ;

    var y = d3.scale.linear()
        .domain([0, d3.max(data, function(d) { return d.y; })])
        .range([height, 0])
    ;

    var xAxis = d3.svg.axis()
        .scale(x)
        .orient("bottom")
    ;

    var yAxis = d3.svg.axis()
        .scale(y)
        .orient("left")
    ;

    var svg = d3.select(id)
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
      .append("g")
        .attr("transform", "translate(" + margin.left + "," + margin.top + ")")
    ;

    function barWidth(d) {
      return Math.max(1, (x(d.dx) - 1) << 0);
    }
    var bar = svg.selectAll(".bar")
        .data(data)
      .enter().append("g")
        .attr("class", "bar")
        .attr("transform", function(d) { return "translate(" + (x(d.x) - barWidth(d)/2) + "," + y(d.y) + ")"; })
    ;

    function barFill(d) {
      if (d.isHovered) {
        return "red";
      }
      if (isInVis(d)) {
        return "lightgray";
      }
      return "#eee";
    }

    bar.append("rect")
        .attr("x", 1)
        .attr("width", barWidth)
        .attr("height", function(d) { return height - y(d.y); })
        .style("fill", barFill)
        .style("shape-rendering", "crispEdges")
        .classed("vote-histogram-bar", true)
        .on('mouseover', tip.show)
        .on('mouseout', tip.hide)
    ;

    svg.append("g")
        .attr("class", "x axis")
        .attr("transform", "translate(0," + height + ")")
        .style("fill", "none")
        .style("stroke", "black")
        .style("shape-rendering", "crispEdges")
        .call(xAxis)
    ;

    svg.append("g")
        .attr("class", "y axis")
        .attr("transform", "translate(0,0)")
        .style("fill", "none")
        .style("stroke", "black")
        .style("shape-rendering", "crispEdges")
        .call(yAxis)
    ;

    svg.append("text")
      .attr("class", "x label")
      .attr("text-anchor", "middle")
      .attr("x", width/2)
      .attr("y", height + 40)
      .text("Comments voted on")
      .style("font-size", "18px")
    ;
    svg.append("text")
      .attr("class", "y label")
      .attr("text-anchor", "middle")
      .attr("y", - 50)
      .attr("x", -height/2)
      .attr("dy", ".75em")
      .attr("transform", "rotate(-90)")
      .text("Voters")
      .style("font-size", "18px")
    ;
    svg.call(tip);



  },
  checkForLatestStats: function() {
    var that = this;
    $.get("/api/v3/conversationStats?conversation_id=" + this.model.get("conversation_id")).then(function(stats) {

      var histogram = stats.votesHistogram;
      delete stats.votesHistogram;

      // loop over each array, and create objects like {count: ++i, created}, then create a line plot with count as y, and created as x
      var keys = _.keys(stats);
      // keys = [keys[0]]; // TODO remove
      var times = {};
      _.each(keys, function(key) {
        var vals = stats[key];
        var i = 1;
        var data = _.map(vals, function(created) {
          return {
            count: i++,
            created: created
          };
        });
        data = Utils.evenlySample(data, 300);
        var now = _.extend({}, data[data.length-1]);
        now.created = Date.now()+0; // straight line to current time
        data.push(now);
        times[key] = data;
      });

      // TODO remove this
      // (currently has too many entries to render)
      // delete times.voteTimes


      var histogram2 = [];
      var maxVotes = 0;
      histogram.forEach(function(x) {
        histogram2[x.n_votes] = x.n_ptpts;
        maxVotes = Math.max(maxVotes, x.n_votes);
      });
      for (var i = 0; i < maxVotes; i++) {
        // replace holes with zeros
        if (!histogram2[i]) {
          histogram2[i] = 0;
        }
      }

      that.model.set("times", times);
      that.renderParticipantGraph("#ptptCountsVis", ["firstVoteTimes", "firstCommentTimes", "viewTimes"]);
      that.renderParticipantGraph("#voteCountsVis", ["voteTimes"]);
      that.renderParticipantGraph("#commentCountsVis", ["commentTimes"]);
      // that.renderParticipantGraph("#socialUsersVis", ["socialUsers"]);
      that.renderVotesHistogram("#votesHistogram", histogram2);

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
