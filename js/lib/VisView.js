var eb = require("../eventBus");
var owl = require("owl");
var display = require("../util/display");
var Raphael = require("raphael");
var Utils = require("../util/utils");
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var VisView = function(params){

var el_selector = params.el;
var el_queryResultSelector = params.el_queryResultSelector;
var el_raphaelSelector = params.el_raphaelSelector;
var getReactionsToComment = params.getReactionsToComment;
var computeXySpans = params.computeXySpans;
var getPidToBidMapping = params.getPidToBidMapping;
var groupInfo = params.groupInfo;
var commentsCollection = params.commentsCollection;
var isIE8 = params.isIE8;
var isMobile = params.isMobile;
var xOffset = params.xOffset || 0;

var dimensions = {
    width: params.w,
    height: params.h
};

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
var d3HullShadows;
var hullPoints = [];

var selectedCluster = -1;
var selectedBids = [];
var selectedTid = -1;

var eps = 0.000000001;
var SELECT_GLOBAL_CONSENSUS_WHEN_NO_HULL_SELECTED = false;

var COLOR_SELECTED_HULL = true;
var EXTRA_RADIUS_FOR_HALO_PIE = 2;
var EXTRA_RADIUS_FOR_SUMMARY_HALO = 2;
var SELECTED_HULL_RADIUS_BOOST = 3;
var UNSELECTED_HULL_RADIUS_BOOST = -1;

var width = $(el_raphaelSelector).width();

// var ptptOiRadius = d3.scale.linear().range([10, 16]).domain([350, 800]).clamp(true)(width);
var retina = window.devicePixelRatio > 1;
var ptptOiRadius = retina ? 12 : 20; // go smaller on retina, the image should be higher res
if (isMobile) {
    ptptOiRadius = 9;
}
ptptOiRadius += d3.scale.linear().range([0, 8]).domain([350, 800]).clamp(true)(width);

var friendOrFolloweeRadius = ptptOiRadius + 2;

var haloWidth = d3.scale.linear().range([2, 4]).domain([350, 800]).clamp(true)(width);
var haloVoteWidth = d3.scale.linear().range([2, 5]).domain([350, 800]).clamp(true)(width);
var anonBlobRadius = isMobile ? 18 : 24;
var anonBlobHaloWidth = d3.scale.linear().range([3, 6]).domain([350, 800]).clamp(true)(width);
var anonBlobHaloVoteWidth = anonBlobHaloWidth; //d3.scale.linear().range([6, 10]).domain([350, 800]).clamp(true)(width);
var maxRad = _.max([
    ptptOiRadius + haloWidth, // not sure if halowidth should be /2
    ptptOiRadius + haloVoteWidth, // not sure if haloVoteWidth should be /2
    anonBlobRadius + anonBlobHaloWidth,  // not sure if anonBlobHaloWidth should be /2
    anonBlobRadius + anonBlobHaloVoteWidth  // not sure if anonBlobHaloVoteWidth should be /2
]);


// framerate can be low on mobile, so make it quick
var speed = d3.scale.linear().range([0.8, 0.1]).domain([350, 800]).clamp(true)(width);


var bidToGid = {};
var bidToBucket = {};

var SELF_DOT_SHOW_INITIALLY = true;
var selfDotTooltipShow = !SELF_DOT_SHOW_INITIALLY;
var SELF_DOT_HINT_HIDE_AFTER_DELAY = 10*1000;
var selfDotHintText = "you";

// if (isIE8) {
//     $(el_selector).html(
//         "<div class='visualization' style='width:100%;height:100%;'><center>" +
//         "Apologies, the visualization is not available on IE 8.</br>" +
//         "Get the full experience on IE 10+, Chrome, Firefox, or on your iOS / Android browser.</br>" +
//         "</center></div>");
//     return {
//         upsertNode: function() {},
//         emphasizeParticipants: function() {}
//     };
// }

// Tunables

var minNodeRadiusScaleForGivenVisWidth = d3.scale.linear().range([2, 4]).domain([350, 800]).clamp(true);
var maxNodeRadiusScaleForGivenVisWidth = d3.scale.linear().range([10, 20]).domain([350, 800]).clamp(true);
var chargeForGivenVisWidth = d3.scale.linear().range([-1, -10]).domain([350, 800]).clamp(true);
var strokeWidthGivenVisWidth = d3.scale.linear().range([0.2, 1.0]).domain([350, 800]).clamp(true);
var hullStrokeWidthGivenVisWidth = d3.scale.linear().range([6, 16]).domain([350, 800]).clamp(true);

var grayHaloColor = "lightgray";
var grayHaloColorSelected = "rgba(0,0,0,0)";
var colorPull = "rgb(0, 181, 77)"; // EMERALD
var colorPullLabel = "rgb(0, 181, 77)";
var colorPush = "#e74c3c";// ALIZARIN
var colorPushLabel = "rgb(224,102,102)";
var colorSummaryBlob = "#F9F9F9";
window.color = function() {
    // colorPull = "rgb(0, 214, 195)";
    colorPull = "rgb(0, 182, 214)";
    colorPullLabel = "#6d9eeb";
    colorPush = "rgb(234, 77, 30)";

    var update = visualization.selectAll(".node");
    update.selectAll(".up.bktvi").style("stroke", colorPull);
    update.selectAll(".down.bktvi").style("stroke", colorPush);
}

var colorPass = "#bbb"; //#BDC3C7"; // SILVER
var colorSelf = "rgb(0, 186, 255)"; // blue - like the 'you are here' in mapping software
var colorNoVote = colorPass;
// var colorSelfOutline = d3.rgb(colorSelf).darker().toString();
// var colorPullOutline = d3.rgb(colorPull).darker().toString();
// var colorPushOutline = d3.rgb(colorPush).darker().toString();
var colorSelfOutline = "rgba(0, 0, 245, 0.25)";

// Cached results of tunalbes - set during init
var strokeWidth;
// Since initialize is called on resize, clear the old vis before setting up the new one.
$(el_selector + " > .visualization").remove();

/* d3-tip === d3 tooltips... [[$ bower install --save d3-tip]] api docs avail at https://github.com/Caged/d3-tip */
var tip = null;
var SHOW_TIP = true;
var tipPreviousTarget = null; // Sorry God!
if (SHOW_TIP && !isIE8) {
    $("#ptpt-tip").remove();
    tip = d3.tip().attr("id", "ptpt-tip").attr("stroke", "rgb(52,73,94)").html(
        function(d) {
            return d.tid;
        }
    );
}
function showTip() {
    if (tip) {
        tip.show.apply(tip, arguments);
    }
}
function hideTip() {
    if (tip) {
        tip.hide.apply(tip, arguments);
    }
}

var onAnalyzeTab = false;
eb.on("aftershow:analyze", function() {
    console.log("aftershow:analyze");
    onAnalyzeTab = true;
});
eb.on("beforehide:analyze", function() {
    console.log("beforehide:analyze");
    onAnalyzeTab = false;
});


// if (isIE8) {
//     // R2D3 seems to have trouble with percent values.
//     // Hard-coding pixel values for now.
//     dimensions = {
//         width: "500px",
//         height: "300px"
//     };
// }



var paper;
if (isIE8) {
    paper = new Raphael($(el_raphaelSelector)[0], dimensions.width, dimensions.height);
    paper.clear();
    // http://stackoverflow.com/questions/15365129/manipulate-canvas-background-color-in-raphael-by-using-variable-paper
    paper.canvas.style.backgroundColor = '#FFFFFF';
}

var MAX_BUCKETS = 60;
var rNodes = [];
var rBuckets = [];

function makeBucketParts(i) {
    var circleOuter = paper.circle(0,0,0);
    circleOuter.attr('fill', colorNoVote);
    circleOuter.attr('fill-opacity', 0.2);
    circleOuter.attr('stroke-width', 0);

    var circle  = paper.circle(0,0,0);
    circle.attr('fill', colorNoVote);
    circle.attr('stroke-width', 0);

    // colorSelf
    var up = paper.path();
    up.attr('fill', colorPull);
    up.attr('stroke-width', 0);

    var down = paper.path();
    down.attr('fill', colorPush);
    down.attr('stroke-width', 0);


        // .toFront();
    var set = paper.set();
    set.push(circle);
    set.push(circleOuter);
    set.push(up);
    set.push(down);
    var bucket = {
        radius: 0,
        x: 0,
        y: 0,
        circle: circle,
        circleOuter: circleOuter,
        up: up,
        down: down,
        transform: function(x, y) {
            this.x = x;
            this.y = y;
            this.set.transform("");
            this.set.transform("T" + x + "," + y);

            // this.circle.attr("cx", x);
            // this.circle.attr("cy", y);

            // this.circleOuter.attr("cx", x);
            // this.circleOuter.attr("cy", y);

        },
        scaleCircle: function(s) {
            this.circle.attr("r", this.radius * s);
        },
        setUps: function(ups) {
            var path = chooseUpArrowPath2(ups, 0, 0);
            var _transformed = Raphael.transformPath(path,
                'T0,0'); // TODO needed?
            this.up.animate({path: _transformed}, 0);
        },

        setDowns: function(downs) {
            var path = chooseDownArrowPath2(downs, 0, 0);
            var _transformed = Raphael.transformPath(path,
                'T0,0'); // TODO needed?
            this.down.animate({path: _transformed}, 0);
        },
        // arrowUp: arrowUp,
        // arrowUpOuter: arrowUpOuter,
        // arrowDown: arrowDown,
        // arrowDownOuter: arrowDownOuter,        
        set: set
    };

    return bucket;
}


if (isIE8) {
    for (var i = 0; i < MAX_BUCKETS; i++) {
        var bucket = makeBucketParts();
        rNodes.push(bucket);
    }
} else {

$(el_selector)
  .append("<svg>" +
    "<defs>" +
        "<linearGradient id='snippetGradAgree' x1='0%' y1='0%' x2='0%' y2='200%'>" +
            "<stop offset='0%' style='stop-color:rgba(192, 228, 180, 0.5);stop-opacity:1' />" +
            "<stop offset='100%' style='stop-color:rgba(255, 255, 255, 0.5);stop-opacity:1' />" +
        "</linearGradient>" +
        "<linearGradient id='snippetGradDisagree' x1='0%' y1='0%' x2='0%' y2='200%'>" +
            "<stop offset='0%' style='stop-color:rgba(246, 208, 208, 0.5);stop-opacity:1' />" +
            "<stop offset='100%' style='stop-color:rgba(255, 255, 255, 0.5);stop-opacity:1' />" +
        "</linearGradient>" +



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
            "<circle r=\"" + ptptOiRadius +"\" cx=\"0\" cy=\"0\"/>" +
        "</clipPath>" +
    "</defs>" +
    // "<g>" +
    // '<rect x="'+ (w-150) +'" y="0" width="150" height="25" rx="3" ry="3" fill="#e3e4e5"/>'+
    // '<text x="'+ (w-150) +'" y="10" width="150" height="25" rx="3" ry="3" fill="##3498db">SHOW LEGEND</text>'+
    // "</g>" +
    "</svg>")
  ;
}

var helpLine;
var helpArrowPoints = [];

if (isIE8) {
    $(el_raphaelSelector).on("click", selectBackground);
    w = $(el_raphaelSelector).width();
    h = $(el_raphaelSelector).height();

} else {
    //create svg, appended to a div with the id #visualization_div, w and h values to be computed by jquery later
    //to connect viz to responsive layout if desired
    visualization = d3.select(el_selector).select("svg")
          .call( tip || function(){} ) /* initialize d3-tip */
          // .attr("width", "100%")
          // .attr("height", "100%")
          .attr(dimensions)
          // .attr("viewBox", "0 0 " + w + " " + h )
          .classed("visualization", true)
            .append(groupTag)
                // .call(d3.behavior.zoom().scaleExtent([1, 8]).on("zoom", zoom))
    ;
    $(el_selector).on("click", selectBackground);

    main_layer = visualization.append(groupTag)
        .attr("id", "main_layer")
        .attr("transform", "translate("+ xOffset +")");
        
    blocker_layer = visualization.append(groupTag)
        .attr("id", "blocker_layer")
        .attr("transform", "translate("+ xOffset +")");

    overlay_layer = visualization.append(groupTag);

    helpLine = d3.svg.line();
    helpArrowPoints;

    overlay_layer.append("path")
        .datum(helpArrowPoints)
        .classed("helpArrow", true)
        .classed("helpArrowLine", true)
        .style("display", "none")
        ;
    w = dimensions.width - xOffset; // $(el_selector).width() - xOffset;
    h = dimensions.height; //$(el_selector).height();
}

var clusterPointerFromBottom = display.xs();
var clusterPointerOriginY = clusterPointerFromBottom ? h + 2 : 80;


// function zoom() {
//   // TODO what is event?
//   visualization.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
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

var useForce = !isIE8;
// var useForce = false;
if (useForce) {
    force = d3.layout.force()
        .nodes(nodes)
        .links([])
        .friction(0.9) // more like viscosity [0,1], defaults to 0.9
        .gravity(0)
        .charge(function(d) {
            // slight overlap allowed
            if (isSummaryBucket(d)) {
                return -1000;
            } else {
                return -300;
            }
        })
        .size([w, h]);
}

// function zoomToHull(d){

//     var b = bounds[d.hullId];
//     visualization.transition().duration(750)
//     //.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
//     .attr("transform", "" + "scale(" + 0.95 / Math.max((b[1][0] - b[0][0]) / w, (b[1][1] - b[0][1]) / h) + ")" + "translate(" + -(b[1][0] + b[0][0]) / 2 + "," + -(b[1][1] + b[0][1]) / 2 + ")");
//     //visualization.attr("transform", "translate(10,10)scale(" + d3.event.scale + ")");
// }


function argMax(f, args) {
    var max = -Infinity;
    var maxArg = null;
    _.each(args, function(arg) {
        var val = f(arg);
        if (val > max) {
            max = val;
            maxArg = arg;
        }
    });
    return maxArg;
}

function setClusterActive(clusterId) {
    selectedCluster = clusterId;

    // duplicated at 938457938475438975
    if (!isIE8) {
        main_layer.selectAll(".active_group").classed("active_group", false);
    }
    
    return $.Deferred().resolve([]);
}

function updateHullColors() {
   if (isIE8) {
       for (var i = 0; i < raphaelHulls.length; i++) {
            console.log('updateHullColors', selectedCluster, i);
            if (i === selectedCluster) {
              raphaelHulls[i]
                .attr('fill', hull_selected_color)
                .attr('stroke', hull_selected_color);
            } else {
              raphaelHulls[i]
                .attr('fill', hull_unselected_color)
                .attr('stroke', hull_unselected_color);
            }
        }
   } else {
        if (clusterIsSelected()) {
            d3.select(d3Hulls[selectedCluster][0][0]).classed("active_group", true);
            d3.select(d3HullSelections[selectedCluster][0][0]).classed("active_group", true);
            d3.select(d3HullShadows[selectedCluster][0][0]).classed("active_group", true);
        }
   }
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

function handleOnClusterClicked(hullId) {
    // // if the cluster/hull just selected was already selected...    
    // if (selectedCluster === hullId) {                 
    //   return resetSelection();
    // }
    exitTutorial();

    // resetSelectedComment();
    // unhoverAll();
    setClusterActive(hullId)
        .then(
            updateHulls,
            updateHulls);

    eb.trigger(eb.clusterClicked, hullId);
    eb.trigger(eb.clusterSelectionChanged, hullId);

    updateHullColors();

    //zoomToHull.call(this, d);
    if (d3 && d3.event) {
        if (d3.event.stopPropagation) {
            d3.event.stopPropagation();
        }
        if (d3.event.preventDefault) {
            d3.event.preventDefault(); // prevent flashing on iOS
        }
    }
}
var hull_unselected_color = '#f6f6f6';
var hull_selected_color   = '#ebf3ff';
var hull_shadow_color     = '#d4d4d4';
var hull_shadow_thickness = w > 550 ? 2 : 1;
var hull_seletion_thickness = w > 550 ? 2 : 1;
var hull_stoke_width = hullStrokeWidthGivenVisWidth(w);
var hull_shadow_stroke_width = hull_stoke_width + hull_shadow_thickness;
var hull_selection_stroke_width = hull_shadow_stroke_width + hull_seletion_thickness;

function makeRaphaelHulls(color, strokeWidth, translateX, translateY) {
    return _.times(9, function(i) {
        function handleClick(event) {
            event.stopPropagation();
            return onClusterClicked({
                hullId: i
            });
        }
        var hull = paper.path()
            .attr('fill', color)
            .attr('stroke-width', strokeWidth)
            .attr('stroke-linejoin','round')
            .attr('stroke', color)
            .attr('stroke-linecap', 'round')
            .on('touchstart', handleClick)
            .on('mousedown', handleClick)            
            .toBack();

            // translate the shadow
            if (translateX || translateY) {
                hull.translate(translateX||0, translateY||0);
            }

            return hull;
        });    
}

function makeD3Hulls(hullClass, strokeWidth, translateX, translateY) {
    return _.times(9, function(i) {
        var hull = main_layer.append("path");
        hull.classed(hullClass, true)
            .on("click", onClusterClicked)  //selection-results:1 handle the click event
            // .style("stroke-width", strokeWidth)
            .attr("gid", i);

        if (translateX || translateY) {
            hull.attr("transform", "translate(1, 1)");
        }
        return hull;
    });
}

if (isIE8) {
    raphaelHulls = makeRaphaelHulls(hull_unselected_color, hull_stoke_width);
    raphaelHullsShadow = makeRaphaelHulls(hull_shadow_color, hull_shadow_stroke_width, 1, 1);    
} else {
    d3HullShadows = makeD3Hulls("hull_shadow", hull_shadow_stroke_width, 1, 1);    
    d3HullSelections = makeD3Hulls("hull_selection", hull_selection_stroke_width, 0, 0);        
    d3Hulls = makeD3Hulls("hull", hull_stoke_width);
}

function updateHulls() {
    bidToBucket = _.object(_.pluck(nodes, "bid"), nodes);
    hulls = clusters.map(function(cluster) {
        var top = Infinity;
        var bottom = -Infinity;
        var right = -Infinity;
        var left = Infinity;
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

    // hulls don't render when there's only one point
    // so make a nearby neighbor
    function makeDummyNeighbor(point) {
        return [
            point
        ];
    }

    function tesselatePoint(xyPair) {
        var x = xyPair[0];
        var y = xyPair[1];
        var r = chooseCircleRadiusOuter(xyPair[2]) + 5;
        var points = [];
        var theta = 0;
        var tau = 6.28318;
        var step = isIE8 ?
            0.7853 :  // pi/4  (less points since slow)
            0.261799; // pi/12 (more points)
        while (theta < tau) {
            points.push([x + r*Math.cos(theta), y + r*Math.sin(theta)]);
            theta += step;
        }
        return points;
    }

    function hideHull(i) {
        d3Hulls[i].datum([]).style("visibility", "hidden");
        d3HullSelections[i].datum([]).style("visibility", "hidden");
        d3HullShadows[i].datum([]).style("visibility", "hidden");
    }

    function updateHull(i) {
        var dfd = new $.Deferred();
        setTimeout(function() {
            var hull = hulls[i];

            // var pointsToFeedToD3 = hull.map(function(pt) { return pt;});

            // if (pointsToFeedToD3.length == 1) {
            //     pointsToFeedToD3.push([
            //         pointsToFeedToD3[0][0] + 0.01,
            //         pointsToFeedToD3[0][1] + 0.01
            //         ]);
            // }
            // if (pointsToFeedToD3.length == 2) {
            //     pointsToFeedToD3.push([
            //         pointsToFeedToD3[0][0] + 0.01,
            //         pointsToFeedToD3[0][1] - 0.01 // NOTE subtracting so they're not inline
            //         ]);
            // }



            // var hullPoints_WillBeMutated = d3.geom.hull(pointsToFeedToD3);

            if (!hull) {
                // TODO figure out what's up here
                hideHull(i);
                console.error('cluster/hull count mismatch error');
                dfd.resolve();
                return;
            }
            var pointsToFeedToCentroidFinder = hull.map(function(pt) { return pt;});

            // TODO PERF don't call computeClusterPointerTarget unless the pointer is visible!
            var centroid = computeClusterPointerTarget(pointsToFeedToCentroidFinder);
            centroids[i] = centroid;

            // tesselate to provide a matching hull roundness near large buckets.        
            var tessellatedPoints = [];
            for (var p = 0; p < hull.length; p++) {
                tessellatedPoints = tessellatedPoints.concat(tesselatePoint(hull[p]));
            }        


            // for (var pi = 0; pi < hullPoints.length; pi++) {
            //     var p = hullPoints[pi];
            //     // inset to prevent overlap caused by stroke width.
            //     var dist = strokeWidth/2 + 5;
            //     var inset = moveTowardsTarget(p[0], p[1], centroid.x, centroid.y, dist);
            //     p[0] = inset.x;
            //     p[1] = inset.y;
            // }

            // another pass through the hull generator, to remove interior tesselated points.
            var points = d3.geom.hull(tessellatedPoints);
            hullPoints[i] = points;
            if (!points.length) {
                hideHull(i);
            } else {
                points.hullId = i; // NOTE: d is an Array, but we're tacking on the hullId. TODO Does D3 have a better way of referring to the hulls by ID?
                var shape = makeHullShape(points);
                if (isIE8) {
                    points.unshift();
                    var _transformed = Raphael.transformPath(shape, 'T0,0');
                    raphaelHulls[i].animate({path: _transformed}, 0);
                    raphaelHullsShadow[i].animate({path: _transformed}, 0);
                } else {

                    // If the cluster has only one participant, don't show the hull.
                    // intead, make the hull into an extra large invisible touch target.
                    var color = (clusters[i].length > 1) ? "#eee" : "#f7f7f7";
                    var colorShadow = (clusters[i].length > 1) ? "#d4d4d4" : "#f7f7f7";
                    var strokeWidth = (clusters[i].length > 1) ? "6px" : "40px";
                    var selectionStrokeWidth = (clusters[i].length > 1) ? "9px" : "43px";                    
                    var selectionStrokeDashArray = (clusters[i].length > 1) ? "5,5" : "1,1";                    

                    var shadowStrokeWidth = (clusters[i].length > 1) ? "8px" : "0px";

                    if (selectedCluster === i) {
                        // no shadow, since we'll show dashed line
                        if (COLOR_SELECTED_HULL) {
                            shadowStrokeWidth = "0px";
                            color = "#e9f0f7";
                        }
                    }

                    d3Hulls[i].datum(points)
                        .attr("d", shape)
                        // .style("fill-opacity", hullOpacity)
                        .style("fill", color)
                        .style("stroke", color)
                        // .style("stroke-opacity", hullOpacity)
                        .style("stroke-width", strokeWidth)
                        .style("visibility", "visible");
                    d3HullSelections[i].datum(points)
                        .attr("d", shape)
                        .style("stroke-width", selectionStrokeWidth)
                        .style("stroke-dasharray", selectionStrokeDashArray)
                        .style("visibility", "visible");
                    d3HullShadows[i].datum(points)
                        .attr("d", shape)
                        .style("fill", colorShadow)
                        .style("stroke", colorShadow)
                        // .style("fill-opacity", hullOpacity)
                        // .style("stroke-opacity", hullOpacity)
                        .style("stroke-width", shadowStrokeWidth)
                        .attr("transform", function(h) {
                            if (h.hullId === getSelectedGid()) {
                                return "translate(2, 2)";
                            } else {
                                return "translate(1, 1)";
                            }
                        })
                        .style("visibility", "visible");
                }
            }
            dfd.resolve();
        }, 0);
        return dfd.promise();
    }

    updateHullPromises = _.map(_.range(hulls.length), updateHull);


    var p = $.when.apply($, updateHullPromises);
    p.then(function() {
        if (isIE8) {
            // TODO
        } else {
            // Remove empty clusters.
            var emptyClusterCount = d3Hulls.length - clusters.length;
            var startIndex = d3Hulls.length - emptyClusterCount;
            for (var i = startIndex; i < d3Hulls.length; i++) {
                hideHull(i);
            }
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
var updateHullsThrottled = _.throttle(updateHulls, 1000/hullFps);
function updateNodesOnTick(e) {

      // Push nodes toward their designated focus.
      if (e && _.isNumber(e.alpha)) {
        // Force Layout scenario
        var k = speed * e.alpha;
        // if (k <= 0.004) { return; } // save some CPU (and save battery) may stop abruptly if this thresh is too high
        nodes.forEach(function(o) {
          //o.x = o.targetX;
          //o.y = o.targetY;
          if (!o.x) { o.x = w/2; }
          if (!o.y) { o.y = h/2; }  
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


      if (isIE8) {
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var bucket = rNodes[i];
            var x = node.x;
            var y = node.y;
            bucket.transform(x, y);
          }
      } else {
          main_layer.selectAll(".node")
            .attr("transform", chooseTransformForRoots);
      }


    updateHullsThrottled();
}
if (force) {
    force.on("tick", updateNodesOnTick);
}

function shouldDisplayCircle(d) {
    // Hide the circle so we can show the up/down arrows
    if (commentIsSelected() &&
        !isSelf(d) // for now, always show circle - TODO fix up/down arrow for blue dot
        ) {
        return false;
    }
    return true;
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

            var distFromOriginB = 
            // Math.sqrt(
                xDistFromPointerOriginB * xDistFromPointerOriginB +
                yDistFromPointerOriginB * yDistFromPointerOriginB
                // ); // Omitting sqrt for perf


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

    if (points.length === 3) {
        var p = points;
        return {
            x: (p[0][0] + p[1][0] + p[2][0])/3,
            y: (p[0][1] + p[1][1] + p[2][1])/3
        };
    } else if (points.length === 2) {
        var p = points;
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
        var xi1 = points[i+1][0];
        var yi1 = points[i+1][1];
        var foo = (xi*yi1 - xi1*yi);
        x += (xi + xi1) * foo;
        y += (yi + yi1) * foo;
        area += foo;
    }
    area /= 2;
    x /= (6*area);
    y /= (6*area);
    return {x: x, y: y};
}

function moveTowardsTarget(x, y, targetX, targetY, dist) {
    // TODO optimize by saving dx,dy,d from distance function
    var dx = targetX - x;
    var dy = targetY - y;
    var d = Math.sqrt(dx*dx + dy*dy);
    var unitX = dx/d;
    var unitY = dy/d;
    dist = Math.min(dist, d);  // prevent overshooting the target
    var newX = x + unitX*dist;
    var newY = y + unitY*dist;
    return {
        x: newX,
        y: newY,
        d: d // can be useful
    };
}

function chooseDisplayForCircle(d) {
    return "inherit";
    // return shouldDisplayCircle(d) ? "inherit" : "none";
}


function chooseDisplayForOuterCircle(d) {

    return shouldDisplayOuterCircle(d) ? "inherit" : "none";
}


function shouldDisplayOuterCircle(d) {
    // Hide the circle so we can show the up/down arrows
    if ((commentIsSelected() &&
        !isSelf(d) && // for now, always show circle - TODO fix up/down arrow for blue dot
        !d.ups &&
        !d.downs) || isSelf(d)
        ) {
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

function chooseDisplayForGrayHalo(d) {
    return "inherit";
    // return !shouldDisplayArrows(d) ? "inherit" : "none";
}



function chooseFill(d) {
    // if (commentIsSelected()) {
    //     if (d.effects === -1) {  // pull
    //         return colorPull;
    //     } else if (d.effects === 1) { // push
    //         return colorPush;
    //     }
    // }

    if (isParticipantOfInterest(d)) {
        // return "rgba(255,0,0,0.5)";
        return "rgba(0,0,0,0)";
    } else if (isSelf(d)) {
        return "rgba(0,0,0,0)"; //colorSelf;
    } else {

        // var gid = bidToGid[d.bid];
        // if (gid === 0) {
        //     return "rgba(255,0,0,0.2)";
        // } else if (gid === 1) {
        //     return "rgba(0,255,0,0.2)";
        // } else if (gid === 2) {
        //     return "rgba(0,0,255,0.2)";
        // }
        // return "#0CF";

        return colorSummaryBlob;
    }
}
function chooseStroke(d) {
    if (commentIsSelected()) {

    } else {
        if (isSelf(d)) {
            return colorSelfOutline;
        }
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
   return "translate(" + insetPoint.x + "," + insetPoint.y + ")";
}

var offsetFactor = 4.9;

function makeArrowPoints(scale, yOffset, shouldFlipY) {
    var left = -scale;
    var right =  scale;
    // equilateral triangle
    var bottom = yOffset;
    var top = Math.sqrt(3 * right * right);
    if (shouldFlipY) {
        top *= -1;
    }
    top += yOffset;
    var leftBottom = left + "," + bottom;
    var rightBottom = right + "," + bottom;
    var center = "0," + top;
    return leftBottom + " " + rightBottom + " " + center;
}

var TAU = Math.PI*2;
var pieChartOrigin = 3/4*TAU;

function chooseUpArrowPath(d) {
    if (!d.ups) { return; }
    // var scale = bucketRadiusForCount(d.ups || 0);

    // var scaleDowns = bucketRadiusForCount(d.downs || 0);

    // var sum = scale + scaleDowns;
    // var yOffset = scale - sum/2;

    // return makeArrowPoints(scale, yOffset, true);
    var count = d.seens; //d.clusterCount || d.count;
    var ratio =  d.ups / count;
    ratio = Math.min(ratio, 0.99999);

    var r = chooseCircleRadius(d);
    if (isSummaryBucket(d)) {
        r += EXTRA_RADIUS_FOR_SUMMARY_HALO;
    }
    var start = pieChartOrigin - (TAU*ratio/2);//degrees/2;
    var end = pieChartOrigin + (TAU*ratio/2); // -degrees/2;
    var largeArcFlag = ratio > 0.5 ? 1 : 0;
    return generateWedgeString(0, 0, start, end, r, largeArcFlag, false);


}


var generateWedgeString = function(startX, startY, startAngle, endAngle, radius, largeArcFlag, shouldClose){
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

    }

function chooseDownArrowPath(d) {
    if (!d.downs) { return; }
    // var scale = bucketRadiusForCount(d.downs || 0);
    // var scaleUps = bucketRadiusForCount(d.ups || 0);
    // var sum = scale + scaleUps;
    // var yOffset = scaleUps - sum/2;
    // return makeArrowPoints(scale, yOffset, false);


    var count = d.seens; // d.clusterCount || d.count;

    var ratio =  d.downs / count;
    ratio = Math.min(ratio, 0.99999);

    var r = chooseCircleRadius(d);
    if (isSummaryBucket(d)) {
        r += EXTRA_RADIUS_FOR_SUMMARY_HALO;
    }

    var TAU = Math.PI*2;
    var start = (pieChartOrigin - Math.PI) - (TAU*ratio/2);//degrees/2;
    var end = (pieChartOrigin - Math.PI) + (TAU*ratio/2); // -degrees/2;

    var largeArcFlag = ratio > 0.5 ? 1 : 0;
    return generateWedgeString(0, 0, start, end, r, largeArcFlag, false);


}


// function makeArrowPoints2(scale, shouldFlipY, originX, originY) {
//     var left = -scale;
//     var right = scale;
//     // equilateral triangle
//     var top = Math.sqrt(3 * right * right);
//     if (shouldFlipY) {
//         top *= -1;
//     }
//     top += originY;
//     var bottom = originY;
//     right += originX;
//     left += originX;

//     var f = function(x) {
//         return Math.floor(x*10)/10;
//     };

//     var leftBottom = f(left) + " " + f(bottom);
//     var rightBottom = f(right) + " " + f(bottom);
//     var center = f(originX) + " " + f(top);
//     var s =  "M " + leftBottom + " L " + rightBottom + " L " + center + " L " + leftBottom + " Z";
//     return s;
// }

// function chooseUpArrowPath2(ups, originX, originY) {
//     if (!ups) { return; }
//     var scale = bucketRadiusForCount(ups || 0);
//     return makeArrowPoints2(scale, true, originX, originY);
// }

// function chooseDownArrowPath2(downs, originX, originY) {
//     if (!downs) { return; }    
//     var scale = bucketRadiusForCount(downs || 0);
//     return makeArrowPoints2(scale, false, originX, originY);
// }




// TODO this should probably inset along the normal of the lines connecting to the point in the hull.
function getInsetTarget(d) {
    var gid = bidToGid[d.bid];
    var centroid = centroids[gid];
    if (!centroid) {
        return {x: d.x, y: d.y};
    }
    // var radius = chooseCircleRadiusOuter(d);
    // var inset = moveTowardsTarget(d.x, d.y, centroid.x, centroid.y, radius);
    // // TODO reduce inset as it approaches the target.
    // return inset;
    return {x: d.x, y: d.y}
}

function isSummaryBucket(d) {
    return d.isSummaryBucket;
}

function chooseCircleRadius(d) {
    if (isSummaryBucket(d)) {
        return anonBlobRadius;
    } else {
        return ptptOiRadius;  //bucketRadiusForCount(d.count);
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
    if (d.gid === getSelectedGid()) {
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

function hashCode(s){
    var hash = 0,
        i,
        character;
    if (s.length === 0) {
        return hash;
    }
    for (i = 0; i < s.length; i++) {
        character = s.charCodeAt(i);
        hash = ((hash<<5)-hash)+character;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

// var colorFromString = _.compose(d3.scale.category20(), function(s) {
//     return hashCode(s) % 20;
// });

function key(d) {
    return d.bid;
}



function getParticipantCount(nodes) {
       // var count = d.count;
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
        count += nodes[i].count;
    }
    return count;
}

// clusters [[2,3,4],[1,5]]
function upsertNode(updatedNodes, newClusters, newParticipantCount, comments) {

    participantCount = newParticipantCount;

    var MIN_PARTICIPANTS_FOR_VIS = 0;
    if (participantCount < MIN_PARTICIPANTS_FOR_VIS && !visBlockerOn) {
        showVisBlocker();
    }
    else if (participantCount >= MIN_PARTICIPANTS_FOR_VIS && visBlockerOn) {
        hideVisBlocker();
    }
    if (visBlockerOn) {
        var neededCount = MIN_PARTICIPANTS_FOR_VIS - participantCount;
        blocker_layer.selectAll(".visBlockerMainText")
            .text("Waiting for " +neededCount+ " more participants")
            .attr("font-weight", 100)
            .attr("font-family", "brandon-grotesque")
            .attr("font-size", (display.xs()||display.sm()) ? "1.5em" : "28px")
            ;

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

    clusters = newClusters;

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
    for (var i = 0; i < updatedNodes.length; i++ ){
        var node = updatedNodes[i];
        var count = node.count;
        if (count > maxCount) {
            biggestNode = node;
            maxCount = count;
        }
    }
    var minRad = minNodeRadiusScaleForGivenVisWidth(w);
    // var maxRad = maxNodeRadiusScaleForGivenVisWidth(w);
    // bucketRadiusForCount = d3.scale.pow().exponent(.5).range([minRad, maxRad]).domain([1, maxCount]).clamp(true);

    var baseSquared = minRad*minRad;
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
        x: d3.scale.linear().range([0 + border, w - border]).domain([spans.x.min - eps, spans.x.max + eps]),
        y: d3.scale.linear().range([0 + border, h - border]).domain([spans.y.min - eps, spans.y.max + eps])
    };
  }
    // TODO pass all nodes, not just updated nodes, to createScales.
    var scales = createScales(updatedNodes);
    var scaleX = scales.x;
    var scaleY = scales.y;

    comments = comments.map(function(c) {
        c.target = {
            x: scaleX(-2*c.proj.x),
            y: scaleY(-1*c.proj.y)
        };
        return c;
    });

    var oldpositions = nodes.map( function(node) { return { x: node.x, y: node.y, bid: node.bid }; });

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
        return a.proj.x - b.proj.x;
    }

    var bidToOldNode = _.indexBy(nodes, getBid);

    for (var i = 0; i < updatedNodes.length; i++) {
        var node = updatedNodes[i];
        var oldNode = bidToOldNode[node.bid];
        if (oldNode) {
            node.effects = oldNode.effects;
        }
    }

    nodes = updatedNodes.sort(sortWithSelfOnTop).map(computeTarget);
    var niceIndex = Math.floor(nodes.length/4);
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
        var newNode = _.findWhere(nodes, {bid: oldNode.bid});
        if (!newNode) {
            console.error("not sure why a node would disappear");
            return;
        }
        newNode.x = oldNode.x;
        newNode.y = oldNode.y;
    });


      if (force) {
        force.nodes(nodes, key).start();
      } else if (isIE8) {
        // don't do force layout, do that stuff here once.
          nodes.forEach(function(o) {
              o.x = o.targetX;
              o.y = o.targetY;
          });
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var bucket = rNodes[i];
            var x = node.x;
            var y = node.y;

            bucket.transform(x, y);
          }
          updateHulls();
      } else {
        // see fa89dsjf8d
      }

    function setupRaphaelNode(n) {
      // do each on a separate stack
      setTimeout(function() {
        var node = nodes[n];
        var bucket = rNodes[n];
        if (isSelf(node)) {
            bucket.circleOuter.attr("fill", "rgba(255,255,255,0)");
            bucket.circleOuter.attr("stroke", colorSelf);
            bucket.circleOuter.attr("stroke-width", 1);
            bucket.circleOuter.attr("opacity", 0.5);
            bucket.circleOuter.attr("r", bucket.radius * 2);
        } else {
            bucket.circleOuter.attr("fill", colorNoVote);
            bucket.circleOuter.attr("stroke", colorSelf);
            bucket.circleOuter.attr("stroke-width", 0);
            bucket.circleOuter.attr("opacity", "");
            bucket.circleOuter.attr("r", bucket.radius);
        }
      }, 10);
    }

  if (isIE8) {
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        var bucket = rNodes[n];
        if (isSelf(node)) {
            bucket.circle.attr("fill", colorSelf);
        } else {
            bucket.circle.attr("fill", colorNoVote);
        }
      }
      // postpone to speed up init
      setTimeout(function() {
          _.map(_.range(nodes.length), setupRaphaelNode);
      }, 1000);
  } else {

    // TODO use key to guarantee unique items


      main_layer.selectAll(".node")
        .attr("visibility", function(d) {
            return (d.count >= 1) ? "visbile" : "hidden";
        })
        ;

      var update = main_layer.selectAll(".ptpt")
          .data(nodes, key)
          // .sort(sortWithSelfOnTop)
          ;

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

      if (Utils.projectComments) {
          var foo = main_layer.selectAll(".c").data(comments);
          var commentWidth = 2;
          var commentWidthHalf = commentWidth/2;
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


    var ptptOiDiameter = ptptOiRadius*2;

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
      // OUTER TRANSLUCENT SHAPES
      // var opacityOuter = 0.2;
      // var upArrowEnter = g.append("polygon") 
      //   .classed("up", true)
      //   .classed("bktv", true)
      //   .style("fill", colorPull)
      //   .style("fill-opacity", opacityOuter)
      //   // .style("stroke", colorPullOutline)
      //   // .style("stroke-width", 1)
      //   ;
      // var downArrowEnter = g.append("polygon")
      //   .classed("down", true)
      //   .classed("bktv", true)
      //   .style("fill", colorPush)
      //   .style("fill-opacity", opacityOuter)
      //   // .style("stroke", colorPushOutline)
      //   // .style("stroke-width", 1)
      //   ;
      var ptptoiImageZoomFactor = 1;
      var picEnter = g.append("image")
      picEnter
        // .classed("circle", true)
        .classed("bktv", true)
        .attr("x", function(d) {
            return getImageWidth(d) * -0.5;
        })
        .attr("y", function(d) {
            return getImageWidth(d) * -0.5;
        })
        // .style("visibility", "hidden")
        .attr("height", getImageWidth)
        .attr("width", getImageWidth)
        .attr("clip-path", "url(#clipCircle)")
        .attr("xlink:href", function(d) {
            return d.pic;
        })
      //   .style("opacity", opacityOuter)
      //   .style("fill", chooseFill)
        // .filter(isSelf)
        //     .style("fill", "rgba(0,0,0,0)")
        //     .style("stroke", colorSelf)
        //     .style("stroke-width", 1)
        //     .style("opacity", 0.5)
        ;


        var grayHaloEnter = g.append("circle")
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
                return anonBlobHaloWidth;
            } else {
                return haloWidth;
            }
        })
        .attr("fill", chooseFill)
        ;

        function shouldShowSnippedOnLeft(d) {
            return d.x > 2/3*w;
        }

/////////////// BEGIN SNIPPET BUBBLES ////////////////////
        // g.filter(isSummaryBucket)
        //   .append("rect")
        //     .classed("snippet", true)
        //     .style("display", "none")
        //     .style("fill", "lightgray")
        //     .style("stroke", "lightgray")
        //     .attr('stroke-linejoin','round')
        //     .style("stroke-width", 3)
        //     .attr("x", function(d) {
        //         if (shouldShowSnippedOnLeft(d)) {
        //             return -229;
        //         }
        //         return 31;
        //     }) // inset so it doesn't get cut off on firefox
        //     .attr("y", -29) // inset so it doesn't get cut off on firefox
        //     .attr("width", 200) // inset so it doesn't get cut off on firefox
        //     .attr("height", 60) // inset so it doesn't get cut off on firefox
        //     // .style("stroke", "lightgray")
        //     // .attr("rx", 5)
        //     // .attr("ry", 5)
        //     ;

        // g.filter(isSummaryBucket)
        //   .append("rect")
        //     .classed("snippet", true)
        //     .classed("snippetSurface", true)
        //     .style("display", "none")
        //     // .style("fill", "white")
        //     .style("stroke", "none")
        //     .attr("x", function(d) {
        //         if (shouldShowSnippedOnLeft(d)) {
        //             return -230;
        //         }
        //         return 30;
        //     }) // inset so it doesn't get cut off on firefox
        //     .attr("y", -30) // inset so it doesn't get cut off on firefox
        //     .attr("width", 200) // inset so it doesn't get cut off on firefox
        //     .attr("height", 60) // inset so it doesn't get cut off on firefox
        //     // .style("stroke", "lightgray")
        //     // .attr("rx", 5)
        //     // .attr("ry", 5)
        //     ;


        g.filter(isSummaryBucket)
          .append("path")
            .classed("snippet", true)
            .classed("snippetSurface", true)
            .style("stroke", "rgba(0,220,0,0.5)")
            .style("display", "none")
            // .style("fill", "white")
            .attr("d", function(d) {
                if (shouldShowSnippedOnLeft(d)) {
                    // return "M -20,0 L -50,25 L -50,-25 L -20,0 Z";
                    return "M -20,0 L -250,0 L -250,50 L -40,50 L -40,20 L -20,0 Z";
                } 
                return "M 20,0 L 250,0 L 250,50 L 40,50 L 40,20 L 20,0 Z";
            })
            


        g.filter(isSummaryBucket)
          .append("text")
            .classed("snippet", true)
            .classed("snippetText", true)
            .style("display", "none")
            .attr("display", "none")
            .attr("text-anchor", function(d) {
                if (shouldShowSnippedOnLeft(d)) {
                    return "end";
                }
                return "start";
            })
            // .attr("fill", "rgba(0,0,0,1.0)")
            .attr("fill", "black")
            .attr("stroke", "black")
            .attr("transform", function(d) {
                if (shouldShowSnippedOnLeft(d)) {
                    return "translate(-55, 25)";
                }
                return "translate(55, 25)";
            });
/////////////// END SNIPPET BUBBLES ////////////////////

       

      // INNER SCALE-CHANGING SHAPES
      var upArrowEnterInner = g.append("path")
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
        .style("opacity", 0.5)
        ;

      var downArrowEnterInner = g.append("path")
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
        .style("opacity", 0.5)
        ;

      // var circleEnterInner = g.append("circle")
      //   .classed("circle", true)
      //   .classed("bktvi", true)
      //   .style("stroke-width", 0)
      //   .style("fill", chooseFill)
      //   ;

      var self = g.filter(isSelf);
      self.classed("selfDot", true);


      // g.append("text")
      //   // .classed("help", true)
      //   // .classed("help_text_you", true)
      //   .text(function(d) {
      //       return d.bid;
      //   })
      //   .attr("text-anchor", "start")
      //   // .attr("fill", "rgba(0,0,0,1.0)")
      //   .attr("fill", colorSelf)
      //   .attr("stroke", colorSelfOutline)
      //   .attr("transform", function(d) {
      //       return "translate(12, 6)";
      //   });


        g.filter(isSummaryBucket)
        .append("text")
        .classed("summaryLabel", true)
        // .classed("help", true)
        // .classed("help_text_you", true)
        .style("font-family", "Tahoma") // For the "AGREED"/"DISAGREED" label: Tahoma should be good at small sizes http://ux.stackexchange.com/questions/3330/what-is-the-best-font-for-extremely-limited-space-i-e-will-fit-the-most-readab
        .style("font-size", "12px")
        .style("font-weight", "bold")
        .attr("text-anchor", "middle")
        .attr("alignment-baseline", "bottom")
        // .attr("alignment-baseline", "middle")
        // .attr("fill", "rgba(0,0,0,1.0)")
        // .attr("fill", colorSelf)
        // .attr("stroke", colorSelfOutline)
        // .attr("transform", function(d) {
        //     return "translate(12, 6)";
        // });
        ;

        g.filter(isSummaryBucket)
        .append("text")
        .classed("summaryLabelBottom", true)
        .style("font-family", "Tahoma") // For the "AGREED"/"DISAGREED" label: Tahoma should be good at small sizes http://ux.stackexchange.com/questions/3330/what-is-the-best-font-for-extremely-limited-space-i-e-will-fit-the-most-readab
        .style("font-size", "10px")
        // .style("font-weight", "bold")
        .style("fill", "gray")
        .text("people")
        .attr("text-anchor", "middle")
        .attr("alignment-baseline", "top")
        .attr("transform", function(d) {
            return "translate(0, 11)";
        });
        ;



  }
  updateNodes();

        // fa89dsjf8d
      if (!force && !isIE8) {
        updateNodesOnTick();
         // main_layer.selectAll(".node")
            // .attr("transform", chooseTransformForRoots);
      }

  updateHulls();

  if (commentIsSelected()) {
    selectComment(selectedTid);
  }



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

      var helpStrokeWidth = display.xs() ? 1 : 2;

    var g = visualization.selectAll(".node");
     

      // var centermostNode = g.filter(function(d) {
      //   return d.isChosenNodeForInVisLegend;
      // });
      // centermostNode.append("text")
      //   .classed("help", true)
      //   .text("another participant")
      //   .attr("text-anchor", "start")
      //   .attr("fill", "#000")
      //   // .attr("style", "background-color: #f7f7f7") not possible in SVG must draw rectangle. 
      //   .attr("transform", function(d) {
      //       return "translate(55, -17)";
      //   });
      // centermostNode.append("polyline")
      //   .classed("help", true)
      //   .style("display", "block")
      //   .style("stroke", "#555555")
      //   .style("stroke-width", helpStrokeWidth)
      //   .style("z-index", 9999)
      //   .style("fill", "rgba(0,0,0,0)")
      //   // .attr("marker-end", "url(#ArrowTipOpenCircle)")
      //   // .attr("marker-start", "url(#ArrowTip)")
      //   .attr("points", function(d) {
      //       return ["9, -9", "20, -20", "50,-20"].join(" ")
      //   });
      // centermostNode.append("circle")
      //   .classed("help", true)
      //   // .classed("circle", true)
      //   .attr("cx", 0)
      //   .attr("cy", 0)
      //   .attr("r", 12.727)
      //   // .style("opacity", opacityOuter)
      //   .style("fill", "rgba(0,0,0,0)")
      //   .style("stroke", "#555555")
      //   .style("stroke-width", helpStrokeWidth)
      //   ;

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
      // selfNode.append("polyline")
      //   .classed("help", true)
      //   .style("display", "block")
      //   .style("stroke", "#555555")
      //   .style("stroke-width", helpStrokeWidth)
      //   .style("z-index", 9999)
      //   .style("fill", "rgba(0,0,0,0)")
      //   // .attr("marker-end", "url(#ArrowTipOpenCircle)")
      //   // .attr("marker-start", "url(#ArrowTip)")
      //   .attr("points", function(d) {
      //       return ["9, 9", "20, 20", "50,20"].join(" ")
      //   });
      // selfNode.append("circle")
      //   .classed("help", true)
      //   // .classed("circle", true)
      //   .attr("cx", 0)
      //   .attr("cy", 0)
      //   .attr("r", 12.727)
      //   // .style("opacity", opacityOuter)
      //   .style("fill", "rgba(0,0,0,0)")
      //   .style("stroke", "#555555")
      //   .style("stroke-width", helpStrokeWidth)
      //   ;
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
          .each("end", dfdDown.resolve)
          ;
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

            // for (var p = 0; p < node.ppl.length; p++) {

            //     // TODO_MAXDOTS count up the votes of each type for each user (instead of just ppl[0])
            //     var reaction = bidToVote[node.ppl[p].pid];
            //     if (reaction) {
            //         if (reaction.vote === -1) {
            //             node.ups += 1;
            //         } else if (reaction.vote === 1) {
            //             node.downs += 1;
            //         }
            //     }
            // }
        }
        updateNodeVoteCounts();
        updateNodes();
        // visualization.selectAll(".node")
        //   .attr("transform", chooseTransform)
        //   .selectAll("path")
        //       .style("fill", chooseFill)
        //       .style("stroke", chooseStroke)
        //       .style("fill-opacity", chooseAlpha)
        //       // .attr("r", chooseRadius)
        //       .attr("d", chooseShape)
         // ;
    }, function() {
        console.error("failed to get reactions to comment: " + d.tid);
    });
}

// TODO move this stuff out into a backbone view.
function chooseCommentFill(d) {
    if (selectedTid === d.tid) {
        return "#428bca";
    } else {
        // return nothing since we want the hover class to be able to set
        return "";
    }
}


function renderComments(comments) {
    
    var dfd = $.Deferred();

    if (comments.length) {
        $(el_queryResultSelector).show();
    } else {
        $(el_queryResultSelector).hide();
    }
    setTimeout(dfd.resolve, 4000);
    eb.trigger("queryResultsRendered");
    return dfd.promise();
}


function onParticipantClicked(d) {
    // d3.event.stopPropagation();
    // d3.event.preventDefault(); // prevent flashing on iOS
  var gid = bidToGid[d.bid];
  if (_.isNumber(gid)) {
      handleOnClusterClicked(gid);
  }
}

function unhoverAll() {
  updateNodes();
}

function updateNodeVoteCounts() {
    if (isIE8) {
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var bucket = rNodes[i];
            bucket.setUps(node.ups);
            bucket.setDowns(node.downs);
        }
    }
}

function updateNodes() {
    setTimeout(doUpdateNodes, 0);
}

function doUpdateNodes() {
  if (isIE8) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var bucket = rNodes[i];
        var r = chooseCircleRadius(node);
        bucket.radius = r;
        if (isSelf(node)) {
            bucket.circleOuter.attr("r", r*2);
        } else {
            bucket.circleOuter.attr("r", r);        
        }
            
        bucket.scaleCircle(1); // sets the inner circle radius

        if (shouldDisplayCircle(node)) {
            bucket.circle.show();
            bucket.circleOuter.show();
        } else {
            bucket.circle.hide();
            bucket.circleOuter.hide();
        }
        if (shouldDisplayArrows(node)) {
            bucket.up.show();
            bucket.down.show();        
        } else {
            bucket.up.hide();
            bucket.down.hide();
        }
      }
  } else {
      var update = visualization.selectAll(".node");
        var upArrowUpdateInner = update.selectAll(".up.bktvi").data(nodes, key)
          .style("display", chooseDisplayForArrows)
          .attr("d", chooseUpArrowPath) // NOTE: using tranform to select the scale
          ;
        var downArrowUpdateInner = update.selectAll(".down.bktvi").data(nodes, key)
          .style("display", chooseDisplayForArrows)
          .attr("d", chooseDownArrowPath) // NOTE: using tranform to select the scale
          ;
        var grayHaloUpdate = update.selectAll(".grayHalo").data(nodes, key)
          .style("display", chooseDisplayForGrayHalo)
          ;

        commentsCollection.firstFetchPromise.then(function() {
            update.selectAll(".snippetText")
                .text(function(d) {
                    var info = groupInfo(d.gid);
                    var txt = "Error 33";
                    if (info && info.repness && info.repness.length) {
                        var c1 = info.repness[0];
                        var c = commentsCollection.findWhere({"tid": c1.tid});
                        if (c) {
                            var cTxt = c.get("txt");
                            if (c && !_.isUndefined(cTxt)) {
                                txt = cTxt;
                            }
                        }
                    }
                    var truncated = txt.slice(0, 30);
                    if (truncated.length < txt.length) {
                        truncated += " ...";
                    }
                    return truncated;
                });
            update.selectAll(".snippetSurface")
                .style("fill", function(d) {
                    var info = groupInfo(d.gid);
                    var color = "orange"; // error color
                    if (info && info.repness && info.repness.length) {
                        var c1 = info.repness[0];
                        if (c1["repful-for"] === "agree") {
                            color = "url(#snippetGradAgree)";
                        }
                        if (c1["repful-for"] === "disagree") {
                            color = "url(#snippetGradDisagree";
                        }
                    }
                    return color;
                });
        });

        if (clusterIsSelected()) {
            update.selectAll(".snippet").style("display", "none");
        } else {
            if (w >= 500) {
                commentsCollection.firstFetchPromise.then(function() {
                    update.selectAll(".snippet").style("display", "block");
                });
            }
        }

        update.selectAll(".grayHalo")
                .style("stroke", function(d) {
                    if (isSelf(d)) {
                        if (clusterIsSelected() || onAnalyzeTab) {
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
                })
        ;



        var circleUpdate = update.selectAll(".circle.bktv").data(nodes, key)
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
        var circleUpdateInner = update.selectAll(".circle.bktvi").data(nodes, key)
          .style("display", chooseDisplayForCircle)
          .attr("r", chooseCircleRadius) // NOTE: using tranform to select the scale
          ;
     

          var selfNode = _.filter(nodes, isSelf)[0];
          if (selfNode && !selfHasAppeared) {
            selfHasAppeared = true;
            onSelfAppearsCallbacks.fire();

            setupBlueDotHelpText(update.select(".selfDot"));
          }


          update.attr("fill-opacity", function(d) {
            if (clusterIsSelected()) {
                return d.gid === selectedCluster ? "100%" : "90%";
            } else {
                // nothing selected
                return "100%";
            }
          });

          function toPercent(ratio) {
            return ((ratio * 100) >> 0) + "%";
          }
          update.selectAll(".summaryLabel").data(nodes, key)
            .text(function(d) {
                var txt;
                // return "Disagreed";
                if (commentIsSelected()) {
                    var txt;
                    var count = d.seens; // d.clusterCount || d.count; // if d.clusterCount is supplied, use it (since summary blobs show % for all members, non just those in the anonblob)
                    if (d.ups === 0 && d.downs === 0) {
                        txt = "\u2014"; // em dash
                    } 
                    else if (d.ups >= d.downs) {
                        txt = toPercent(d.ups / count);
                    } else if (d.downs > d.ups) {
                        txt = toPercent(d.downs / count);
                    } else {
                        txt = "?";
                        console.error("missing d.ups or d.downs");
                    }
                    d._txtType = "c";
                } else {
                    txt = "+" + d.count;
                }
                d._txt = txt;
                return txt;
            })
            .attr("alignment-baseline", function(d) {
                if (commentIsSelected()) {
                    return "middle";
                }
                return "bottom";
            })
            .attr("fill", function(d) {
                // return "Disagreed";
                if (commentIsSelected()) {
                    var color = "gray";
                    if (d.ups === 0 && d.downs === 0) {
                        color = "gray";
                    } else if (d.ups >= d.downs) {
                        color = colorPullLabel;
                    } else if (d.downs > d.ups) {
                        color = colorPushLabel;
                    } else {
                        console.error("missing d.ups or d.downs");
                    }
                    return color;
                }
                return "gray";
            })
            .style("font-size", function(d) {
                var size = 12;
                if (d._txt) {
                    var len = d._txt.length;
                    if (len === 2) {
                        size = 16;
                    } else if (len === 3) {
                        size = 14;
                    } else if (len === 4) {
                        size = 12;
                    }
                }
                return size + "px";
            })
            ;


        update.selectAll(".summaryLabelBottom").data(nodes, key)
           .style("visibility", function(d) {
                if (commentIsSelected()) {
                    return "hidden";
                }
                return "visible";
            })
        ;
  }
}

function resetSelectedComment() {
  selectedTid = -1;
}

function resetSelection() {
  console.log("resetSelection");
  if (isIE8) {
  } else {
      visualization.selectAll(".active_group").classed("active_group", false);
  }
  selectedCluster = -1;
  eb.trigger(eb.clusterSelectionChanged, selectedCluster);
}


function selectBackground() {
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
        .attr("width", w-2) // inset so it doesn't get cut off on firefox
        .attr("height", h-2) // inset so it doesn't get cut off on firefox
        // .style("stroke", "lightgray")
        .attr("rx", 5)
        .attr("ry", 5)
    ;
    blocker_layer.append("text")
            .classed("visBlocker", true)
            .classed("visBlockerMainText", true)
            .attr("text-anchor", "middle")
            .attr("fill", "#black")
            .attr("transform", "translate("+ 
                w/2 +
                "," + (9*h/24) + ")")
    ;
    blocker_layer.append("text")
            .classed("visBlocker", true)
            .classed("visBlockerGraphic", true)
            .attr("transform", "translate("+ 
                w/2 +
                "," + (15*h/24) +")")
            .attr("text-anchor", "middle")
            .attr("fill", "#black")
        .attr('font-family', 'FontAwesome')
        .attr('font-size', function(d) { return '2em'} )
        ;

}

function hideVisBlocker() {
    visBlockerOn = false;

    blocker_layer.selectAll(".visBlocker")
        .remove()
    ;
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

        function chooseStrokeWidth(d) {
            // If emphasized, maintain fill, (no stroke needed)
            if (hash[d.bid]) {
                return 0;
            }
            return 2;
        }
        function chooseStroke(d) {
            // If emphasized, maintain fill, (no stroke needed)
            if (hash[d.bid]) {
                return void 0; // undefined
            }
            return chooseFill(d);
        }
        function chooseFillOpacity(d) {
            // If emphasized, maintain fill, (no stroke needed)
            if (hash[d.bid] >= 2) {
                return 1;
            }
            return 0.2;
        }

        function chooseTransformSubset(d) {
            var bid = d.bid;
            var ppl = bidToPids[bid];
            var total = ppl ? ppl.length : 0;
            var active = hash[bid] || 0;
            var ratio = active/total;
            if (ratio > 0.99) {
                return;
            } else {
                return "scale(" + ratio + ")";
            }
        }
        function chooseTransformSubsetRaphael(d) {
            var bid = d.bid;
            var ppl = bidToPids[bid];
            var total = ppl ? ppl.length : 0;
            var active = hash[bid] || 0;
            var ratio = active/total;
            if (ratio > 0.99 || total === 0) {
                return 1;
            } else {
                return ratio;
            }
        }

        if (isIE8) {
            for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j];
                var bucket = rNodes[j];
                var s = chooseTransformSubsetRaphael(node);
                bucket.scaleCircle(s);
                // bucket.circle.scale(s, s)
            }
        } else {
            visualization.selectAll(".bktvi")
                // .attr("stroke", chooseStroke)
                .attr("transform", chooseTransformSubset)
                // .attr("stroke-width", chooseStrokeWidth)
                // .attr("fill-opacity", chooseFillOpacity)
            ;

        }
    });
}


function centerOfCluster(gid) {
    var c = centroids[gid];
    if (c) {
        return [c.x, c.y];
    } else {
        return [-99, -99];
    }
}
function dist(start, b) {
    var dx = start[0] - b[0];

    var dy = start[1] - b[1];

    // // https://www.google.com/search?q=x*x&oq=x*x&aqs=chrome..69i57j69i65l3j0l2.1404j0j7&sourceid=chrome&es_sm=91&ie=UTF-8#q=1+%2B+-5%5E(-((x-30)%5E2)%2F(2*8%5E2)
    // var penaltyY = 10 * (1 + -5^(-((dy-30)^2)/(2*8^2)));
    // dy += penaltyY;
    return Math.sqrt(dx*dx + dy*dy);
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
    return Math.sqrt(dx*dx + dy*dy + difference*difference);
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
                (p1[0] + p2[0])/2,
                (p1[1] + p2[1])/2,
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
function showLineToCluster(gid) {
    clusterToShowLineTo = gid;
    updateLineToCluster(gid);
}

function updateLineToCluster(gid) {
    if (navigator.userAgent.match(/MSIE 10/)) {
        return;
    }
    // var center = centerOfCluster(gid);

    var startX = clusterPointerFromBottom ? w/10: -2;
    var start = [startX, clusterPointerOriginY];
    var center = nearestPointOnCluster(gid, start);
    if (clusterPointerFromBottom && center && center[0] < w/3) {
        startX = 4*w/5;
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
    
    var centerPointOnX = 1/2;

    var centerY = clusterPointerFromBottom ?  center[1] : clusterPointerOriginY; // decides if the curve is concave/convex
    helpLine.interpolate("basis");
    helpArrowPoints.splice(0); // clear
    helpArrowPoints.push(start);
    helpArrowPoints.push([ (startX+center[0]) * centerPointOnX , centerY ]); // midpoint on x, same as origin on y
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

function onHelpTextClicked() {
    overlay_layer.selectAll(".helpArrow")
        .style("display", "none");
    $("#helpTextBox").addClass("hidden");
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
              d3.select(this).remove();
            });
        }
    }
}


eb.on(eb.vote, function() {
    if (isIE8) {
    } else {
      var update = visualization.selectAll(".node").filter(isSelf);
      update
        .attr("opacity", 0)
        .transition(10)
          .delay(10)
          .attr("opacity", 1);
    }
});

function getSelectedGid() {
    return selectedCluster;
}

function selectGroup(gid) {
    handleOnClusterClicked(gid);
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
};

};
