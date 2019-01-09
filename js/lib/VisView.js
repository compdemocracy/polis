// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var eb = require("../eventBus");
var display = require("../util/display");
var Utils = require("../util/utils");
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

/*jshint -W098 */
var VisView;
/*jshint +W098 */

VisView = function(params) {

  var el_selector = params.el;
  var el_queryResultSelector = params.el_queryResultSelector;
  var getReactionsToComment = params.getReactionsToComment;
  var computeXySpans = params.computeXySpans;
  var getPidToBidMapping = params.getPidToBidMapping;
  var isMobile = params.isMobile;
  var xOffset = params.xOffset || 0;
  var getGroupNameForGid = params.getGroupNameForGid;

  var firstShowDeferred = $.Deferred();

  function getBid(d) {
    return d.bid;
  }

  var groupTag = "g";

  var onSelfAppearsCallbacks = $.Callbacks();
  var selfHasAppeared = false;

  // The h and w values should be locked at a 1:2 ratio of h to w
  var h;
  var w;
  var participantCount = 1;
  var nodes = [];
  var clusters = [];
  var clusterParticipantTotals = [];
  var hulls = []; // NOTE hulls will be the same length as clusters
  var centroids = [];
  var visualization;
  var main_layer;
  var blocker_layer;
  var overlay_layer;
  //var g; // top level svg group within the vis that gets translated/scaled on zoom
  var force;
  var queryResults;
  var d3Hulls; // NOTE: this has constant length, may be longer than hulls array
  var d3HullSelections;
  // var d3HullShadows;
  var hullPoints = [];

  var hullIdToGid = {};

  var selectedCluster = -1;
  var selectedTid = -1;

  var eps = 0.000000001;

  var COLOR_SELECTED_HULL = true;
  var EXTRA_RADIUS_FOR_SUMMARY_HALO = 2;
  var SELECTED_HULL_RADIUS_BOOST = 3;
  var UNSELECTED_HULL_RADIUS_BOOST = -1;

  var width = $(el_selector).width();

  // var ptptOiRadius = d3_old.scale.linear().range([10, 16]).domain([350, 800]).clamp(true)(width);
  var retina = window.devicePixelRatio > 1;
  var basePtptoiRad = retina ? 12 : 10;
  if (isMobile) {
    basePtptoiRad = 9;
  }
  var maxradboost = 8;
  var ptptOiRadius = basePtptoiRad + d3_old.scale.linear().range([0, maxradboost]).domain([350, 800]).clamp(true)(width);
  var maxPtptoiRad = basePtptoiRad + maxradboost;
  var ptptOiDiameter = ptptOiRadius * 2;


  var haloWidth = d3_old.scale.linear().range([1, 1]).domain([350, 800]).clamp(true)(width);
  var haloVoteWidth = d3_old.scale.linear().range([2, 4]).domain([350, 800]).clamp(true)(width);
  var anonBlobRadius = isMobile ? 18 : 20;
  var anonBlobHaloWidth = d3_old.scale.linear().range([2, 4]).domain([350, 800]).clamp(true)(width);
  var anonBlobHaloVoteWidth = anonBlobHaloWidth; //d3_old.scale.linear().range([6, 10]).domain([350, 800]).clamp(true)(width);
  var maxRad = _.max([
    ptptOiRadius + haloWidth, // not sure if halowidth should be /2
    ptptOiRadius + haloVoteWidth, // not sure if haloVoteWidth should be /2
    anonBlobRadius + anonBlobHaloWidth, // not sure if anonBlobHaloWidth should be /2
    anonBlobRadius + anonBlobHaloVoteWidth // not sure if anonBlobHaloVoteWidth should be /2
  ]);

  var HULL_EXTRA_RADIUS = 0; //d3_old.scale.linear().range([2, 6]).domain([350, 800]).clamp(true)(width);

  // framerate can be low on mobile, so make it quick
  var speed = d3_old.scale.linear().range([0.8, 0.1]).domain([350, 800]).clamp(true)(width);


  // the length of the visible part of the pin. The pin can be longer, if it is under the circle.
  var pinLength = d3_old.scale.linear().range([14, 28]).domain([350, 800]).clamp(true)(width);



  var bidToGid = {};
  var bidToBucket = {};

  var SELF_DOT_SHOW_INITIALLY = true;
  var selfDotTooltipShow = !SELF_DOT_SHOW_INITIALLY;
  var SELF_DOT_HINT_HIDE_AFTER_DELAY = 10 * 1000;
  var selfDotHintText = "you";

  // Tunables

  var minNodeRadiusScaleForGivenVisWidth = d3_old.scale.linear().range([2, 4]).domain([350, 800]).clamp(true);
  var strokeWidthGivenVisWidth = d3_old.scale.linear().range([0.2, 1.0]).domain([350, 800]).clamp(true);
  var hullStrokeWidthGivenVisWidth = d3_old.scale.linear().range([4, 12]).domain([350, 800]).clamp(true);

  var grayHaloColor = "darkgrey";
  var grayHaloColorSelected = grayHaloColor; // "rgba(0,0,0,0)";
  var colorPull = "#2ecc71";
  var colorPullLabel = "rgb(0, 181, 77)";
  var colorPush = "#e74c3c"; // ALIZARIN
  var colorSummaryBlob = "#F9F9F9";
  window.color = function() {
    // colorPull = "rgb(0, 214, 195)";
    colorPull = "rgb(0, 182, 214)";
    colorPullLabel = "#6d9eeb";
    colorPush = "rgb(234, 77, 30)";

    var update = visualization.selectAll(".node");
    update.selectAll(".up.bktvi").style("stroke", colorPull);
    update.selectAll(".down.bktvi").style("stroke", colorPush);
  };

  var colorPass = "#bbb"; //#BDC3C7"; // SILVER
  var colorSelf = "rgb(0, 186, 255)"; // blue - like the 'you are here' in mapping software
  // var colorSelfOutline = d3_old.rgb(colorSelf).darker().toString();
  // var colorPullOutline = d3_old.rgb(colorPull).darker().toString();
  // var colorPushOutline = d3_old.rgb(colorPush).darker().toString();
  var colorSelfOutline = "rgba(0, 0, 245, 0.25)";

  // Cached results of tunalbes - set during init
  var strokeWidth;
  // Since initialize is called on resize, clear the old vis before setting up the new one.
  $(el_selector + " > .visualization").remove();

  /* d3-tip === d3 tooltips... [[$ bower install --save d3-tip]] api docs avail at https://github.com/Caged/d3-tip */
  var tip = null;
  // var SHOW_TIP = true;
  // if (SHOW_TIP) {
  //   $("#ptpt-tip").remove();
  //   tip = d3_old.tip().attr("id", "ptpt-tip").attr("stroke", "rgb(52,73,94)").html(
  //     function(d) {
  //       return d.tid;
  //     }
  //   );
  // }
  var hoveredHullId = -1;

  function showTip(d) {
    if (tip) {
      tip.show.apply(tip, arguments);
    }

    if (isParticipantOfInterest(d) && clickingPtptoiOpensProfile()) {
      return;
    }

    var gid = bidToGid[d.bid];
    if (_.isNumber(gid)) {
      var hullId = gidToHullId[gid];
      hoveredHullId = hullId;
      visualization.selectAll(".hovered_group").classed("hovered_group", false);
      updateHullColors();
    }
  }

  function hideTip() {
    if (tip) {
      tip.hide.apply(tip, arguments);
    }
    hoveredHullId = -1;
    visualization.selectAll(".hovered_group").classed("hovered_group", false);
    updateHullColors();
  }

  var onMajorityTab = false;
  eb.on("aftershow:majority", function() {
    console.log("aftershow:majority");
    onMajorityTab = true;
  });
  eb.on("beforehide:majority", function() {
    console.log("beforehide:majority");
    onMajorityTab = false;
  });

  function chooseRadiusForHullCorners(d) {
    var r = 3;
    if (d.isSummaryBucket) {
      r = anonBlobRadius + 8;
    }
    return r;
  }


  var dimensions = {
    width: params.w,
    height: params.h + chooseRadiusForHullCorners({
      isSummaryBucket: true
    }) + 2, // the +2 is to give 1 pixel for the hull stroke, and 1 pixel of white
  };


  $(el_selector)
    .append("<svg>" +
      "<defs>" +
      "<marker class='helpArrow' id='ArrowTip'" +
      "viewBox='0 0 14 14'" +
      "refX='1' refY='5'" +
      "markerWidth='5'" +
      "markerHeight='5'" +
      "orient='auto'>" +
      // "<path d='M 0 0 L 10 5 L 0 10 z' />" +
      "<circle cx = '6' cy = '6' r = '5' />" +
      "</marker>" +
      "<clipPath id=\"clipCircle\">" +
      "<circle r=\"" + ptptOiRadius + "\" cx=\"0\" cy=\"0\"/>" +
      "</clipPath>" +
      "<filter id='colorMeMatrix'>" +
      "<feColorMatrix in='SourceGraphic'" +
      "type='matrix'" +
      "values='0.33 0.33 0.33 0 0 " +
      "0.33 0.33 0.33 0 0 " +
      "0.33 0.33 0.33 0 0 " +
      "0 0 0 1 0' />" +
      "</filter>" +

      "<filter id='colorMeMatrixRed'>" +
      "<feColorMatrix in='SourceGraphic'" +
      "type='matrix'" +
      "values='1.00 0.60 0.60 0 0.3 " +
      "0.10 0.20 0.10 0 0 " +
      "0.10 0.10 0.20 0 0 " +
      "0 0 0 1 0' />" +
      "</filter>" +

      "<filter id='colorMeMatrixGreen'>" +
      "<feColorMatrix in='SourceGraphic'" +
      "type='matrix'" +
      "values='0.20 0.10 0.10 0 0 " +
      "0.60 1.00 0.60 0 0.3 " +
      "0.10 0.10 0.40 0 0 " +
      "0 0 0 1 0' />" +
      "</filter>" +

      "</defs>" +
      // "<g>" +
      // '<rect x="'+ (w-150) +'" y="0" width="150" height="25" rx="3" ry="3" fill="#e3e4e5"/>'+
      // '<text x="'+ (w-150) +'" y="10" width="150" height="25" rx="3" ry="3" fill="##3498db">SHOW LEGEND</text>'+
      // "</g>" +
      "</svg>");


  var helpLine;
  var helpArrowPoints = [];

  //create svg, appended to a div with the id #visualization_div, w and h values to be computed by jquery later
  //to connect viz to responsive layout if desired
  visualization = d3_old.select(el_selector).select("svg")
    .call(tip || function() {}) /* initialize d3-tip */
    // .attr("width", "100%")
    // .attr("height", "100%")
    .attr(dimensions)
    // .attr("viewBox", "0 0 " + w + " " + h )
    .classed("visualization", true)
    .append(groupTag)
    // .call(d3_old.behavior.zoom().scaleExtent([1, 8]).on("zoom", zoom))
  ;
  $(el_selector).on("click", selectBackground);
  $(el_selector).on("click", function() {
    eb.trigger(eb.backgroundClicked);
  });


  main_layer = visualization.append(groupTag)
    .attr("id", "main_layer")
    .attr("transform", "translate(" + xOffset + ")");

  blocker_layer = visualization.append(groupTag)
    .attr("id", "blocker_layer")
    .attr("transform", "translate(" + xOffset + ")");

  overlay_layer = visualization.append(groupTag);

  helpLine = d3_old.svg.line();

  overlay_layer.append("path")
    .datum(helpArrowPoints)
    .classed("helpArrow", true)
    .classed("helpArrowLine", true)
    .style("display", "none");
  w = dimensions.width - xOffset; // $(el_selector).width() - xOffset;
  h = params.h; //dimensions.height; //$(el_selector).height();


  var clusterPointerFromBottom = display.xs();
  var clusterPointerOriginY = clusterPointerFromBottom ? h + 2 : 80;


  // function zoom() {
  //   // TODO what is event?
  //   visualization.attr("transform", "translate(" + d3_old.event.translate + ")scale(" + d3_old.event.scale + ")");
  // }

  window.vis = visualization; // TODO why? may prevent GC

  strokeWidth = strokeWidthGivenVisWidth(w);
  var padding = maxRad + strokeWidth + 15;

  charge = -60; //chargeForGivenVisWidth(w);

  queryResults = $(el_queryResultSelector).html("");

  // } else {
  // queryResults = $(el_queryResultSelector).html("");

  $(el_queryResultSelector).hide();

  //$(el_selector).prepend($($("#pca_vis_overlays_template").html()));


  force = d3_old.layout.force()
    .nodes(nodes)
    .links([])
    .friction(0.9) // more like viscosity [0,1], defaults to 0.9
    .gravity(0)
    .charge(function(d) {
      // slight overlap allowed
      if (isSummaryBucket(d)) {
        if (display.xs()) {
          return -900;
        } else {
          return -200;
        }
      } else {
        return -80;
      }
    })
    .size([w, h]);


  // function zoomToHull(d){

  //     var b = bounds[d.hullId];
  //     visualization.transition().duration(750)
  //     //.attr("transform", "translate(" + d3_old.event.translate + ")scale(" + d3_old.event.scale + ")");
  //     .attr("transform", "" + "scale(" + 0.95 / Math.max((b[1][0] - b[0][0]) / w, (b[1][1] - b[0][1]) / h) + ")" + "translate(" + -(b[1][0] + b[0][0]) / 2 + "," + -(b[1][1] + b[0][1]) / 2 + ")");
  //     //visualization.attr("transform", "translate(10,10)scale(" + d3_old.event.scale + ")");
  // }

  function setClusterActive(clusterId) {
    selectedCluster = clusterId;
    return $.Deferred().resolve([]);
  }

  function showAllClustersAsActive() {
    var len = d3Hulls.length;
    for (var i = 0; i < len; i++) {
      d3_old.select(d3Hulls[i][0][0])
        .classed("active_group", true);
      d3_old.select(d3HullSelections[i][0][0])
        .classed("active_group", true)
        .style("visibility", "visible");
    }
  }

  function updateHullColors() {
    if (clusterIsSelected()) {
      d3_old.select(d3Hulls[selectedCluster][0][0]).classed("active_group", true);
      d3_old.select(d3HullSelections[selectedCluster][0][0]).classed("active_group", true);
      // d3_old.select(d3HullShadows[selectedCluster][0][0]).classed("active_group", true);
    }
    (function() {
      for (var i = 0; i < d3Hulls.length; i++) {
        if (i === hoveredHullId) {
          d3_old.select(d3Hulls[i][0][0]).classed("hovered_group", true);
          d3_old.select(d3HullSelections[i][0][0]).classed("hovered_group", true);
          // d3_old.select(d3HullShadows[selectedCluster][0][0]).classed("hovered_group", true);
        }
      }
    }());
  }


  function onClusterClicked(d) {
    return handleOnClusterClicked(d.hullId);
  }

  function exitTutorial() {
    dotsShouldWiggle = false;
    removeTutorialStepOne();
  }

  // TODO needs tutorial step advancement needs rethinking
  function removeTutorialStepOne() {
    var help = visualization.selectAll(".help");
    help.style("display", "none");
  }

  function handleOnClusterClicked(hullId, silent) {
    // // if the cluster/hull just selected was already selected...
    // if (selectedCluster === hullId) {
    //   return resetSelection();
    // }
    exitTutorial();

    var gid = hullIdToGid[hullId];

    // resetSelectedComment();
    // unhoverAll();
    setClusterActive(gid)
      .then(
        updateHulls,
        updateHulls);

    if (!silent) {
      eb.trigger(eb.clusterClicked, gid);
      eb.trigger(eb.clusterSelectionChanged, gid);
    }

    updateHullColors();

    //zoomToHull.call(this, d);
    if (d3 && d3_old.event) {
      if (d3_old.event.stopPropagation) {
        d3_old.event.stopPropagation();
      }
      if (d3_old.event.preventDefault) {
        d3_old.event.preventDefault(); // prevent flashing on iOS
      }
    }
  }
  var hull_shadow_thickness = w > 550 ? 2 : 1;
  var hull_seletion_thickness = w > 550 ? 2 : 1;
  var hull_stoke_width = hullStrokeWidthGivenVisWidth(w);
  var hull_shadow_stroke_width = hull_stoke_width + hull_shadow_thickness;
  var hull_selection_stroke_width = hull_shadow_stroke_width + hull_seletion_thickness;


  function makeD3Hulls(hullClass, strokeWidth, translateX, translateY) {
    return _.times(9, function(i) {
      var hull = main_layer.append("path");
      hull.classed(hullClass, true)
        .on("click", onClusterClicked) //selection-results:1 handle the click event
        // .style("stroke-width", strokeWidth)
        .attr("hullId", i);

      if (translateX || translateY) {
        hull.attr("transform", "translate(1, 1)");
      }
      return hull;
    });
  }

  // d3HullShadows = makeD3Hulls("hull_shadow", hull_shadow_stroke_width, 1, 1);
  d3HullSelections = makeD3Hulls("hull_selection", hull_selection_stroke_width, 0, 0);
  d3Hulls = makeD3Hulls("hull", hull_stoke_width);


  function updateHulls() {
    bidToBucket = _.object(_.pluck(nodes, "bid"), nodes);
    hulls = clusters.map(function(cluster) {
      var temp = _.map(cluster, function(bid) {
        var bucket = bidToBucket[bid];
        if (_.isUndefined(bucket)) {
          return null;
        }
        var x = bucket.x;
        var y = bucket.y;
        return [x, y, bucket]; // [x,y] point with bucket tacked on for convenience. Ugly, sorry.
      });
      temp = _.filter(temp, function(xy) {
        // filter out nulls
        return !!xy;
      });

      return temp;
    });

    function makeHullShape(stuff) {
      return "M" + stuff.join("L") + "Z";
    }

    function getOffsetForPin(node) {
      if (isSummaryBucket(node)) {
        return pinLength;
      } else {
        return pinLength;
      }
    }

    function tesselatePoint(xyPair, chooseRadius) {
      var x = xyPair[0];
      var y = xyPair[1];
      var node = xyPair[2];
      var r = chooseRadius(node);
      var yOffset = getOffsetForPin(node);
      var points = [];
      var theta = 0;
      var tau = 6.28318;
      var step = 0.261799; // pi/12
      while (theta < tau) {
        points.push([x + r * Math.cos(theta), yOffset + y + r * Math.sin(theta)]);
        theta += step;
      }
      return points;
    }

    function hideHull(i) {
      d3Hulls[i].datum([]).style("visibility", "hidden");
      d3HullSelections[i].datum([]).style("visibility", "hidden");
      // d3HullShadows[i].datum([]).style("visibility", "hidden");
    }

    function updateHull(i) {
      var dfd = new $.Deferred();
      setTimeout(function() {
        var hull = hulls[i];

        // var pointsToFeedToD3 = hull.map(function(pt) { return pt;});

        // if (pointsToFeedTod3_old.length == 1) {
        //     pointsToFeedTod3_old.push([
        //         pointsToFeedToD3[0][0] + 0.01,
        //         pointsToFeedToD3[0][1] + 0.01
        //         ]);
        // }
        // if (pointsToFeedTod3_old.length == 2) {
        //     pointsToFeedTod3_old.push([
        //         pointsToFeedToD3[0][0] + 0.01,
        //         pointsToFeedToD3[0][1] - 0.01 // NOTE subtracting so they're not inline
        //         ]);
        // }



        // var hullPoints_WillBeMutated = d3_old.geom.hull(pointsToFeedToD3);

        if (!hull) {
          // TODO figure out what's up here
          hideHull(i);
          console.error('cluster/hull count mismatch error');
          dfd.resolve();
          return;
        }
        var pointsToFeedToCentroidFinder = hull.map(function(pt) {
          return pt;
        });

        // TODO PERF don't call computeClusterPointerTarget unless the pointer is visible!
        var centroid = computeClusterPointerTarget(pointsToFeedToCentroidFinder);
        centroids[i] = centroid;

        // tesselate to provide a matching hull roundness near large buckets.
        var tessellatedPoints = [];
        var DO_TESSELATE_POINTS = true;
        var chooseRadius;
        if (DO_TESSELATE_POINTS) {
          chooseRadius = function(node) {
            return chooseRadiusForHullCorners(node) + HULL_EXTRA_RADIUS;
          };
        } else {
          chooseRadius = function(node) {
            // return chooseRadiusForHullCorners(node);
            return 5;
          };
        }
        for (var p = 0; p < hull.length; p++) {
          tessellatedPoints = tessellatedPoints.concat(tesselatePoint(hull[p], chooseRadius));
        }
        // if (!DO_TESSELATE_POINTS) {
        //     tessellatedPoints = tessellatedPoints.map(function(pt) {
        //         pt[1] += pinLength;
        //         return pt;
        //     });
        // }

        (function() {
          for (var pi = 0; pi < hullPoints.length; pi++) {
            var p = hullPoints[pi];
            // inset to prevent overlap caused by stroke width.
            var dist = strokeWidth / 2 + 5;
            var inset = moveTowardsTarget(p[0], p[1], centroid.x, centroid.y, dist);
            p[0] = inset.x;
            p[1] = inset.y;
          }
        }());

        // another pass through the hull generator, to remove interior tesselated points.
        var points = d3_old.geom.hull(tessellatedPoints);
        hullPoints[i] = points;
        if (!points.length) {
          hideHull(i);
        } else {
          points.hullId = i; // NOTE: d is an Array, but we're tacking on the hullId. TODO Does D3 have a better way of referring to the hulls by ID?
          var shape = makeHullShape(points);
          // If the cluster has only one participant, don't show the hull.
          // intead, make the hull into an extra large invisible touch target.
          var color = (clusters[i].length > 1) ? "#eee" : "#f7f7f7";
          // var strokeWidth = (clusters[i].length > 1) ? "6px" : "40px";

          var shadowStrokeWidth = (clusters[i].length > 1) ? "8px" : "0px";

          if (selectedCluster === i) {
            // no shadow, since we'll show dashed line
            if (COLOR_SELECTED_HULL) {
              shadowStrokeWidth = "0px";
              color = "#e9f0f7";
            }

            d3HullSelections[i].datum(points)
              .attr("d", shape)
              .style("visibility", "visible");
          } else {
            d3HullSelections[i].datum(points)
              .attr("d", shape)
              .style("visibility", "hidden");
          }

          d3Hulls[i].datum(points)
            .attr("d", shape)
            // .style("fill-opacity", 1)
            // .style("fill", "white")
            .style("stroke", "rgb(130,130,130)")
            // .style("stroke-opacity", hullOpacity)
            .style("stroke-width", 1)
            .style("stroke-dasharray", "2px 4px")
            .style("visibility", "visible");


          // d3HullShadows[i].datum(points)
          //     .attr("d", shape)
          //     .style("fill", colorShadow)
          //     .style("stroke", colorShadow)
          //     // .style("fill-opacity", hullOpacity)
          //     // .style("stroke-opacity", hullOpacity)
          //     .style("stroke-width", shadowStrokeWidth)
          //     .attr("transform", function(h) {
          //         if (h.hullId === getSelectedGid()) {
          //             return "translate(2, 2)";
          //         } else {
          //             return "translate(1, 1)";
          //         }
          //     })
          //     .style("visibility", "visible");

        }
        dfd.resolve();
      }, 0);
      return dfd.promise();
    }

    updateHullPromises = _.map(_.range(hulls.length), updateHull);


    var p = $.when.apply($, updateHullPromises);
    p.then(function() {
      // Remove empty clusters.
      var emptyClusterCount = d3Hulls.length - clusters.length;
      var startIndex = d3Hulls.length - emptyClusterCount;
      for (var i = startIndex; i < d3Hulls.length; i++) {
        hideHull(i);
      }



      if (clusterToShowLineTo >= 0) {
        updateLineToCluster(clusterToShowLineTo);
      } else {
        // Don't need to update if it's a null selection, since updateLineToCluster is called upon deselect.
      }
    });
    p.then(updateHullColors);
  }

  var hullFps = 20;
  var updateHullsThrottled = _.throttle(updateHulls, 1000 / hullFps);

  function updateNodesOnTick(e) {

    // Push nodes toward their designated focus.
    if (e && _.isNumber(e.alpha)) {
      // Force Layout scenario
      var k = speed * e.alpha;
      // if (k <= 0.004) { return; } // save some CPU (and save battery) may stop abruptly if this thresh is too high
      nodes.forEach(function(o) {
        //o.x = o.targetX;
        //o.y = o.targetY;
        if (!o.x) {
          o.x = w / 2;
        }
        if (!o.y) {
          o.y = h / 2;
        }
        o.x += (o.targetX - o.x) * k;
        o.y += (o.targetY - o.y) * k;
        o.x = Math.max(padding, Math.min(w - padding, o.x));
        o.y = Math.max(padding, Math.min(h - padding, o.y));
      });
    } else {
      // move directly to destination scenario (no force)
      nodes.forEach(function(o) {
        o.x = o.targetX;
        o.y = o.targetY;
      });
    }


    main_layer.selectAll(".node")
      .attr("transform", chooseTransformForRoots);



    updateHullsThrottled();
  }
  if (force) {
    force.on("tick", updateNodesOnTick);
  }

  function computeClusterPointerTarget(points_WillBeMutated) {
    var points = points_WillBeMutated;

    // TEMPORARY HACK!
    // reduces the number of points to 3, since the general N code isn't producing good centroids.
    if (points.length > 3) {

      // cache var to reduce closure traversal during sort.
      var cpoy = clusterPointerOriginY;

      // Use only the 3 left-most points, to create an effect where
      // the cluster pointer is not 'reaching too far', but is
      // casually reaching only as far as needed to point to the
      // cluster. This scheme also guarantees that the pointer
      // will point to a location where there are no participant dots.
      points.sort(function(pairA, pairB) {
        var xA = pairA[0];
        var xB = pairB[0];
        var yA = pairA[1];
        var yB = pairB[1];

        var yDistFromPointerOriginA = Math.abs(cpoy - yA);
        var yDistFromPointerOriginB = Math.abs(cpoy - yB);

        // prefer reaching farther in x than y (aesthetic choice)
        // 2x is too much: https://www.dropbox.com/s/us5040qckcl5tzw/Screenshot%202014-07-31%2012.35.02.png
        // multiplication seems wrong, since it affects things more strongly at large x values.
        // trying addition
        yDistFromPointerOriginA += 15;
        yDistFromPointerOriginB += 15;

        // assuming pointer's x origin is 0, if that's not the case, do Math.abs like above for y
        var xDistFromPointerOriginA = xA;
        var xDistFromPointerOriginB = xB;

        var distFromOriginA =
          // Math.sqrt(
          xDistFromPointerOriginA * xDistFromPointerOriginA +
          yDistFromPointerOriginA * yDistFromPointerOriginA
          // ); // Omitting sqrt for perf
        ;

        var distFromOriginB =
          // Math.sqrt(
          xDistFromPointerOriginB * xDistFromPointerOriginB +
          yDistFromPointerOriginB * yDistFromPointerOriginB
          // ); // Omitting sqrt for perf
        ;

        return (distFromOriginA - distFromOriginB);
        // large number is kept
        // currently small x values of A make large values
        //   return xA - xB;
        // we also want small y values (since origin of pointer is upper left corner)
        // (actually, the origin is from roughly [0,40] or something, so to be 100% accurate, we
        // should probably measure closeness to the origin of the pointer)
        // return (2*xA + yDistFromPointerOriginA) - (2*xB + yDistFromPointerOriginB);
      });

      // Choose the top 3 choices.
      // TODO: if the three chosen points make up a narrow triangle,
      // with one point halfway along the long edge, then the pointer
      // will point very near that point. So we might want to consider an alternative point.
      points = points.slice(0, 3);

      // // An workaround alternative that points to somewhere inside the polygon,
      // // but not the centroid, and sometimes reaches to the opposite side,
      // // which is a lousy effect.
      // points = [
      //     points[0],
      //     points[Math.floor(points.length/2)],
      //     points[points.length-1]
      // ];
    }

    var p;
    if (points.length === 3) {
      p = points;
      return {
        x: (p[0][0] + p[1][0] + p[2][0]) / 3,
        y: (p[0][1] + p[1][1] + p[2][1]) / 3
      };
    } else if (points.length === 2) {
      p = points;
      return {
        x: (p[0][0] + p[1][0]) / 2,
        y: (p[0][1] + p[1][1]) / 2
      };
    } else if (points.length === 1) {
      return {
        x: points[0][0],
        y: points[0][1]
      };
    }


    // WARNING: this may be buggy
    // http://en.wikipedia.org/wiki/Centroid#Centroid_of_polygon
    var x = 0;
    var y = 0;
    var area = 0;
    var end = points.length - 1;
    for (var i = 0; i < end; i++) {
      var xi = points[i][0];
      var yi = points[i][1];
      var xi1 = points[i + 1][0];
      var yi1 = points[i + 1][1];
      var foo = (xi * yi1 - xi1 * yi);
      x += (xi + xi1) * foo;
      y += (yi + yi1) * foo;
      area += foo;
    }
    area /= 2;
    x /= (6 * area);
    y /= (6 * area);
    return {
      x: x,
      y: y
    };
  }

  function moveTowardsTarget(x, y, targetX, targetY, dist) {
    // TODO optimize by saving dx,dy,d from distance function
    var dx = targetX - x;
    var dy = targetY - y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var unitX = dx / d;
    var unitY = dy / d;
    dist = Math.min(dist, d); // prevent overshooting the target
    var newX = x + unitX * dist;
    var newY = y + unitY * dist;
    return {
      x: newX,
      y: newY,
      d: d // can be useful
    };
  }

  function chooseDisplayForCircle(d) {
    return "inherit";
  }


  function chooseDisplayForOuterCircle(d) {

    return shouldDisplayOuterCircle(d) ? "inherit" : "none";
  }

  function chooseSummaryLabelFontSize(d) {
    var size;
    if (display.xs()) {
      if (commentIsSelected()) {
        size = 9;
      } else {
        size = 11;
      }
    } else {
      if (commentIsSelected()) {
        size = 11;
      } else {
        size = 13;
      }

    }
    return size + "px";
  }

  function shouldDisplayOuterCircle(d) {
    // Hide the circle so we can show the up/down arrows
    if ((commentIsSelected() &&
        !isSelf(d) && // for now, always show circle - TODO fix up/down arrow for blue dot
        !d.ups &&
        !d.downs) || isSelf(d)) {
      return true;
    }
    return false;
  }


  function shouldDisplayArrows(d) {
    // Hide the circle so we can show the up/down arrows
    if (commentIsSelected()) {
      return true;
    }
    return false;
  }

  function chooseDisplayForArrows(d) {
    return shouldDisplayArrows(d) ? "inherit" : "none";
  }


  function chooseFilter(d) {
    if (!commentIsSelected()) {
      return "";
    }

    // if (d.ups > d.downs) {
    //   return "url(#colorMeMatrixGreen)";
    // } else if (d.downs > d.ups) {
    //   return "url(#colorMeMatrixRed)";
    // } else {
    return "url(#colorMeMatrix)";
    // }
  }

  function chooseDisplayForGrayHalo(d) {
    return "inherit";
    // return !shouldDisplayArrows(d) ? "inherit" : "none";
  }



  function chooseFill(d) {
    if (isParticipantOfInterest(d)) {
      return "rgba(0,0,0,0)";
    } else if (isSelf(d)) {
      return "rgba(0,0,0,0)";
    } else {
      return colorSummaryBlob;
    }
  }


  function clusterIsSelected() {
    return _.isNumber(selectedCluster) && selectedCluster >= 0;
  }

  function commentIsSelected() {
    return _.isNumber(selectedTid) && selectedTid >= 0;
  }

  function chooseTransformForRoots(d) {
    var insetPoint = getInsetTarget(d);
    if (isSummaryBucket(d)) {
      insetPoint.y = insetPoint.y + pinLength;
    }
    return "translate(" + insetPoint.x + "," + insetPoint.y + ")";
  }

  var TAU = Math.PI * 2;
  var pieChartOrigin = 3 / 4 * TAU;

  function chooseUpArrowPath(d) {
    if (!d.ups) {
      return;
    }
    var count = d.seens; //d.clusterCount || d.count;
    var ratio = d.ups / count;
    ratio = Math.min(ratio, 0.99999);

    var r = chooseCircleRadius(d);
    if (isSummaryBucket(d)) {
      r += EXTRA_RADIUS_FOR_SUMMARY_HALO;
    }
    r += haloWidth; // so it's outside the main outline

    var start = pieChartOrigin - (TAU * ratio / 2); //degrees/2;
    var end = pieChartOrigin + (TAU * ratio / 2); // -degrees/2;
    var largeArcFlag = ratio > 0.5 ? 1 : 0;
    return generateWedgeString(0, 0, start, end, r, largeArcFlag, false);
  }


  var generateWedgeString = function(startX, startY, startAngle, endAngle, radius, largeArcFlag, shouldClose) {
    var x1 = startX + radius * Math.cos(startAngle);
    var y1 = startY + radius * Math.sin(startAngle);
    var x2 = startX + radius * Math.cos(endAngle);
    var y2 = startY + radius * Math.sin(endAngle);

    var pathString = "M";
    if (shouldClose) {
      pathString += startX + " " + startY + " L" + x1 + " " + y1;
    } else {
      pathString += x1 + " " + y1;
    }
    var sweepFlag = 1;
    pathString += " A" + radius + " " + radius + " 0 " + largeArcFlag + " " + sweepFlag + " " + x2 + " " + y2;
    if (shouldClose) {
      pathString += " z";
    }
    return pathString;
  };

  function chooseDownArrowPath(d) {
    if (!d.downs) {
      return;
    }

    var count = d.seens; // d.clusterCount || d.count;

    var ratio = d.downs / count;
    ratio = Math.min(ratio, 0.99999);

    var r = chooseCircleRadius(d);
    if (isSummaryBucket(d)) {
      r += EXTRA_RADIUS_FOR_SUMMARY_HALO;
    }
    r += haloWidth; // so it's outside the main outline

    var TAU = Math.PI * 2;
    var start = (pieChartOrigin - Math.PI) - (TAU * ratio / 2); //degrees/2;
    var end = (pieChartOrigin - Math.PI) + (TAU * ratio / 2); // -degrees/2;

    var largeArcFlag = ratio > 0.5 ? 1 : 0;
    return generateWedgeString(0, 0, start, end, r, largeArcFlag, false);


  }


  function getImageWidth(d) {
    if (!d.picture_size) {
      return ptptOiDiameter;
    }
    if (d.picture_size < 0) {
      // -1 used to indicate that the image should be resized (currently used for the anon profile image)
      return ptptOiDiameter;
    }
    var z;
    if (d.picture_size / 2 >= ptptOiDiameter) {
      // check if we can scale down the image by half (scaling by half should reduce scaling blur)
      z = d.picture_size / 2;
    } else {
      // no scaling
      z = Math.max(d.picture_size, ptptOiDiameter);
    }
    return z;
  }


  // TODO this should probably inset along the normal of the lines connecting to the point in the hull.
  function getInsetTarget(d) {
    var gid = bidToGid[d.bid];
    var centroid = centroids[gid];
    if (!centroid) {
      return {
        x: d.x,
        y: d.y
      };
    }
    // var radius = chooseCircleRadiusOuter(d);
    // var inset = moveTowardsTarget(d.x, d.y, centroid.x, centroid.y, radius);
    // // TODO reduce inset as it approaches the target.
    // return inset;
    return {
      x: d.x,
      y: d.y
    };
  }

  function isSummaryBucket(d) {
    return d.isSummaryBucket;
  }

  function chooseCircleRadius(d) {
    if (isSummaryBucket(d)) {
      return anonBlobRadius;
    } else {
      return ptptOiRadius; //bucketRadiusForCount(d.count);
    }
  }

  function chooseCircleRadiusOuter(d) {
    var r = chooseCircleRadius(d);
    if (isSelf(d)) {
      r *= 2;
    }
    if (isParticipantOfInterest(d)) {
      r = ptptOiRadius;
    }
    if (d.isSummaryBucket) {
      r = anonBlobRadius;
    }
    if (hullIdToGid[d.hullId] === getSelectedGid()) {
      r += SELECTED_HULL_RADIUS_BOOST;
    } else {
      r += UNSELECTED_HULL_RADIUS_BOOST;
    }
    return r;
  }


  function isSelf(d) {
    return !!d.containsSelf;
  }

  function isParticipantOfInterest(d) {
    return !!d.ptptoi;
  }


  function key(d) {
    return d.bid;
  }


  // clusters [[2,3,4],[1,5]]
  function upsertNode(updatedNodes, newClusters, newParticipantCount, comments) {



    participantCount = newParticipantCount;

    var MIN_PARTICIPANTS_FOR_VIS = 0;
    if (participantCount < MIN_PARTICIPANTS_FOR_VIS && !visBlockerOn) {
      showVisBlocker();
    } else if (participantCount >= MIN_PARTICIPANTS_FOR_VIS && visBlockerOn) {
      hideVisBlocker();
    }
    if (visBlockerOn) {
      var neededCount = MIN_PARTICIPANTS_FOR_VIS - participantCount;
      blocker_layer.selectAll(".visBlockerMainText")
        .text("Waiting for " + neededCount + " more participants")
        .attr("font-weight", 100)
        .attr("font-family", "brandon-grotesque")
        .attr("font-size", (display.xs() || display.sm()) ? "1.5em" : "28px");

      blocker_layer.selectAll(".visBlockerGraphic")
        .text(function(d) {
          var txt = "";
          _.times(participantCount, function() {
            txt += "\uf007 "; // uf118
          });
          _.times(neededCount, function() {
            txt += "_ ";
          });
          return txt;
        })
        .attr("font-weight", 100)
        .attr("font-size", "30px")
        // .attr("font-family", "brandon-grotesque")
      ;
    }

    var gids = _.map(_.keys(newClusters), Number);
    gids.sort();
    hullIdToGid = gids.slice(0);

    gidToHullId = {};
    for (var id = 0; id < gids.length; id++) {
      gidToHullId[gids[id]] = id;
    }
    clusters = _.map(gids, function(gid) {
      return newClusters[gid].members;
    });
    clusterParticipantTotals = _.map(gids, function(gid) {
      return newClusters[gid]["n-members"];
    });

    for (var c = 0; c < clusters.length; c++) {
      var cluster = clusters[c];
      for (var b = 0; b < cluster.length; b++) {
        bidToGid[cluster[b]] = c;
      }
    }

    function computeTarget(d) {
      //if (!isPersonNode(d)) {
      // If we decide to show the branching points, we could
      // compute their position as the average of their childrens
      // positions, and return that here.
      //return;
      //}

      d.x = d.targetX = scaleX(d.proj.x);
      d.y = d.targetY = scaleY(d.proj.y);
      return d;
    }

    // TODO don't throw this computation away
    var maxCount = 0;
    var biggestNode = null;
    for (var i = 0; i < updatedNodes.length; i++) {
      var node = updatedNodes[i];
      var count = node.count;
      if (count > maxCount) {
        biggestNode = node;
        maxCount = count;
      }
    }
    var minRad = minNodeRadiusScaleForGivenVisWidth(w);
    // var maxRad = maxNodeRadiusScaleForGivenVisWidth(w);
    // bucketRadiusForCount = d3_old.scale.pow().exponent(.5).range([minRad, maxRad]).domain([1, maxCount]).clamp(true);

    var baseSquared = minRad * minRad;
    bucketRadiusForCount = function(count) {
      // 1 -> area of 25, rad of 5
      // 2 -> area of 50, rad of ~7
      // sqrt(base**2 * count)
      return Math.sqrt(baseSquared * count);
    };
    // var maxRad = bucketRadiusForCount(maxCount);

    function createScales(updatedNodes) {
      var spans = computeXySpans(updatedNodes);
      var border = padding; // this fudge factor has to account for the extra padding needed for the hulls
      return {
        x: d3_old.scale.linear().range([0 + border, w - border]).domain([spans.x.min - eps, spans.x.max + eps]),
        y: d3_old.scale.linear().range([0 + border, h - border]).domain([spans.y.min - eps, spans.y.max + eps])
      };
    }
    // TODO pass all nodes, not just updated nodes, to createScales.
    var scales = createScales(updatedNodes);
    var scaleX = scales.x;
    var scaleY = scales.y;

    comments = comments.map(function(c) {
      c.target = {
        x: scaleX(-2 * c.proj.x),
        y: scaleY(-1 * c.proj.y)
      };
      return c;
    });

    var oldpositions = nodes.map(function(node) {
      return {
        x: node.x,
        y: node.y,
        bid: node.bid
      };
    });

    function sortWithSelfOnTop(a, b) {
      if (isSelf(a)) {
        return Infinity;
      }
      if (isSelf(b)) {
        return -Infinity;
      }
      if (isSummaryBucket(a)) {
        return 999999;
      }
      if (isSummaryBucket(b)) {
        return -999999;
      }
      if (b.twitter.followers_count > a.twitter.followers_count) {
        return -1;
      }
      if (a.twitter.followers_count > b.twitter.followers_count) {
        return 1;
      }
      if (b.priority > a.priority) {
        return -1;
      }

      if (a.priority > b.priority) {
        return 1;
      }
      return 0;
    }

    var bidToOldNode = _.indexBy(nodes, getBid);

    (function() {
      for (var i = 0; i < updatedNodes.length; i++) {
        var node = updatedNodes[i];
        var oldNode = bidToOldNode[node.bid];
        if (oldNode) {
          node.effects = oldNode.effects;
        }
      }
    }());



    nodes = updatedNodes.sort(sortWithSelfOnTop).map(computeTarget);
    var niceIndex = Math.floor(nodes.length / 4);
    if (isSelf(nodes[niceIndex])) {
      // don't point to self
      niceIndex += 1;
    }
    if (niceIndex < nodes.length) {
      nodes[niceIndex].isChosenNodeForInVisLegend = true; // TODO find it
      var nice = nodes.splice(niceIndex, 1);
      nodes.push(nice[0]);
    }

    oldpositions.forEach(function(oldNode) {
      var newNode = _.findWhere(nodes, {
        bid: oldNode.bid
      });
      if (!newNode) {
        console.warn("not sure why a node would disappear");
        return;
      }
      newNode.x = oldNode.x;
      newNode.y = oldNode.y;
    });


    force.nodes(nodes, key).start();

    // TODO use key to guarantee unique items


    main_layer.selectAll(".node")
      .attr("visibility", function(d) {
        return (d.count >= 1) ? "visbile" : "hidden";
      });

    var update = main_layer.selectAll(".ptpt")
      .data(nodes, key)
      .sort(sortWithSelfOnTop);

    var exit = update.exit();
    exit.remove();

    // ENTER
    var enter = update.enter();
    var g = enter
      .append(groupTag)
      .classed("ptpt", true)
      .classed("node", true)
      .attr("data-bid", function(d) {
        return d.bid;
      })
      .on("click", onParticipantClicked)
      .on("mouseover", showTip)
      .on("mouseout", hideTip)
      // .call(force.drag)
    ;


    var pinEnter = g.filter(isParticipantOfInterest);
    pinEnter
      .append("line")
      .classed("pin", true)
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", 0)
      .attr("y2", pinLength)
      .attr("stroke-linecap", "round")
      .attr("stroke", "rgb(160,160,160)")
      .attr("stroke-width", function(d) {
        return "1px";
      });
    pinEnter
      .append("circle")
      .attr("r", function(d) {
        if (display.xs()) {
          return 1;
        } else {
          return 2;
        }
      })
      .attr("cx", 0)
      .attr("cy", pinLength)
      .attr("fill", "rgb(160,160,160)");

    if (Utils.projectComments) {
      var foo = main_layer.selectAll(".c").data(comments);
      var commentWidth = 2;
      var commentWidthHalf = commentWidth / 2;
      var bar = foo.enter()
        .append("rect")
        .attr("x", function(d) {
          return d.target.x - commentWidthHalf;
        })
        .attr("y", function(d) {
          return d.target.y - commentWidthHalf;
        })
        .attr("width", commentWidth)
        .attr("height", commentWidth)
        .style("stroke", "darkgray")
        .style("fill", "darkgray");
      if (Utils.debugCommentProjection) {
        bar.on("mouseover", showTip);
        bar.on("mouseout", hideTip);
      }
    }

    // OUTER TRANSLUCENT SHAPES
    var opacityOuter = 0.2;
    g.append("polygon") // upArrowEnter
      .classed("up", true)
      .classed("bktv", true)
      .style("fill", colorPull)
      .style("fill-opacity", opacityOuter)
      // .style("stroke", colorPullOutline)
      // .style("stroke-width", 1)
    ;
    g.append("polygon") // downArrowEnter
      .classed("down", true)
      .classed("bktv", true)
      .style("fill", colorPush)
      .style("fill-opacity", opacityOuter)
      // .style("stroke", colorPushOutline)
      // .style("stroke-width", 1)
    ;
    var picEnter = g.append("image");
    picEnter
    // .classed("circle", true)
      .classed("bktv", true)
      .attr("x", function(d) {
        return getImageWidth(d) * -0.5;
      })
      .attr("y", function(d) {
        return getImageWidth(d) * -0.5;
      })
      .attr("filter", "")
      // .style("visibility", "hidden")
      .attr("height", getImageWidth)
      .attr("width", getImageWidth)
      .attr("clip-path", "url(#clipCircle)")
      .attr("xlink:href", function(d) {
        return d.pic;
      })
    ;


    var grayHaloEnter = g.append("circle");
    grayHaloEnter
      .classed("grayHalo", true)
      .attr("cx", 0)
      .attr("cy", 0)
      .classed("ptptoi", isParticipantOfInterest)
      .attr("r", function(d) {
        if (isSummaryBucket(d)) {
          return anonBlobRadius;
        }
        if (isParticipantOfInterest(d)) {
          return ptptOiRadius;
        }
        // if (isSelf(d)) {
        //     return ptptOiRadius;
        // }
        return ptptOiRadius;
      })
      .attr("stroke", grayHaloColor)
      .attr("stroke-width", function(d) {
        if (d.isSummaryBucket) {
          return 0;
        } else if (isSelf(d)) {
          return 3;
        } else {
          return haloWidth;
        }
      })
      .attr("fill", "rgba(0,0,0,0)");


    var beaconEnter = g.append("circle");
    beaconEnter
      .classed("beacon", true)
      .attr("cx", 0)
      .attr("cy", 0)
      .classed("ptptoi", isParticipantOfInterest)
      .attr("r", 0)
      .attr("stroke-width", 10)
      .attr("fill", "rgba(0,0,0,0)")
      .attr("opacity", 0)
      .attr("display", "none");



    // INNER SCALE-CHANGING SHAPES
    g.append("path")  // upArrowEnterInner
      .classed("up", true)
      .classed("bktvi", true)
      .style("fill", "rgba(0,0,0,0)")
      .attr("stroke-width", function(d) {
        if (isSummaryBucket(d)) {
          return anonBlobHaloVoteWidth;
        } else {
          return haloVoteWidth;
        }
      })
      .style("stroke", colorPull)
      .style("opacity", 0.8);

    g.append("path") // downArrowEnterInner
      .classed("down", true)
      .classed("bktvi", true)
      .style("fill", "rgba(0,0,0,0)")
      .attr("stroke-width", function(d) {
        if (d.isSummaryBucket) {
          return anonBlobHaloVoteWidth;
        } else {
          return haloVoteWidth;
        }
      })
      .style("stroke", colorPush)
      .style("opacity", 0.8);

    var self = g.filter(isSelf);
    self.classed("selfDot", true);



    var edgeLengthToMatchCircleRadius = Math.sqrt(1 / 2) * ptptOiDiameter / 2;
    var socialIconScale = ptptOiDiameter / 2 / maxPtptoiRad * 0.8;
    if (retina) {
      socialIconScale *= 0.8;
    } else {
      socialIconScale *= 1.1;
    }
    var socialRoot = g.filter(isParticipantOfInterest).append("g");
    socialRoot.attr("transform", "translate(" + edgeLengthToMatchCircleRadius + "," + edgeLengthToMatchCircleRadius + ")");

    socialRoot.append("circle")
      .style("fill", function(d) {
        if (d.hasFacebook) {
          return "#3A5795";
        } else if (d.hasTwitter) {
          return "#55acee";
        } else {
          return "rgba(0,0,0,0)";
        }

      })
      .attr("cx", 0)
      .attr("cy", 0)
      .attr("r", ptptOiDiameter / 6)
      // .classed("hideWhenGroupSelected", true)
    ;

    var socialIconRoot = socialRoot.append("g");
    socialIconRoot.attr("transform", "scale(" + socialIconScale + "," + socialIconScale + ")");
    socialIconRoot.append("g")
    .attr("transform", function(d) {
        if (d.hasFacebook) {
          return "translate(" + (retina ? "-19,15" : "-19,15") + ") scale(.0065, -0.0065)";

        } else if (d.hasTwitter) {
          return "translate(" + (retina ? "-7,-7" : "-7,-7") + ") scale(0.015,0.015)";
        }
      })
      .append("path")
      .style("visibility", function(d) {
        return (d.hasFacebook || d.hasTwitter) ? "visible" : "hidden";
      })
      .style("fill", "white")
      .attr("d", function(d) {
        if (d.hasFacebook) {
          return "m 3179.0313,3471.2813 c 147.3,0 273.8408,-10.85 310.7504,-15.75 l 0,-360.25 -213.2496,-0.25 c -167.24,0 -199.5008,-79.38 -199.5008,-196 l 0,-257.25 398.7504,0 -52,-402.75 -346.7504,0 0,-1033.5 -415.9996,0 0,1033.5 -347.75,0 0,402.75 347.75,0 0,297 c 0,344.73 210.47,532.5 517.9996,532.5 z";
        } else if (d.hasTwitter) {
          return "d", "M0 781.864q0 7.32 7.32 13.176 12.2 8.296 43.432 24.4 119.072 61.488 249.856 61.488 162.992 0 296.216 -83.936 63.44 -40.016 112.728 -96.38t78.324 -117.608 43.432 -122.732 13.42 -119.56v-17.08q57.096 -40.992 89.304 -93.696 2.928 -5.856 2.928 -8.784 0 -6.344 -4.88 -11.224t-11.224 -4.88q-3.416 0 -11.712 3.904 -5.856 1.952 -14.396 4.88t-14.64 5.124 -8.052 2.684q12.688 -14.152 26.352 -38.308t13.664 -35.38q0 -6.344 -4.88 -10.98t-11.712 -4.636q-3.904 0 -7.808 2.44 -55.632 29.768 -103.944 40.504 -59.048 -56.12 -141.032 -56.12 -83.936 0 -142.984 58.56t-59.048 141.52q0 14.64 1.952 23.912 -82.472 -6.832 -159.088 -39.528t-137.616 -87.84q-14.152 -13.664 -54.656 -57.096 -5.856 -5.856 -13.664 -5.856 -5.856 0 -12.2 7.808 -12.688 19.032 -20.008 46.604t-7.32 53.924q0 72.712 45.384 126.88l-14.152 -6.832q-12.2 -5.368 -18.056 -5.368 -8.296 0 -13.908 4.88t-5.612 12.688q0 51.24 26.352 97.112t71.248 73.2l-5.856 -.976q-.976 0 -2.684 -.488t-2.684 -.732 -1.464 -.244q-6.344 0 -10.98 4.88t-4.636 10.736q0 .488 .976 5.368 16.592 50.752 55.144 86.132t90.28 47.58q-84.912 52.216 -187.392 52.216 -6.832 0 -21.96 -1.464 -20.496 -.976 -22.448 -.976 -6.344 0 -10.98 4.88t-4.636 11.224z";
        }
      })
    ;


    var labelG = g.filter(isSummaryBucket)
      .append("g");

    labelG.append("path")
      .style("fill", "gray")
      .attr("transform", "translate(-18,-8) scale(.008, 0.008)")
      .attr("d", function(d) {
        return "M529 896q-162 5-265 128h-134q-82 0-138-40.5t-56-118.5q0-353 124-353 6 0 43.5 21t97.5 42.5 119 21.5q67 0 133-23-5 37-5 66 0 139 81 256zm1071 637q0 120-73 189.5t-194 69.5h-874q-121 0-194-69.5t-73-189.5q0-53 3.5-103.5t14-109 26.5-108.5 43-97.5 62-81 85.5-53.5 111.5-20q10 0 43 21.5t73 48 107 48 135 21.5 135-21.5 107-48 73-48 43-21.5q61 0 111.5 20t85.5 53.5 62 81 43 97.5 26.5 108.5 14 109 3.5 103.5zm-1024-1277q0 106-75 181t-181 75-181-75-75-181 75-181 181-75 181 75 75 181zm704 384q0 159-112.5 271.5t-271.5 112.5-271.5-112.5-112.5-271.5 112.5-271.5 271.5-112.5 271.5 112.5 112.5 271.5zm576 225q0 78-56 118.5t-138 40.5h-134q-103-123-265-128 81-117 81-256 0-29-5-66 66 23 133 23 59 0 119-21.5t97.5-42.5 43.5-21q124 0 124 353zm-128-609q0 106-75 181t-181 75-181-75-75-181 75-181 181-75 181 75 75 181z";
      });

    labelG
      .append("text")
      .classed("summaryLabel", true)
      .text(function(d) {
        return getGroupNameForGid(d.gid);
      })
      .style("font-family", "Helvetica, sans-serif") // Tahoma, Helvetica, sans-serif For the "AGREED"/"DISAGREED" label: Tahoma should be good at small sizes http://ux.stackexchange.com/questions/3330/what-is-the-best-font-for-extremely-limited-space-i-e-will-fit-the-most-readab
      .style("font-size", chooseSummaryLabelFontSize)
      .attr("text-anchor", "left")
      .attr("alignment-baseline", "middle")
      .attr("fill", "rgba(0,0,0,0.5)")
      // });
    ;

    updateNodes();

    updateHulls();

    if (commentIsSelected()) {
      selectComment(selectedTid);
    }

    firstShowDeferred.resolve();

  } // END upsertNode

  function isNotSelf(d) {
    return !isSelf(d);
  }

  function showHintOthers() {
    dotsShouldWiggle = true;
    wiggleUp();
  }

  function hideHintOthers() {
    dotsShouldWiggle = false;
  }

  function hideHintYou() {
    // TODO
  }

  function showHintYou() {

    var g = visualization.selectAll(".node");

    var selfNode = g.filter(isSelf);
    selfNode.append("text")
      .classed("help", true)
      .classed("help_text_you", true)
      .text("You")
      .attr("text-anchor", "start")
      // .attr("fill", "rgba(0,0,0,1.0)")
      .attr("fill", colorSelf)
      .attr("stroke", colorSelfOutline)
      .attr("transform", function(d) {
        return "translate(12, 6)";
      });
  }

  var dotsShouldWiggle = false;

  function wiggleUp() {
    if (!dotsShouldWiggle) {
      return;
    }

    var dfd = $.Deferred();
    dfd.done(wiggleDown);
    var dfdDown = $.Deferred();
    dfdDown.done(wiggleUp);
    var update = visualization.selectAll(".node");
    var circleUpdateInner = update.selectAll(".circle.bktvi");
    circleUpdateInner
      .filter(isNotSelf)
      .transition()
      .style("stroke-width", "2px") // NOTE: using tranform to select the scale
      .style("stroke", "#777") // NOTE: using tranform to select the scale
      .duration(500)
      .each("end", dfd.resolve);

    function wiggleDown() {
      circleUpdateInner
        .filter(isNotSelf)
        .transition()
        .style("stroke-width", "0px") // NOTE: using tranform to select the scale
        .style("stroke", "#777") // NOTE: using tranform to select the scale
        .duration(500)
        .each("end", dfdDown.resolve);
      // dfd.resolve();
    }
  }

  function selectComment(tid) {
    if (!_.isNumber(tid)) {
      resetSelectedComment();
      unhoverAll();
      return;
    }
    selectedTid = tid;

    getReactionsToComment(tid)
      // .done(unhoverAll)
      .then(function(votes) {
        for (i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          node.ups = votes.A[node.bid] || 0;
          node.downs = votes.D[node.bid] || 0;
          node.seens = votes.S[node.bid] || 0;
          node.gid = bidToGid[node.bid];

        }
        updateNodes();
      }, function() {
        console.error("failed to get reactions to comment: " + d.tid);
      });
  }

  function clickingPtptoiOpensProfile() {
    return true;
    // return !isMobile;
  }

  function onParticipantClicked(d) {
    if (clickingPtptoiOpensProfile()) {
      // NOTE: it may be hard to tap a hull without accidentally
      // tapping a ptptoi on mobile, so disabling on mobile for now.
      if (d.twitter && d.twitter.screen_name) {
        window.open("https://twitter.com/" + d.twitter.screen_name);
        return;
      }
      if (d.facebook && d.facebook.fb_link) {
        window.open(d.facebook.fb_link);
        return;
      }
    }
    var gid = bidToGid[d.bid];
    if (_.isNumber(gid)) {
      var hullId = gidToHullId[gid];
      handleOnClusterClicked(hullId);
    }
  }

  function unhoverAll() {
    updateNodes();
  }

  function updateNodes() {
    setTimeout(doUpdateNodes, 0);
  }


  function doUpdateNodes() {

    var update = visualization.selectAll(".node");

    update.selectAll(".up.bktvi").data(nodes, key) // upArrowUpdateInner
      .style("display", chooseDisplayForArrows)
      .attr("d", chooseUpArrowPath) // NOTE: using tranform to select the scale
    ;

    update.selectAll("image.bktv").data(nodes, key) // imageUpdate
      .attr("filter", chooseFilter);

    update.selectAll(".down.bktvi").data(nodes, key) // downArrowUpdateInner
      .style("display", chooseDisplayForArrows)
      .attr("d", chooseDownArrowPath) // NOTE: using tranform to select the scale
    ;
    update.selectAll(".grayHalo").data(nodes, key) // grayHaloUpdate
      .style("display", chooseDisplayForGrayHalo);

    if (clusterIsSelected()) {
      update.selectAll(".hideWhenGroupSelected").style("visibility", "hidden");
    } else {
      update.selectAll(".hideWhenGroupSelected").style("visibility", "visible");
    }

    update.selectAll(".grayHalo")
      .style("stroke", function(d) {
        if (isSelf(d)) {
          if (clusterIsSelected() || onMajorityTab) {
            if (d.ups || d.downs) {
              return grayHaloColorSelected;
            } else {
              return grayHaloColor; // returning this (instead of rgba(0,0,0,0)) since other halos will have this gray foundation behind a translucent red/green
            }
          } else {
            return colorSelf;
          }
        } else {
          if (clusterIsSelected()) {
            if (isParticipantOfInterest(d)) {
              if (d.ups || d.downs) {
                return grayHaloColorSelected;
              } else {
                return grayHaloColor; // returning this (instead of rgba(0,0,0,0)) since other halos will have this gray foundation behind a translucent red/green
              }
            } else {
              return grayHaloColorSelected; // returning this (instead of rgba(0,0,0,0)) since other halos will have this gray foundation behind a translucent red/green
            }
          } else {
            return grayHaloColor;
          }
        }
      });


    update.selectAll(".summaryLabel")
      .style("font-size", chooseSummaryLabelFontSize);


    update.selectAll(".circle.bktv").data(nodes, key) // circleUpdate
      .style("display", chooseDisplayForOuterCircle)
      .attr("r", chooseCircleRadiusOuter)
      .style("fill", chooseFill)
      .style("fill-opacity", 0.5)
      .filter(isSelf)
      .style("display", chooseDisplayForCircle)
      .style("fill-opacity", 0)
      .attr("r", chooseCircleRadiusOuter)
      // .style("fill", chooseFill)
    ;
    update.selectAll(".circle.bktvi").data(nodes, key) // circleUpdateInner
      .style("display", chooseDisplayForCircle)
      .attr("r", chooseCircleRadius) // NOTE: using tranform to select the scale
    ;

    var selfNode = _.filter(nodes, isSelf)[0];
    if (selfNode && !selfHasAppeared) {
      selfHasAppeared = true;
      onSelfAppearsCallbacks.fire();

      setupBlueDotHelpText(update.select(".selfDot"));
    }
  }

  function resetSelectedComment() {
    selectedTid = -1;
  }

  function resetSelection() {
    visualization.selectAll(".active_group").classed("active_group", false);
    selectedCluster = -1;
    eb.trigger(eb.clusterSelectionChanged, selectedCluster);
  }


  function selectBackground() {

    selectComment(null);

    if (clusterIsSelected()) {
      resetSelection();
      setClusterActive(-1)
        .then(
          updateHulls,
          updateHulls);

      updateHullColors();
    }
    exitTutorial();
  }

  var visBlockerOn = false;

  function showVisBlocker() {
    visBlockerOn = true;

    blocker_layer.append("rect")
      .classed("visBlocker", true)
      .style("fill", "#f7f7f7")
      .attr("x", 1) // inset so it doesn't get cut off on firefox
      .attr("y", 1) // inset so it doesn't get cut off on firefox
      .attr("width", w - 2) // inset so it doesn't get cut off on firefox
      .attr("height", h - 2) // inset so it doesn't get cut off on firefox
      // .style("stroke", "lightgray")
      .attr("rx", 5)
      .attr("ry", 5);
    blocker_layer.append("text")
      .classed("visBlocker", true)
      .classed("visBlockerMainText", true)
      .attr("text-anchor", "middle")
      .attr("fill", "#black")
      .attr("transform", "translate(" +
        w / 2 +
        "," + (9 * h / 24) + ")");
    blocker_layer.append("text")
      .classed("visBlocker", true)
      .classed("visBlockerGraphic", true)
      .attr("transform", "translate(" +
        w / 2 +
        "," + (15 * h / 24) + ")")
      .attr("text-anchor", "middle")
      .attr("fill", "#black")
      .attr('font-family', 'FontAwesome')
      .attr('font-size', function(d) {
        return '2em';
      });

  }

  function hideVisBlocker() {
    visBlockerOn = false;

    blocker_layer.selectAll(".visBlocker")
      .remove();
  }


  // TODO account for Buckets
  function emphasizeParticipants(pids) {
    console.log("pids", pids.length);
    var hash = []; // sparse-ish array
    getPidToBidMapping().then(function(o) {
      var pidToBid = o.p2b;
      var bidToPids = o.b2p;
      //bid = o.bid;

      for (var i = 0; i < pids.length; i++) {
        var bid = pidToBid[pids[i]];
        hash[bid] |= 0; // init
        hash[bid] += 1; // count the person
      }


      function chooseTransformSubset(d) {
        var bid = d.bid;
        var ppl = bidToPids[bid];
        var total = ppl ? ppl.length : 0;
        var active = hash[bid] || 0;
        var ratio = active / total;
        if (ratio > 0.99) {
          return;
        } else {
          return "scale(" + ratio + ")";
        }
      }

      visualization.selectAll(".bktvi")
        .attr("transform", chooseTransformSubset)
      ;
    });
  }


  function dist(start, b) {
    var dx = start[0] - b[0];

    var dy = start[1] - b[1];

    // // https://www.google.com/search?q=x*x&oq=x*x&aqs=chrome..69i57j69i65l3j0l2.1404j0j7&sourceid=chrome&es_sm=91&ie=UTF-8#q=1+%2B+-5%5E(-((x-30)%5E2)%2F(2*8%5E2)
    // var penaltyY = 10 * (1 + -5^(-((dy-30)^2)/(2*8^2)));
    // dy += penaltyY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function distWithNonSquarePenalty(start, b) {
    var dx = start[0] - b[0];

    var dy = start[1] - b[1];

    dy *= 1.5;
    if (b[2] === "preferred") {
      // this is a special preferred point
      dx *= 0.9;
      dy *= 0.9;
    }
    // var difference = Math.abs(dx - dy);
    var difference = 0;
    // // https://www.google.com/search?q=x*x&oq=x*x&aqs=chrome..69i57j69i65l3j0l2.1404j0j7&sourceid=chrome&es_sm=91&ie=UTF-8#q=1+%2B+-5%5E(-((x-30)%5E2)%2F(2*8%5E2)
    // var penaltyY = 10 * (1 + -5^(-((dy-30)^2)/(2*8^2)));
    // dy += penaltyY;
    return Math.sqrt(dx * dx + dy * dy + difference * difference);
  }


  function subdivideLongEdges(originalPoints, minLengthForSubdivision) {
    var points = [];
    for (var i = 0; i < originalPoints.length; i++) {
      var p1 = originalPoints[i];
      points.push(p1);
      var p2 = originalPoints[i + 1];
      var pushP2 = true;
      if (!p2) {
        p2 = originalPoints[0];
        pushP2 = false;
      }
      var len = dist(p1, p2);
      if (len > minLengthForSubdivision) {
        points.push([
          (p1[0] + p2[0]) / 2,
          (p1[1] + p2[1]) / 2,
          "preferred" // add a third item to flag these as preferable
        ]);
      }
      if (pushP2) {
        points.push(p2);
      }
    }
    return points;
  }


  function nearestPointOnCluster(gid, start) {
    var hull = hullPoints[gid];
    if (!hull) {
      return null;
    }
    hull = subdivideLongEdges(hull, 20);
    // hull = subdivideLongEdges(hull, 20);
    // hull = subdivideLongEdges(hull, 20);

    var distances = hull.map(function(pt) {
      return {
        dist: distWithNonSquarePenalty(start, pt),
        pt: pt
      };
    });
    distances.sort(function(a, b) {
      return a.dist - b.dist;
    });
    return distances[0].pt;
  }

  // MAke the help item's arrow a child of the elementToPointAt, and update its points to be from 0,0 to

  var clusterToShowLineTo = -1;
  var USE_CLUSTER_POINTING_LINE = false;

  function showLineToCluster(gid) {
    if (USE_CLUSTER_POINTING_LINE) {
      clusterToShowLineTo = gid;
      updateLineToCluster(gid);
    }
  }

  function updateLineToCluster(gid) {
    if (navigator.userAgent.match(/MSIE 10/)) {
      return;
    }

    var startX = clusterPointerFromBottom ? w / 10 : -2;
    var start = [startX, clusterPointerOriginY];
    var center = nearestPointOnCluster(gid, start);
    if (clusterPointerFromBottom && center && center[0] < w / 3) {
      startX = 4 * w / 5;
      start = [startX, clusterPointerOriginY];
      center = nearestPointOnCluster(gid, start);
    }

    if (!center) {
      overlay_layer.selectAll(".helpArrow")
        .style("display", "none");
      return;
    }
    center[0] += xOffset;

    // account for stroke width on hulls
    center[0] = center[0] - 2;

    var centerPointOnX = 1 / 2;

    var centerY = clusterPointerFromBottom ? center[1] : clusterPointerOriginY; // decides if the curve is concave/convex
    helpLine.interpolate("basis");
    helpArrowPoints.splice(0); // clear
    helpArrowPoints.push(start);
    helpArrowPoints.push([(startX + center[0]) * centerPointOnX, centerY]); // midpoint on x, same as origin on y
    helpArrowPoints.push(center);

    // center = center.join(",");
    overlay_layer.selectAll(".helpArrow")
      .style("display", "block")
      .style("stroke-dasharray", "5,5")
      // .attr("marker-end", "url(#ArrowTip)")
      //// .attr("marker-start", "url(#ArrowTip)")
      //// .attr("points", ["-2," + clusterPointerOriginY, center].join(" "));
      .attr("d", helpLine);
  }

  function setupBlueDotHelpText(self) {
    if (SELF_DOT_SHOW_INITIALLY) {
      selfDotTooltipShow = false; // no tooltip

      var txt = self.append("text")
        .text(selfDotHintText)
        .attr("text-anchor", "middle")
        .attr("transform", "translate(0, -10)");
      if (SELF_DOT_HINT_HIDE_AFTER_DELAY) {
        txt.transition(200)
          .delay(SELF_DOT_HINT_HIDE_AFTER_DELAY)
          .style("opacity", 0)
          .each("end", function() {
            selfDotTooltipShow = true;
            // need to remove the tooltip so it doesn't eat hover events
            d3_old.select(this).remove();
          });
      }
    }
  }


  eb.on(eb.vote, function(voteType) {
    var color = colorPass;
    if (voteType === "agree") {
      color = colorPull;
    }
    if (voteType === "disagree") {
      color = colorPush;
    }

    var update = visualization.selectAll(".node").filter(isSelf);
    update
      .selectAll(".beacon")
      .attr("stroke", color)
      .attr("r", 0)
      .attr("opacity", 0.8)
      .attr("display", "block")
      .transition(1000)
      .attr("r", 50)
      .attr("opacity", 0)
      .transition(10)
      .attr("r", 0)
      .attr("opacity", 0)
      .attr("display", "none");
  });

  function getSelectedGid() {
    return selectedCluster;
  }

  function selectGroup(gid, silent) {
    var hullId = gidToHullId[gid];
    handleOnClusterClicked(hullId, silent);
  }

  function getFirstShowDeferred() {
    return firstShowDeferred;
  }
  return {
    upsertNode: upsertNode,
    onSelfAppears: onSelfAppearsCallbacks.add,
    deselect: selectBackground,
    selectComment: selectComment,
    selectGroup: selectGroup,
    showLineToCluster: showLineToCluster,
    emphasizeParticipants: emphasizeParticipants,
    showHintOthers: showHintOthers,
    hideHintOthers: hideHintOthers,
    showHintYou: showHintYou,
    hideHintYou: hideHintYou,
    getSelectedGid: getSelectedGid,
    getFirstShowDeferred: getFirstShowDeferred,
    showAllClustersAsActive: showAllClustersAsActive,
  };

};
