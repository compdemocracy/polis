//var display = require("../util/display");
// var eb = require("../eventBus");
var template = require('../tmpl/conversationStats');
var PolisModelView = require("../lib/PolisModelView");
// var Utils = require("../util/utils");
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
    var ptpts = data;
    var first = ptpts[0];
    var last = ptpts[ptpts.length-1];

    var xScale = d3.scale.linear()
      .range([margins.left, w - margins.right])
      .domain([first.created, last.created]);

    var yScale = d3.scale.linear()
      .range([h - margins.top, margins.bottom])
      .domain([ptpts[0].count, ptpts[ptpts.length-1].count]);

    var xAxis = d3.svg.axis()
      .scale(xScale);

    var yAxis = d3.svg.axis()
      .scale(yScale)
      .orient("left");

    vis.append("g")
      .attr("transform", "translate(0," + (h - margins.bottom) + ")")
      .call(xAxis);

    vis.append("svg:g")
      .attr("transform", "translate(" + (margins.left) + ",0)")
      .call(yAxis);

    var lineGen = d3.svg.line()
      .x(function(d) {
        return xScale(d.created);
      })
      .y(function(d) {
        return yScale(d.count);
      });

    vis.append('svg:path')
      .attr('d', lineGen(ptpts))
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('fill', 'none');

  },
  checkForLatestStats: function() {
    var that = this;
    $.get("/api/v3/conversationStats?conversation_id=" + this.model.get("conversation_id")).then(function(stats) {
      
      // loop over each array, and create objects like {count: ++i, created}, then create a line plot with count as y, and created as x
      _.each(_.keys(stats), function(key) {
        var vals = stats[key];
        var i = 1;
        var data = _.map(vals, function(created) {
          return {
            count: i++,
            created: created
          };
        });
        that.model.set(key, data);
        that.renderParticipantGraph(data, "green");
      });


    }, function(error) {
      console.warn("error fetching stats");
    });
  },
  initialize: function(options) {
    Handlebones.View.prototype.initialize.apply(this, arguments);
    var that = this;

    setInterval(function() {
      that.checkForLatestStats();
    }, 30*1000);
    this.checkForLatestStats();

  } // end initialize
});