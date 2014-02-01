
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var VisView = function(params){

var el_selector = params.el;
var el_queryResultSelector = params.el_queryResultSelector;
var getCommentsForSelection = params.getCommentsForSelection;
var getReactionsToComment = params.getReactionsToComment;
var getUserInfoByPid = params.getUserInfoByPid;
var getTotalVotesByPidSync = params.getTotalVotesByPidSync;
var computeXySpans = params.computeXySpans;

// var getPid = params.getPid;

function getBid(d) {
    return d.bid;
}



var clusterClickedCallbacks = $.Callbacks();
var onSelfAppearsCallbacks = $.Callbacks();
var selfHasAppeared = false;

// The h and w values should be locked at a 1:2 ratio of h to w
var h;
var w;
var nodes = [];
var clusters = [];
var hulls = [];
var visualization;
var main_layer;
var overlay_layer;
//var g; // top level svg group within the vis that gets translated/scaled on zoom
var force;
var queryResults;
var d3Hulls;
var d3CommentList;

var selectedCluster = false;
var selectedBids = [];
var selectedTid = -1;

// number of votes by the participant who has voted the most.
var maxVoteCount = 0;



var updatesEnabled = true;

var isIE8 = navigator.userAgent.match(/MSIE 8/);

if (isIE8) {
    $(el_selector).html(
        "<div class='visualization' style='width:100%;height:100%;'><center>" +
        "Apologies, the visualization is not available on IE 8.</br>" +
        "Get the full experience on IE 10+, Chrome, Firefox, or on your iOS / Android browser.</br>" +
        "</center></div>");
    return {
        upsertNode: function() {},
        addClusterTappedListener: function() {},
        emphasizeParticipants: function() {}
    };
}


// Tunables
var baseNodeRadiusScaleForGivenVisWidth = d3.scale.linear().range([3, 7]).domain([350, 800]).clamp(true);
var chargeForGivenVisWidth = d3.scale.linear().range([-1, -10]).domain([350, 800]).clamp(true);
var strokeWidthGivenVisWidth = d3.scale.linear().range([0.2, 1.0]).domain([350, 800]).clamp(true);

// Cached results of tunalbes - set during init
var strokeWidth;
var baseNodeRadius;
// Since initialize is called on resize, clear the old vis before setting up the new one.
$(el_selector).html("");

/* d3-tip === d3 tooltips... [[$ bower install --save d3-tip]] api docs avail at https://github.com/Caged/d3-tip */
var tip = null;
if (!isIE8) {
    $("#ptpt-tip").remove();
    tip = d3.tip().attr("id", "ptpt-tip").attr("stroke", "rgb(52,73,94)").html(
        function(d) {
            // use the email address as the html
            return d.ppl.map(function(p) {
                return p.pid;
            }).map(getUserInfoByPid).map(function(user) {
                return user.email;
            }).join("<br/>");
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


var dimensions = {
    width: "100%",
    height: "100%"
};

if (isIE8) {
    // R2D3 seems to have trouble with percent values.
    // Hard-coding pixel values for now.
    dimensions = {
        width: "500px",
        height: "300px"
    };
}




$(el_selector)
  .append("<svg>" +
    "<defs>" +
        "<marker class='helpArrow' id='ArrowTip'" +
                "viewBox='0 0 10 10'" +
                "refX='1' refY='5'" +
                "markerWidth='5'" +
                "markerHeight='5'" +
                "orient='auto'>" +
            "<path d='M 0 0 L 10 5 L 0 10 z' />" +
        "</marker>" +
    "</defs>" +
    "</svg>")
  ;

  setTimeout(function() {
      $(el_selector).append(
        "<div id='helpTextBox' class='unselectable hidden'>" +
            "<button type='button' class='close' aria-hidden='true'>&times;</button>" +
            "<span id='helpTextMessage'></span>" +
            "</div>")
      .on("click", onHelpTextClicked);
    }, 100);

//create svg, appended to a div with the id #visualization_div, w and h values to be computed by jquery later
//to connect viz to responsive layout if desired
visualization = d3.select(el_selector).select("svg")
      .call( tip || function(){} ) /* initialize d3-tip */
      // .attr("width", "100%")
      // .attr("height", "100%")
      .attr(dimensions)
      // .attr("viewBox", "0 0 " + w + " " + h )
      .classed("visualization", true)
      .on("click", selectBackground)
        .append("g")
            // .call(d3.behavior.zoom().scaleExtent([1, 8]).on("zoom", zoom))
;

main_layer = visualization.append("g");
overlay_layer = visualization.append("g");

overlay_layer.append("polyline")
    .classed("helpArrow", true)
    .classed("helpArrowLine", true)
    .style("display", "none")
    ;

 setTimeout(function() {
    var selfNode = _.filter(nodes, isSelf)[0];
    displayHelpItem("The dots are people. The blue dot is you. Try hovering!", selfNode);
}, 3000);

// function zoom() {
//   // TODO what is event?
//   visualization.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
// }

window.vis = visualization; // TODO why? may prevent GC
w = $(el_selector).width();
h = $(el_selector).height();

strokeWidth = strokeWidthGivenVisWidth(w);
baseNodeRadius = baseNodeRadiusScaleForGivenVisWidth(w);
charge = chargeForGivenVisWidth(w);

queryResults = d3.select(el_queryResultSelector).html("")
    .append("ol")
    .classed("query_results", true);

$(el_queryResultSelector).hide();

    //$(el_selector).prepend($($("#pca_vis_overlays_template").html()));

force = d3.layout.force()
    .nodes(nodes)
    .links([])
    .friction(0.9) // more like viscosity [0,1], defaults to 0.9
    .gravity(0)
    .charge(charge) // slight overlap allowed
    .size([w, h]);

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
    var pids;
    if (clusterId === false) {
        pids = [];
    } else {
        pids = clusters[clusterId];
    }
    selectedPids = pids;
    selectedCluster = clusterId;
    var promise = getCommentsForSelection(pids)
      .pipe( // getCommentsForSelection with clusters array (of pids)
        renderComments,                                 // !! this is tightly coupled.
                            // !! it makes sense to keep this in the view because
                                                        // !! we have to come BACK to the viz from the
                                                        // !! backbonified list, then. Not worth it?
        function(err) {
          console.error(err);
          resetSelection();
        })
      //.done(unhoverAll)
      ;
    
    // duplicated at 938457938475438975
    main_layer.selectAll(".active").classed("active", false);

    // d3.select(this)
    //     .style("fill","lightgreen")
    //     .style("stroke","lightgreen");

    return promise;
}

function updateHullColors() {
    if (selectedCluster !== false) {
       d3.select(d3Hulls[selectedCluster][0][0]).classed("active", true);
    }
}

function onClusterClicked(d) {
    $("#analyzeTab").tab("show");
    if (selectedCluster === d.hullId) {                 // if the cluster/hull just selected was already selected...
      return resetSelection();
    } else {
        resetSelectedComment();
        unhoverAll();
        setClusterActive(d.hullId)
            .then(
                updateHulls,
                updateHulls);

        updateHullColors();
    }

    //zoomToHull.call(this, d);
    if (d3.event.stopPropagation) {
        d3.event.stopPropagation();
    }
    if (d3.event.preventDefault) {
        d3.event.preventDefault(); // prevent flashing on iOS
    }
}

d3Hulls = _.times(9, function() {
    return main_layer.append("path")
        .classed("hull", true)
        .on("click", onClusterClicked)  //selection-results:1 handle the click event
    ;
});

function updateHulls() {
    var bidToPerson = _.object(_.pluck(nodes, "bid"), nodes);
    hulls = clusters.map(function(cluster) {
        var top = Infinity;
        var bottom = -Infinity;
        var right = -Infinity;
        var left = Infinity;
        var temp = cluster.map(function(pid) {
            var x = bidToPerson[pid].x;
            var y = bidToPerson[pid].y;
            return [x, y];
        });

        return temp;
    });

    function makeHullShape(stuff) {
        return "M" + stuff.join("L") + "Z";
    }
    // update hulls
    for (var i = 0; i < hulls.length; i++) {
        var d3Hull = d3Hulls[i];
        var hull = hulls[i];
        var stuff = d3.geom.hull(hull);
        stuff.hullId = i; // NOTE: d is an Array, but we're tacking on the hullId. TODO Does D3 have a better way of referring to the hulls by ID?
        d3Hull.datum(stuff).attr("d", makeHullShape(stuff));
    }
    updateHullColors();
}

force.on("tick", function(e) {
      // Push nodes toward their designated focus.
      var k = 0.1 * e.alpha;
      //if (k <= 0.004) { return; } // save some CPU (and save battery) may stop abruptly if this thresh is too high
      nodes.forEach(function(o) {
          //o.x = o.data.targetX;
          //o.y = o.data.targetY;
          if (!o.x) { o.x = w/2; }
          if (!o.y) { o.y = h/2; }
          o.x += (o.data.targetX - o.x) * k;
          o.y += (o.data.targetY - o.y) * k;
      });

      main_layer.selectAll("g")
        .attr("transform", chooseTransformForRoots);

    updateHulls();
});

window.P.stop = function() {
    if (window.P.stop) {
        window.P.stop();
    }
    updatesEnabled = false;
};

// function chooseRadius(d) {
//   var r = baseNodeRadius;
//     if (isSelf(d)){
//         return r += 2;
//     }
//     if (d.data && d.data.participants) {
//         return r + d.data.participants.length * 5;
//     }
//     return r;
// }
var colorPull = "#2ecc71"; // EMERALD
var colorPush = "#e74c3c"; // ALIZARIN
var colorPass = "#BDC3C7"; // SILVER
var colorSelf = "#0CF"; // blue - like the 'you are here' in mapping software
var colorNoVote = colorPass;
var colorSelfOutline = d3.rgb(colorSelf).darker().toString();


function chooseDisplayForCircle(d) {
    // Hide the circle so we can show the up/down arrows
    if (selectedTid >= 0) {
        return "none";
    }
    return "inherit";
}

function chooseDisplayForArrows(d) {
    // Hide the circle so we can show the up/down arrows
    if (selectedTid >= 0) {
        return "inherit";
    }
    return "none";
}

function chooseFill(d) {
    // if (selectedTid >= 0) {
    //     if (d.effects === -1) {  // pull
    //         return colorPull;
    //     } else if (d.effects === 1) { // push
    //         return colorPush;
    //     }
    // }

    if (isSelf(d)) {
        return colorSelf;
    } else {
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

function commentIsSelected() {
    return selectedTid >= 0;
}

function chooseAlpha(d) {
    if (commentIsSelected()) {
        // if (d.effects === undefined) {
        //     // no-vote
        //     // This should help differentiate a pass from a no-vote.
        //     return 0.5;
        // }
        // pass still gets full alpha
    } else {
        if (!isSelf(d)) {
            var voteCount = getTotalVotesByPidSync(d.pid);
            maxVoteCount = Math.max(voteCount, maxVoteCount);
            var ratio = (voteCount + 1) / (maxVoteCount + 1);
            scale = Math.max(0.3, ratio);
            return ratio;
        }
    }
    // isSelf or has voted on selected tid
    return 1;
}


function chooseTransformForRoots(d) {
   return "translate(" + d.x + "," + d.y + ")";
}

var offsetFactor = 4.9;
// function chooseTransformUpArrow(d) {
//     var scale = Math.sqrt(d.ups) * baseNodeRadius;
//     var yOffset = -offsetFactor * scale;
//     return "translate(0," + yOffset + ") scale(" + scale + ")";
// }

function makeArrowPoints(scale, shouldFlipY) {
    var left = -baseNodeRadius * scale;
    var right = baseNodeRadius * scale;
    // equilateral triangle
    var top = Math.sqrt(3 * right * right);
    var bottom = 0;
    if (shouldFlipY) {
        top *= -1;
    }
    var leftBottom = left + "," + bottom;
    var rightBottom = right + "," + bottom;
    var center = "0," + top;
    return leftBottom + " " + rightBottom + " " + center;
}

function chooseUpArrowPath(d) {
    var scale = Math.sqrt(d.ups || 0);
    return makeArrowPoints(scale, true);
}


// function chooseTransformDownArrow(d) {
//     var scale = Math.sqrt(d.downs) * baseNodeRadius;
//     var yOffset = offsetFactor * scale;
//     return "translate(0," + yOffset + ") scale(" + scale + ")";
// }
function chooseDownArrowPath(d) {
    var scale = Math.sqrt(d.downs || 0);
    return makeArrowPoints(scale, false);
}
function chooseCircleRadius(d) {
    return Math.sqrt(d.ppl.length) * baseNodeRadius * 0.8;
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


// function hasChanged(n1, n2) {
//     //return !_.isEqual(n1.data.projection, n2.data.projection);
//     var p1 = n1.data.projection;
//     var p2 = n2.data.projection;
//     for (var i = 0; i < p1.length; i++) {
//         if (Math.abs(p1[i] - p2[i]) > 0.01) {
//             return true;
//         }
//     }
//     return false;
// }


// clusters [[2,3,4],[1,5]]
function upsertNode(updatedNodes, newClusters) {
    if (!updatesEnabled) {
        return;
    }
    console.log("upsert");
    //nodes.set(node.pid, node);


    // migrate an existing cluster selection to the new similar cluster
    var readyToReselectComment = $.Deferred().resolve();
    if (selectedCluster !== false) {

        var currentSelectedCluster = clusters[selectedCluster];

        var nearestCluster = argMax(
            _.partial(clusterSimilarity, currentSelectedCluster),
            newClusters);

        var nearestClusterId = newClusters.indexOf(nearestCluster);
        clusters = newClusters;
        readyToReselectComment = setClusterActive(nearestClusterId);
    } else {
        clusters = newClusters;
    }

    readyToReselectComment.done(function() {
        if (selectedTid >= 0) {
            selectComment(selectedTid);
        }
    });


    function computeTarget(d) {
        //if (!isPersonNode(d)) {
            // If we decide to show the branching points, we could
            // compute their position as the average of their childrens
            // positions, and return that here.
            //return;
        //}

        d.x = d.data.targetX = scaleX(d.data.projection[0]);
        d.y = d.data.targetY = scaleY(d.data.projection[1]);
        return d;
    }


    var maxNodeRadius = 10 + 5;

  function createScales(updatedNodes) {
    var spans = computeXySpans(updatedNodes);
    var border = maxNodeRadius + w / 50;
    return {
        x: d3.scale.linear().range([0 + border, w - border]).domain([spans.x.min, spans.x.max]),
        y: d3.scale.linear().range([0 + border, h - border]).domain([spans.y.min, spans.y.max])
    };
  }
    // TODO pass all nodes, not just updated nodes, to createScales.
    var scales = createScales(updatedNodes);
    var scaleX = scales.x;
    var scaleY = scales.y;

    var oldpositions = nodes.map( function(node) { return { x: node.x, y: node.y, bid: node.bid }; });

    function sortWithSelfOnTop(a, b) {
        // if (isSelf(a)) {
        //     return -1;
        // }
        // if (isSelf(b)) {
        //     return 1;
        // }
        return key(b) - key(a);
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

    force.nodes(nodes, key).start();

    // simplify debugging by looking at a single node
    //nodes = nodes.slice(0, 1);
    // check for unexpected changes in input
    if (window.temp !== undefined) {
        if (key(window.temp) !== key(nodes[0])) {
            console.log("changed key");
            console.dir(window.temp);
            console.dir(nodes[0]);
        }
        if (!_.isEqual(window.temp.data.projection, nodes[0].data.projection)) {
            console.log("changed projection");
            console.dir(window.temp);
            console.dir(nodes[0]);
        }
        window.temp = nodes[0];
    }

// TODO use key to guarantee unique items

  var update = main_layer.selectAll("g")
      .data(nodes, key)
      .sort(sortWithSelfOnTop);

  // var exit = update.exit();
  // exit.remove();

  // ENTER
  var enter = update.enter();
  var g = enter
    .append("g")
      .classed("ptpt", true)
      .classed("node", true)
      .on("click", onParticipantClicked)
      .on("mouseover", showTip)
      .on("mouseout", hideTip)
  ;

  var upArrowEnter = g
      .append("polygon")
        .classed("up", true)
  ;



  var downArrowEnter = g
      .append("polygon")
        .classed("down", true)
  ;

  var circleEnter = g
      .append("circle")
        .classed("circle", true)
        .attr("cx", 0)
        .attr("cy", 0)
  ;

  g.filter(isSelf)
    .classed("selfDot", true)
  ;


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

  updateHulls();
}

function selectComment(tid) {
    selectedTid = tid;

    getReactionsToComment(tid)
      // .done(unhoverAll)
      .then(function(reactions) {
        var userToReaction = {};
        var i;
        for (i = 0; i < reactions.length; i++) {
            userToReaction[reactions[i].pid] = reactions[i];
        }
        for (i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            node.ups = 0;
            node.downs = 0;
            for (var p = 0; p < node.ppl.length; p++) {

                // TODO_MAXDOTS count up the reactions of each type for each user (instead of just ppl[0])
                var reaction = userToReaction[node.ppl[p].pid];
                if (reaction) {
                    if (reaction.vote === -1) {
                        node.ups += 1;
                    } else if (reaction.vote === 1) {
                        node.downs += 1;
                    }
                }
            }
        }
        updateNodes();
        // visualization.selectAll("g")
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
    d3CommentList
        .style("background-color", chooseCommentFill);
}

function chooseCommentFill(d) {
    if (selectedTid === d.tid) {
        return "#FFFBE8";
    } else {
        return "rgba(0,0,0,0)";
    }
}

function renderComments(comments) {

    var dfd = $.Deferred();

    if (comments.length) {
        $(el_queryResultSelector).show();
    } else {
        $(el_queryResultSelector).hide();
    }
    queryResults.html("");
    d3CommentList = queryResults.selectAll("li")
        .data(comments)
        .sort(function(a,b) { return b.freq - a.freq; });

    d3CommentList.enter()
        .append("li")
        .classed("query_result_item", true)
        .style("background-color", chooseCommentFill)
        .on("click", function(d) {
            selectComment(d.tid);
        })
        .text(function(d) { return d.txt; });

    d3CommentList.exit().remove();
    setTimeout(dfd.resolve, 4000);
    return dfd.promise();
}


function onParticipantClicked(d) {
    d3.event.stopPropagation();
    d3.event.preventDefault(); // prevent flashing on iOS
  // alert(getUserInfoByPid(d.pid).hname)
}

function unhoverAll() {
  console.log("unhoverAll");
  if (d3CommentList) {
    d3CommentList
      .style("background-color", chooseCommentFill);
  }
  // for (var i = 0; i < nodes.length; i++) {
  //     var node = nodes[i];
  //     node.ups = 0
  // }
  updateNodes();
}

function updateNodes() {
  var update = visualization.selectAll("g");
  var upArrowUpdate = update.selectAll(".up")
      .attr("points", chooseUpArrowPath)
      .style("stroke-width", strokeWidth)
      .style("stroke", chooseStroke)
      .style("fill", colorPull)
      .style("display", chooseDisplayForArrows)
  ;

  var downArrowUpdate = update.selectAll(".down")
      .attr("points", chooseDownArrowPath)
      .style("stroke-width", strokeWidth)
      .style("stroke", chooseStroke)
      .style("fill", colorPush)
      .style("display", chooseDisplayForArrows)
  ;
  var upCircleUpdate = update.selectAll(".circle")
      .attr("r", chooseCircleRadius)
      .style("stroke-width", strokeWidth)
      .style("stroke", chooseStroke)
      .style("fill", chooseFill)
      .style("display", chooseDisplayForCircle)
  ;
  
  var selfNode = _.filter(nodes, isSelf)[0];
  if (selfNode && !selfHasAppeared) {
    selfHasAppeared = true;
    onSelfAppearsCallbacks.fire();
  }

  // displayHelpItem("foo", selfNode);

  // visualization.selectAll("g")
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
  visualization.selectAll(".active").classed("active", false);
  selectedCluster = false;
  // visualization.transition().duration(750).attr("transform", "");
  renderComments([]);
  selectedBids = [];
  resetSelectedComment();
  unhoverAll();
}


function selectBackground() {
  selectedBids = [];
  resetSelectedComment();
  unhoverAll();

  setClusterActive(false)
    .then(
        updateHulls,
        updateHulls);

  updateHullColors();
}


// TODO account for Buckets
function emphasizeParticipants(pids) {
    console.log("pids", pids.length);
    var hash = []; // sparse-ish array
    for (var i = 0; i < pids.length; i++) {
        hash[pids[i]] = true;
    }

    function chooseStrokeWidth(d) {
        // If emphasized, maintain fill, (no stroke needed)
        if (hash[d.pid]) {
            return 0;
        }
        return 2;
    }
    function chooseStroke(d) {
        // If emphasized, maintain fill, (no stroke needed)
        if (hash[d.pid]) {
            return void 0; // undefined
        }
        return chooseFill(d);
    }
    function chooseFillOpacity(d) {
        // If emphasized, maintain fill, (no stroke needed)
        if (hash[d.pid]) {
            return 1;
        }
        return 0;
    }

    main_layer.selectAll("g")
      .selectAll("path")
        .attr("stroke", chooseStroke)
        .attr("stroke-width", chooseStrokeWidth)
        .attr("fill-opacity", chooseFillOpacity)
    ;
}


// MAke the help item's arrow a child of the elementToPointAt, and update its points to be from 0,0 to 

function displayHelpItem(txt, d) {

    var baseShouldIntersectEdge = true;
    var ratio = 0.8;
    var strokeWidth = 3;
    var extraY = -strokeWidth; // extend past the edge so it's flush (so you don't see the square base of the arrow)

    var baseX = w/3;
    var baseY = h - (baseShouldIntersectEdge ? extraY : 0);
    var tipX = d.x;
    var tipY = d.y;
    var dx = tipX - baseX;
    var dy = tipY - baseY;
    tipX = baseX + dx*ratio;
    tipY = baseY + dy*ratio;

    if (d) {
        overlay_layer.selectAll(".helpArrow")
            .style("display", "block")
            .attr("points", baseX + "," + baseY + " " + tipX + "," + tipY)
            .attr("marker-end", "url(#ArrowTip)");
    }

    // $(".helpArrow").removeClass("hidden");
    $("#helpTextBox").removeClass("hidden");
    $("#helpTextMessage").text(txt);
}

function onHelpTextClicked() {
    overlay_layer.selectAll(".helpArrow")
        .style("display", "none");
    // $(".helpArrow").addClass("hidden");
    $("#helpTextBox").addClass("hidden");
}


// window.foo = displayHelpItem;

// displayHelpItem("foo");

function emphasizeParticipants2(pids) {
}


setTimeout(selectBackground, 1);

return {
    upsertNode: upsertNode,
    onSelfAppears: onSelfAppearsCallbacks.add,
    addClusterTappedListener: clusterClickedCallbacks.add,
    emphasizeParticipants: emphasizeParticipants2
};

};
