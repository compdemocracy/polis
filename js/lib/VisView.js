var eb = require("../eventBus");
var owl = require("owl");
var display = require("../util/display");
var Raphael = require("raphael");

// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var VisView = function(params){

var el_selector = params.el;
var el_queryResultSelector = params.el_queryResultSelector;
var el_raphaelSelector = params.el_raphaelSelector;
var getReactionsToComment = params.getReactionsToComment;
var computeXySpans = params.computeXySpans;
var getPidToBidMapping = params.getPidToBidMapping;
var isIE8 = params.isIE8;
var isMobile = params.isMobile;
var xOffset = params.xOffset || 0;
var inVisLegendCounter = params.inVisLegendCounter || 0;

var dimensions = {
    width: params.w,
    height: params.h
};

// var getPid = params.getPid;

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

var selectedCluster = -1;
var selectedBids = [];
var selectedTid = -1;

var eps = 0.000000001;
var SELECT_GLOBAL_CONSENSUS_WHEN_NO_HULL_SELECTED = false;

var bidToGid = {};
var bidToBucket = {};

var SELF_DOT_SHOW_INITIALLY = true;
var selfDotTooltipShow = !SELF_DOT_SHOW_INITIALLY;
var SELF_DOT_HINT_HIDE_AFTER_DELAY = 10*1000;
var selfDotHintText = "you";

var clusterPointerOriginY = 80;

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

var colorPull = "rgb(0, 181, 77)"; // EMERALD
var colorPush = "#e74c3c";// ALIZARIN
window.color = function() {
    // colorPull = "rgb(0, 214, 195)";
    colorPull = "rgb(0, 182, 214)";
    colorPush = "rgb(234, 77, 30)";

    var update = visualization.selectAll(".node");
    update.selectAll(".up.bktvi").style("fill", colorPull);
    update.selectAll(".down.bktvi").style("fill", colorPush);
}

var colorPass = "#BDC3C7"; // SILVER
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
var SHOW_TIP = false;
var tipPreviousTarget = null; // Sorry God!
if (SHOW_TIP && !isIE8) {
    $("#ptpt-tip").remove();
    tip = d3.tip().attr("id", "ptpt-tip").attr("stroke", "rgb(52,73,94)").html(
        function(d) {
            d.getPeople().then(function(people) {
                // use the email address as the html
                var html = people.map(function(p) {
                    if (isSelf(d)) {
                        var hint = selfDotTooltipShow ? selfDotHintText : "";
                        return {
                            email: hint
                        };
                    }
                    return p;
                })
                .map(function(p) {
                    if (!p) {
                        console.warn("missing user info");
                        return "";
                    }
                    return p.email;
                }).join("<br/>");
                setTimeout(function() {
                    $("#tipContents").html(html);
                }, 10);
            });
            if (d === tipPreviousTarget) {
                var oldHtml = $("#tipContents").html();
                if (oldHtml) {
                    return oldHtml;
                }
            }
            tipPreviousTarget = d;
            return "<div id='tipContents'></div>";
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
        "<marker class='helpArrow' id='ArrowTip'" +
                "viewBox='0 0 14 14'" +
                "refX='1' refY='5'" +
                "markerWidth='5'" +
                "markerHeight='5'" +
                "orient='auto'>" +
            // "<path d='M 0 0 L 10 5 L 0 10 z' />" +
            "<circle cx = '6' cy = '6' r = '5' style='fill:#222;'/>" +
        "</marker>" +
    "</defs>" +
    // "<g>" +
    // '<rect x="'+ (w-150) +'" y="0" width="150" height="25" rx="3" ry="3" fill="#e3e4e5"/>'+
    // '<text x="'+ (w-150) +'" y="10" width="150" height="25" rx="3" ry="3" fill="##3498db">SHOW LEGEND</text>'+
    // "</g>" +
    "</svg>")
  ;
}



$("#legendRoot").html("");
$("#legendRoot").append("<p class=\"HeadingF HeadingF--light\" style=\"position: absolute; font-size: 12px; text-align: center; width: 100%; top: 6px\"> Dots represent participants. The closer the participants are, the more alike they voted.</p>" +
"<p style=\"position: absolute; font-size: 12px; text-align: left; width: 63%; right:10px; top: 67px\"> Your position in the conversation, close to those who voted like you did. </p>" +
"<p style=\"position: absolute; font-size: 12px; text-align: left; width: 63%; right:10px; top: 125px\"> One or more other participants. </p>" +
"<p style=\"position: absolute; font-size: 12px; text-align: left; width: 63%; right:10px; top: 162px\"> A larger number of other participants.  </p>" +
"<p style=\"position: absolute; font-size: 12px; text-align: left; width: 63%; right:10px; top: 200px\"> Shaded areas represent opinion groups. <strong> Click</strong> a group to learn which comments define them. </p>" +
"<p style=\"position: absolute; font-size: 12px; text-align: left; width: 63%; right:10px; top: 278px\"> These participants <span style=\"color:#2ecc71;\"> agreed </span> with the selected comment </p>" +
"<p style=\"position: absolute; font-size: 12px; text-align: left; width: 63%; right:10px; top: 328px\"> These participants <span style=\"color: #e74c3c;\">disagreed</span> with the selected comment </p>" +
"<svg width='100%' height='400'>"+
// "<path class='hull_shadow' gid='0' transform='translate(1, 1)' d='M50,50L200,100L175,250L25,200Z'></path>"+
// "<path class='hull_shadow' gid='1' transform='translate(1, 1)' d='M30,250L165,350L100,350L40,275Z'></path>"+
// "<path class='hull_selection' gid='0' d='M50,50L200,100L175,250L25,200Z'></path>"+
// "<path class='hull_selection' gid='1' d='M30,250L165,350L100,350L40,275Z'></path>"+
"<path class='hull' gid='0' d='M50,55L100,100L100,250L25,200Z'></path>"+
"<path class='hull' gid='1' d='M30,250L90,330L60,360L20,275Z'></path>"+
"<circle cx='82' cy='171' r='13' class='circle bktvi' style='fill: #BDC3C7;'></circle>"+
"<circle cx='53' cy='100' r='9' class='circle bktvi' style='fill: #BDC3C7;'></circle>"+
"<circle cx='53' cy='62' r='4' class='circle bktvi' style='fill: #BDC3C7;'></circle>"+
"<circle cx='70' cy='90' r='4' class='circle bktvi' style='fill: #BDC3C7;'></circle>"+
"<circle cx='70' cy='200' r='4' class='circle bktvi' style='fill: #BDC3C7;'></circle>"+
"<circle cx='31' cy='197' r='4' class='circle bktvi' style='fill: #BDC3C7;'></circle>"+
"<circle cx='88' cy='134' r='4' class='circle bktvi' style='fill: #BDC3C7;'></circle>"+
"<line x1='85' y1='208' x2='115' y2='208' style='stroke:#eee; stroke-width:2'></line>" +
"<line x1='85' y1='134' x2='115' y2='134' style='stroke:#BDC3C7; stroke-width:1'></line>" +
"<line x1='80' y1='171' x2='115' y2='171' style='stroke:#BDC3C7; stroke-width:1'></line>" +
"<line x1='72' y1='76' x2='115' y2='76' style='stroke:#0CF;stroke-width:1'></line>" +
"<line x1='40' y1='287' x2='115' y2='287' style='stroke:#2ecc71;stroke-width:1'></line>" +
"<line x1='70' y1='336' x2='115' y2='336' style='stroke:#e74c3c;stroke-width:1'></line>" +
"<g class='ptpt node selfDot' fill-opacity='100%' transform='translate(65,76)'>"+
  // "<circle class='circle bktv' cx='0' cy='0' r='7.288888888888889' style='opacity: 0.5; fill: rgba(0, 0, 0, 0); stroke: rgb(0, 204, 255); stroke-width: 1px; display: inherit;'></circle>" +
  "<circle class='circle bktvi' r='3.6444444444444444' style='fill: rgb(0, 204, 255); display: inherit;'></circle>"+
"</g>" +

/**** AGREE ****/
"<g class='ptpt node' fill-opacity='100%' transform='translate(40.6975366341736,290.01621449977468) scale(2)'>"+
  // "<polygon class='up bktv' points='-3.6444444444444444,1.8222222222222222 3.6444444444444444,1.8222222222222222 0,-4.490140720917687' style='fill: rgb(0, 181, 77); fill-opacity: 0.2; display: inherit;'></polygon>"+
  "<polygon class='up bktvi' points='-3.6444444444444444,1.8222222222222222 3.6444444444444444,1.8222222222222222 0,-4.490140720917687' style='fill: rgb(0, 181, 77); display: inherit;'></polygon>"+
"</g>"+

/**** DISAGREE ****/
"<g class='ptpt node' fill-opacity='100%' transform='translate(70.5164952631261,334.686456499723942) scale(2)'>"+
  // "<polygon class='down bktv' points='-3.6444444444444444,-1.8222222222222222 3.6444444444444444,-1.8222222222222222 0,4.490140720917687' style='fill: rgb(231, 76, 60); fill-opacity: 0.2; display: inherit;'></polygon>"+
  "<polygon class='down bktvi' points='-3.6444444444444444,-1.8222222222222222 3.6444444444444444,-1.8222222222222222 0,4.490140720917687' style='fill: rgb(231, 76, 60); display: inherit;'></polygon>"+
"</g>"+



"</svg>");


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

    overlay_layer.append("polyline")
        .classed("helpArrow", true)
        .classed("helpArrowLine", true)
        .style("display", "none")
        ;
    w = $(el_selector).width() - xOffset;
    h = $(el_selector).height();
}


// function zoom() {
//   // TODO what is event?
//   visualization.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
// }

window.vis = visualization; // TODO why? may prevent GC

strokeWidth = strokeWidthGivenVisWidth(w);
charge = chargeForGivenVisWidth(w);

queryResults = $(el_queryResultSelector).html("");

// } else {
    // queryResults = $(el_queryResultSelector).html("");

$(el_queryResultSelector).hide();

    //$(el_selector).prepend($($("#pca_vis_overlays_template").html()));

var useForce = !isMobile && !isIE8;
// var useForce = false;
if (useForce) {
    force = d3.layout.force()
        .nodes(nodes)
        .links([])
        .friction(0.9) // more like viscosity [0,1], defaults to 0.9
        .gravity(0)
        .charge(charge) // slight overlap allowed
        .size([w, h]);
}

// function zoomToHull(d){

//     var b = bounds[d.hullId];
//     visualization.transition().duration(750)
//     //.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
//     .attr("transform", "" + "scale(" + 0.95 / Math.max((b[1][0] - b[0][0]) / w, (b[1][1] - b[0][1]) / h) + ")" + "translate(" + -(b[1][0] + b[0][0]) / 2 + "," + -(b[1][1] + b[0][1]) / 2 + ")");
//     //visualization.attr("transform", "translate(10,10)scale(" + d3.event.scale + ")");
// }


// compute how somilar the membership vectors are between two clusters.
// similarity = (bothHave+1) / (longerArray.length + 1)
function clusterSimilarity(a, b) {

// clusters [[2,3,4],[1,5]]
    var longerLength = Math.max(a.length, b.length);
    var ai = 0;
    var bi = 0;
    var bothHave = 0;

    while (ai < a.length) {

        if (bi >= b.length) {
            break;
        }
        var aa = a[ai];
        var bb = b[bi];
        if (aa === bb) {
            bothHave += 1;
            ai += 1;
            bi += 1;
        }
        else if (aa > bb){
            bi += 1;
        }
        else if (bb > aa) {
            ai += 1;
        }
    }

    return (bothHave + 1) / (longerLength + 1);
}

console.log("expect: " + (3/5));
console.log(clusterSimilarity([2,3,4], [2,4,7,8]));


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

function handleOnClusterClicked(hullId) {
    // // if the cluster/hull just selected was already selected...    
    // if (selectedCluster === hullId) {                 
    //   return resetSelection();
    // }
    dismissHelp();

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
            if (!bucket) {
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
        var r = chooseCircleRadiusOuter(xyPair[2]);  // + 5?
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
                        shadowStrokeWidth = "0px";
                        color = "#e9f0f7";
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
        var k = 0.1 * e.alpha;
        // if (k <= 0.004) { return; } // save some CPU (and save battery) may stop abruptly if this thresh is too high
        nodes.forEach(function(o) {
          //o.x = o.targetX;
          //o.y = o.targetY;
          if (!o.x) { o.x = w/2; }
          if (!o.y) { o.y = h/2; }  
          o.x += (o.targetX - o.x) * k;
          o.y += (o.targetY - o.y) * k;
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
    return shouldDisplayCircle(d) ? "inherit" : "none";
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

function chooseFill(d) {
    // if (commentIsSelected()) {
    //     if (d.effects === -1) {  // pull
    //         return colorPull;
    //     } else if (d.effects === 1) { // push
    //         return colorPush;
    //     }
    // }

    if (isSelf(d)) {
        return colorSelf;
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

        return colorNoVote;
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

function chooseUpArrowPath(d) {
    if (!d.ups) { return; }
    var scale = bucketRadiusForCount(d.ups || 0);

    var scaleDowns = bucketRadiusForCount(d.downs || 0);

    var sum = scale + scaleDowns;
    var yOffset = scale - sum/2;

    return makeArrowPoints(scale, yOffset, true);
}

function chooseDownArrowPath(d) {
    if (!d.downs) { return; }
    var scale = bucketRadiusForCount(d.downs || 0);
    var scaleUps = bucketRadiusForCount(d.ups || 0);
    var sum = scale + scaleUps;
    var yOffset = scaleUps - sum/2;
    return makeArrowPoints(scale, yOffset, false);
}


function makeArrowPoints2(scale, shouldFlipY, originX, originY) {
    var left = -scale;
    var right = scale;
    // equilateral triangle
    var top = Math.sqrt(3 * right * right);
    if (shouldFlipY) {
        top *= -1;
    }
    top += originY;
    var bottom = originY;
    right += originX;
    left += originX;

    var f = function(x) {
        return Math.floor(x*10)/10;
    };

    var leftBottom = f(left) + " " + f(bottom);
    var rightBottom = f(right) + " " + f(bottom);
    var center = f(originX) + " " + f(top);
    var s =  "M " + leftBottom + " L " + rightBottom + " L " + center + " L " + leftBottom + " Z";
    return s;
}

function chooseUpArrowPath2(ups, originX, originY) {
    if (!ups) { return; }
    var scale = bucketRadiusForCount(ups || 0);
    return makeArrowPoints2(scale, true, originX, originY);
}

function chooseDownArrowPath2(downs, originX, originY) {
    if (!downs) { return; }    
    var scale = bucketRadiusForCount(downs || 0);
    return makeArrowPoints2(scale, false, originX, originY);
}




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


function chooseCircleRadius(d) {
    return bucketRadiusForCount(d.count);
}
function chooseCircleRadiusOuter(d) {
    var r = chooseCircleRadius(d);
    if (isSelf(d)) {
        r *= 2;
    }
    return r;
}




function isSelf(d) {
    return !!d.containsSelf;
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
function upsertNode(updatedNodes, newClusters, newParticipantCount) {
    console.log("upsert");

    participantCount = newParticipantCount;

    var MIN_PARTICIPANTS_FOR_VIS = 8;
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
            .attr("font-size", (display.xs()||display.sm()) ? ".9em" : "28px")
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
    //nodes.set(node.pid, node);


    // migrate an existing cluster selection to the new similar cluster
    // var readyToReselectComment = $.Deferred().resolve();
    // if (selectedCluster !== false) {

    //     var currentSelectedCluster = clusters[selectedCluster];

    //     var nearestCluster = argMax(
    //         _.partial(clusterSimilarity, currentSelectedCluster),
    //         newClusters);

    //     var nearestClusterId = newClusters.indexOf(nearestCluster);
    //     clusters = newClusters;
    //     readyToReselectComment = setClusterActive(nearestClusterId);
    // } else {
        clusters = newClusters;
    // }

    for (var c = 0; c < clusters.length; c++) {
        var cluster = clusters[c];
        for (var b = 0; b < cluster.length; b++) {
            bidToGid[cluster[b]] = c;
        }
    }
    
    // readyToReselectComment.done(function() {
    //     if (commentIsSelected()) {
    //         selectComment(selectedTid);
    //     }
    // });


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
    var maxRad = bucketRadiusForCount(maxCount);

  function createScales(updatedNodes) {
    var spans = computeXySpans(updatedNodes);
    var border = maxRad + strokeWidth + 15;
    return {
        x: d3.scale.linear().range([0 + border, w - border]).domain([spans.x.min - eps, spans.x.max + eps]),
        y: d3.scale.linear().range([0 + border, h - border]).domain([spans.y.min - eps, spans.y.max + eps])
    };
  }
    // TODO pass all nodes, not just updated nodes, to createScales.
    var scales = createScales(updatedNodes);
    var scaleX = scales.x;
    var scaleY = scales.y;

    var oldpositions = nodes.map( function(node) { return { x: node.x, y: node.y, bid: node.bid }; });

    function sortWithSelfOnTop(a, b) {
        if (isSelf(a)) {
            return Infinity;
        }
        if (isSelf(b)) {
            return -Infinity;
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
    console.log("number of people: " + nodes.length);

    oldpositions.forEach(function(oldNode) {
        var newNode = _.findWhere(nodes, {bid: oldNode.bid});
        if (!newNode) {
            console.error("not sure why a node would dissapear");
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





    // // simplify debugging by looking at a single node
    // //nodes = nodes.slice(0, 1);
    // // check for unexpected changes in input
    // if (window.temp !== undefined) {
    //     if (key(window.temp) !== key(nodes[0])) {
    //         console.log("changed key");
    //         console.dir(window.temp);
    //         console.dir(nodes[0]);
    //     }
    //     if (!_.isEqual(window.temp.proj, nodes[0].proj)) {
    //         console.log("changed projection");
    //         console.dir(window.temp);
    //         console.dir(nodes[0]);
    //     }
    //     window.temp = nodes[0];
    // }

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
          .on("click", onParticipantClicked)
          .on("mouseover", showTip)
          .on("mouseout", hideTip)
          // .call(force.drag)
      ;


    if (inVisLegendCounter === 0) {
      inVisLegendCounter = 1;
      var helpStrokeWidth = display.xs() ? 1 : 2;

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
        .text("you")
        .attr("text-anchor", "start")
        // .attr("fill", "rgba(0,0,0,1.0)")
        .attr("fill", colorSelf)
        .attr("stroke", colorSelfOutline)
        .attr("transform", function(d) {
            return "translate(12, 4)";
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
      var circleEnter = g.append("circle")
        .classed("circle", true)
        .classed("bktv", true)
        .attr("cx", 0)
        .attr("cy", 0)
      //   .style("opacity", opacityOuter)
      //   .style("fill", chooseFill)
        .filter(isSelf)
            .style("fill", "rgba(0,0,0,0)")
            .style("stroke", colorSelf)
            .style("stroke-width", 1)
            .style("opacity", 0.5)
        ;

      // INNER SCALE-CHANGING SHAPES
      var upArrowEnterInner = g.append("polygon")
        .classed("up", true)
        .classed("bktvi", true)
        .style("fill", colorPull)
        ;

      var downArrowEnterInner = g.append("polygon")
        .classed("down", true)
        .classed("bktvi", true)
        .style("fill", colorPush)
        ;

      var circleEnterInner = g.append("circle")
        .classed("circle", true)
        .classed("bktvi", true)
        .style("fill", chooseFill)
        ;

      var self = g.filter(isSelf);
      self.classed("selfDot", true);



      // var r = chooseCircleRadius(biggestNode);
      // var legendCirclesG = main_layer.selectAll(".legendCircle").data([biggestNode]);
      // legendCirclesG.enter()
      //   .append(groupTag)
      //   .classed("legendCircle", true)
      //   .attr("transform", "translate("+ (w-10) +","+ (h-10)+")");
      //   ;

      // var USE_LEGEND_CIRCLES = false;
      // var legendCircles = !USE_LEGEND_CIRCLES ? false : legendCirclesG.selectAll("circle").data([biggestNode]);
      // if (legendCircles) {
      //   legendCircles.enter().append("circle")
      //     .style("fill", "rgba(0,0,0,0)")
      //     .style("stroke", "#bbb")
      //     .style("stroke-dasharray", "5,5")
      //     .style("stroke-width", 1);
      // }

    //   var legendText = legendCirclesG.selectAll("text").data([biggestNode]);
    //     legendText.enter()
    //       .append("text")
    //       .attr("text-anchor", "end");

    // function labelText(d) {
    //     return participantCount + (participantCount === 1 ? " person" : " people");
    // }

    // // update
    // if (legendCircles) {
    //     legendCircles
    //         .attr("cx", -(r+2))
    //         .attr("cy", -r+2)
    //         .attr("r", r)
    //       ;
    // }
    // var legendCircleCircumference = legendCircles ? 2*r : 0;
    // legendText
    //     .text(labelText)
    //     .attr("fill", "#bbb")
    //     .attr("transform", "translate("+ 
    //         (-(legendCircleCircumference + 10)) +
    //         ",0)");

  }
  updateNodes();


  // update
  //     .attr("transform", chooseTransform)
  //     .selectAll("path")
  //         .attr("d", chooseShape)
  //         .style("stroke-width", strokeWidth)
  //         .style("stroke", chooseStroke)
  //         .style("fill", chooseFill)
  //     ;




  // visualization.selectAll(".ptpt")
  //       .transition()
  //       .duration(500)
  //       .style("fill", chooseFill)
  //       .transition()
  //         .duration(500);


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
function dismissHelp() {



    // var circleUpdate = update.selectAll(".circle.bktv").data(nodes, key)

    //   .style("display", chooseDisplayForOuterCircle)
    //   .attr("r", chooseCircleRadiusOuter)
    //   .style("fill", chooseFill)
    //   .style("fill-opacity", 0.5)
    //   .filter(isSelf)
    //       .style("display", chooseDisplayForCircle)
    //       .style("fill-opacity", 0)
    //       .attr("r", chooseCircleRadiusOuter)
    //       // .style("fill", chooseFill)
    //       ;
    if (!visBlockerOn && !voteMoreOn) {
        var help = visualization.selectAll(".help");
        help.style("display", "none");
        onInVisLegendShownCallbacks.fire(inVisLegendCounter);
        if (inVisLegendCounter === 1) {
            var dfdHideShadows = $.Deferred();
            d3.selectAll(".hull_selection").transition().style("opacity", 0);
            d3.selectAll(".hull_shadow").transition().style("opacity", 0).each("end", dfdHideShadows.resolve);
            dfdHideShadows.done(function() {
                d3.selectAll(".hull").transition().style("opacity", 0).duration(500);
            });
            dotsShouldWiggle = true;
            wiggleUp();
            showHintOthers();
            inVisLegendCounter += 1;
        } else {
            var dfd = $.Deferred();
            d3.selectAll(".hull").transition().style("opacity", 1).each("end", dfd.resolve);
            dfd.done(function() {
                d3.selectAll(".hull_selection").transition().style("opacity", 1);
                d3.selectAll(".hull_shadow").transition().style("opacity", 1);
            });
            dotsShouldWiggle = false;
            hideHintOthers();
        }
    }
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
    // alert(1);
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

              // var commonUpdate = update.selectAll(".node > .bktv")
              //     ;
              // var commonUpdateInner = update.selectAll(".node > .bktvi")
              //     // .style("stroke-width", strokeWidth)
              //     // .style("stroke", chooseStroke)
              //     // .style("transform", "scale(0.5)")
              //     ;

      // var upArrowUpdate = update.selectAll(".up.bktv").data(nodes, key)
      //     .style("display", chooseDisplayForArrows)
      //     .attr("points", chooseUpArrowPath)
      //     // .style("fill", colorPull)
      //     ;
        var upArrowUpdateInner = update.selectAll(".up.bktvi").data(nodes, key)
          .style("display", chooseDisplayForArrows)
          .attr("points", chooseUpArrowPath) // NOTE: using tranform to select the scale
          ;

      // var downArrowUpdate = update.selectAll(".down.bktv").data(nodes, key)
      //     .style("display", chooseDisplayForArrows)
      //     .attr("points", chooseDownArrowPath)
      //     // .style("fill", colorPush)
      //     ;
    
        var downArrowUpdateInner = update.selectAll(".down.bktvi").data(nodes, key)
          .style("display", chooseDisplayForArrows)
          .attr("points", chooseDownArrowPath) // NOTE: using tranform to select the scale
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
  }
  // showLineToCluster("foo");

  // visualization.selectAll(".node")
  //   .attr("transform", chooseTransform)
  //   .selectAll("path")
  //       .style("stroke", chooseStroke)
  //       .style("fill", chooseFill)
  //       .style("fill-opacity", chooseAlpha)
  //       // .attr("r", chooseRadius)
  //       .attr("d", chooseShape)
  //   ;

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
  // visualization.transition().duration(750).attr("transform", "");
  // selectedBids = [];
  // resetSelectedComment();
  // unhoverAll();
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
  dismissHelp();
}

var visBlockerOn = false;
function showVisBlocker() {
    visBlockerOn = true;

    blocker_layer.append("rect")
        .classed("visBlocker", true)
        .style("fill", "rgb(52, 152, 219)")
        .attr("x", 1) // inset so it doesn't get cut off on firefox
        .attr("y", 1) // inset so it doesn't get cut off on firefox
        .attr("width", w-2) // inset so it doesn't get cut off on firefox
        .attr("height", h-2) // inset so it doesn't get cut off on firefox
        .style("stroke", "lightgray")
        .attr("rx", 5)
        .attr("ry", 5)
    ;
    blocker_layer.append("text")
            .classed("visBlocker", true)
            .classed("visBlockerMainText", true)
            .attr("text-anchor", "middle")
            .attr("fill", "#fff")
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
            .attr("fill", "#fff")
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


var voteMoreOn = false;
function showHintVoteMoreBlocker() {
    voteMoreOn = true;

    blocker_layer.append("rect")
        .classed("hintVoteMore", true)
        .style("fill", "rgb(52, 152, 219)")
        .attr("x", 1) // inset so it doesn't get cut off on firefox
        .attr("y", 1) // inset so it doesn't get cut off on firefox
        .attr("width", w-2) // inset so it doesn't get cut off on firefox
        .attr("height", h-2) // inset so it doesn't get cut off on firefox
        .style("stroke", "lightgray")
        .attr("rx", 5)
        .attr("ry", 5)
    ;
    blocker_layer.append("text")
            .text("Welcome! start by voting on a couple of comments")
            .classed("hintVoteMore", true)
            .classed("hintVoteMoreMainText", true)
            .attr("text-anchor", "middle")
            .attr("fill", "#fff")
            .attr("transform", "translate("+ 
                w/2 +
                "," + (9*h/24) + ")")
    ;
    blocker_layer.append("text")
            .classed("hintVoteMore", true)
            .classed("hintVoteMoreGraphic", true)
            .attr("transform", "translate("+ 
                w/2 +
                "," + (15*h/24) +")")
            .attr("text-anchor", "middle")
            .attr("fill", "#fff")
        .attr('font-family', 'FontAwesome')
        .attr('font-size', function(d) { return '2em'} )
        ;

}

function hideHintVoteMoreBlocker() {
    voteMoreOn = false;

    blocker_layer.selectAll(".hintVoteMore")
        .remove()
    ;
}

function showHintOthers() {

    // Don't show self when explaining others
    visualization.selectAll(".node")
        .filter(isSelf)
        .style("opacity", 0);

    blocker_layer.append("text")
            .text("other participants")
            .classed("hintOthers", true)
            .attr("text-anchor", "middle")
            .attr("fill", "#222")
            .attr("transform", "translate("+ 
                w/2 +
                "," + (9*h/24) + ")")
    ;
}

function hideHintOthers() {

    visualization.selectAll(".node")
        .filter(isSelf)
        .style("opacity", 1);

    blocker_layer.selectAll(".hintOthers")
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
    var center = centerOfCluster(gid);
    center[0] += xOffset;

    center = center.join(",");
    overlay_layer.selectAll(".helpArrow")
        .style("display", "block")
        .style("stroke", "#222")
        .attr("marker-end", "url(#ArrowTip)")
        // .attr("marker-start", "url(#ArrowTip)")
        .attr("points", ["-2," + clusterPointerOriginY, center].join(" "));
}

function onHelpTextClicked() {
    overlay_layer.selectAll(".helpArrow")
        .style("display", "none");
    // $(".helpArrow").addClass("hidden");
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

// setTimeout(selectBackground, 1);

function getSelectedGid() {
    return selectedCluster;
}

function selectGroup(gid) {
    handleOnClusterClicked(gid);
}

onInVisLegendShownCallbacks = $.Callbacks();

return {
    onInVisLegendShown: onInVisLegendShownCallbacks.add,
    upsertNode: upsertNode,
    onSelfAppears: onSelfAppearsCallbacks.add,
    deselect: selectBackground,
    selectComment: selectComment,
    selectGroup: selectGroup,
    showLineToCluster: showLineToCluster,
    emphasizeParticipants: emphasizeParticipants,
    showHintVoteMoreBlocker: showHintVoteMoreBlocker,
    hideHintVoteMoreBlocker: hideHintVoteMoreBlocker,
    getSelectedGid: getSelectedGid,
};

};
