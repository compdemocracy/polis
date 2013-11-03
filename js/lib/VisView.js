
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var PcaVis = function(params){

var el_selector = params.el;
var el_queryResultSelector = params.el_queryResultSelector;
var getPersonId = params.getPersonId;
var getCommentsForProjection = params.getCommentsForProjection;
var getCommentsForSelection = params.getCommentsForSelection;
var getReactionsToComment = params.getReactionsToComment;
var getUserInfoByPid = params.getUserInfoByPid;

var clusterClickedCallbacks = $.Callbacks();


// The h and w values should be locked at a 1:2 ratio of h to w
var h;
var w;
var nodes = [];
var clusters = [];
var hulls = [];
var bounds = []; // Bounding rectangles for each hull
var visualization;
var g; // top level svg group within the vis that gets translated/scaled on zoom
var force;
var queryResults;
var d3Hulls;

var selectedCluster;

var updatesEnabled = true;


// Tunables
var baseNodeRadiusScaleForGivenVisWidth = d3.scale.linear().range([2, 7]).domain([350, 800]).clamp(true);
var chargeForGivenVisWidth = d3.scale.linear().range([-1, -10]).domain([350, 800]).clamp(true);
var strokeWidthGivenVisWidth = d3.scale.linear().range([0.2, 2]).domain([350, 800]).clamp(true);

// Cached results of tunalbes - set during init
var strokeWidth;
var baseNodeRadius;
// Since initialize is called on resize, clear the old vis before setting up the new one.
$(el_selector).html("");

/* d3-tip === d3 tooltips... [[$ bower install --save d3-tip]] api docs avail at https://github.com/Caged/d3-tip */
$("#ptpt-tip").remove();
var tip = d3.tip().attr('id', 'ptpt-tip').attr('stroke', 'rgb(52,73,94)').html(function(d) { return getUserInfoByPid(d.pid).email; });

//create svg, appended to a div with the id #visualization_div, w and h values to be computed by jquery later
//to connect viz to responsive layout if desired
visualization = d3.select(el_selector)
    .append('svg')
      .call(tip) /* initialize d3-tip */
      .attr('width', "100%")
      .attr('height', "100%")
      .classed("visualization", true)
      .on('click', resetSelection)
        .append("g")
            // .call(d3.behavior.zoom().scaleExtent([1, 8]).on("zoom", zoom))
;
      

function zoom() {
  // TODO what is event?
  visualization.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
}

window.vis = visualization; // TODO why? may prevent GC
w = $(el_selector).width();
h = $(el_selector).height();

strokeWidth = strokeWidthGivenVisWidth(w);
baseNodeRadius = baseNodeRadiusScaleForGivenVisWidth(w);
charge = chargeForGivenVisWidth(w);

queryResults = d3.select(el_queryResultSelector).html("")
    .append('ol')
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

function zoomToHull(d){

    var b = bounds[d.hullId];
    visualization.transition().duration(750)
    //.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
    .attr("transform", "" + "scale(" + 0.95 / Math.max((b[1][0] - b[0][0]) / w, (b[1][1] - b[0][1]) / h) + ")" + "translate(" + -(b[1][0] + b[0][0]) / 2 + "," + -(b[1][1] + b[0][1]) / 2 + ")");
    //visualization.attr("transform", "translate(10,10)scale(" + d3.event.scale + ")");
}

function setClusterActive(d) {
    console.log("selectedCluster " + selectedCluster);  // log the cluster/hull currently selected, if any
    console.log("d.hullId " + d.hullId);                // log the id of the hull
    if (selectedCluster === d.hullId) {                 // if the cluster/hull just selected was already selected...
      console.log('unselecting');                       // ...tell everyone you're going to unselect it
      return resetSelection();                          // and resetSelection
    } else {                                            // otherwise
      getCommentsForSelection(clusters[d.hullId]).then( // getCommentsForSelection with clusters array (of pids)
        renderComments,                                 // !! this is tightly coupled. 
                                                        // !! it makes sense to keep this in the view because 
                                                        // !! we have to come BACK to the viz from the 
                                                        // !! backbonified list, then. Not worth it?
        function(err) {
          console.error(err);
        });
    }
    // duplicated at 938457938475438975
    visualization.selectAll(".active").classed("active", false);
    d3.select(this).classed("active", true);
 
    // d3.select(this)
    //     .style("fill","lightgreen")
    //     .style("stroke","lightgreen");

    selectedCluster = d.hullId;
}

function onClusterClicked(d) {
    unhoverAll();
    setClusterActive.call(this, d);  //selection-results:2 fire setClusterActive with onClusterClicked as the context, passing in d

    //zoomToHull.call(this, d);
    d3.event.stopPropagation();
    d3.event.preventDefault(); // prevent flashing on iOS

}

d3Hulls = _.times(9, function() {
    return visualization.append("path")
        .classed("hull", true)
        .on("click", onClusterClicked)  //selection-results:1 handle the click event
    ;
});

force.on("tick", function(e) {
      // Push nodes toward their designated focus.
      var k = 0.1 * e.alpha;
      //if (k <= 0.004) { return; } // save some CPU (and save battery) may stop abruptly if this thresh is too high
      nodes.forEach(function(o, i) {
          //o.x = o.data.targetX;
          //o.y = o.data.targetY;
          if (!o.x) { o.x = w/2; }
          if (!o.y) { o.y = h/2; }
          o.x += (o.data.targetX - o.x) * k;
          o.y += (o.data.targetY - o.y) * k;
      });

      // visualization.selectAll(".ptpt")
      //     .attr("cx", function(d) { return d.x;})
      //     .attr("cy", function(d) { return d.y;});

      visualization
        .selectAll(".ptpt")
        .attr("transform", function(d) {
          return "translate(" + d.x + "," + d.y + ")";
        });


    var pidToPerson = _.object(_.pluck(nodes, "pid"), nodes);
    bounds = [];
    hulls = clusters.map(function(cluster, clusterNumber) {
        var top = Infinity;
        var bottom = -Infinity;
        var right = -Infinity;
        var left = Infinity;
        var temp = cluster.map(function(pid) {
            var x = pidToPerson[pid].x;
            var y = pidToPerson[pid].y;
            // update bounds
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
            left = Math.min(left, x);
            right = Math.max(right, x);
            return [x, y];
        });
        // emulating this: https://github.com/mbostock/d3/wiki/Geo-Paths#wiki-bounds
        var b = [[left, bottom], [right, top]];

        bounds.push(b);
        return temp;
    });
    // update hulls
    for (var i = 0; i < hulls.length; i++) {
        var d3Hull = d3Hulls[i];
        var hull = hulls[i];
        var d = d3.geom.hull(hull);
        d.hullId = i; // NOTE: d is an Array, but we're tacking on the hullId. TODO Does D3 have a better way of referring to the hulls by ID?
        d3Hull.datum(d).attr("d", function(d) { return "M" + d.join("L") + "Z"; });
    }
});

function getOffsetX(e) {
    if (undefined !== e.offsetX) {
        return e.offsetX;
    } else {
        // Needed for FF
        return e.pageX - $(el_selector).offset().left; // TODO cache offset?
    }
}
function getOffsetY(e) {
    if (undefined !== e.offsetY) {
        return e.offsetY;
    } else {
        // Needed for FF
        return e.pageY - $(el_selector).offset().top; // TODO cache offset?
    }
}


window.P.stop = function() {
    if (window.P.stop) {
        window.P.stop();
    }
    updatesEnabled = false;
};

function chooseRadiusSelected(d) {
    return Math.max(chooseRadius(d) - 1, 0.5);
}
function chooseRadius(d) {
  var r = baseNodeRadius;
    if (isSelf(d)){
        return r += 5;
    } 
    if (d.data && d.data.participants) {
        return r + d.data.participants.length * 5;
    }
    return r;
}
function chooseFill(d) {
    var colorPull = "#2ecc71"; // EMERALD
    var colorPush = "#e74c3c"; // ALIZARIN
    var colorPass = "#BDC3C7"; // SILVER
    var colorSelf = "#D35400"; // PUMPKIN
    var colorNoVote = colorPass;

    if (d.effects !== undefined) {
        if (d.effects === -1) {  // pull
            return colorPull;
        } else if (d.effects === 1) { // push
            return colorPush;
        } else if (d.effects === 0){ // pass
            return colorPass;
        } else {
            console.error(3289213);
            return "purple";
        }
    } else { 
        if (isSelf(d)) {
            return colorSelf;
        } else {
            return colorNoVote;
        }
    }
}


function chooseShape(d) {
    if (d.effects !== undefined) {
        if (d.effects === -1) {  // pull
            return d3.svg.symbol().type("triangle-up")(d);
        } else if (d.effects === 1) { // push
            return d3.svg.symbol().type("triangle-down")(d);
        } else if (d.effects === 0){ // pass
            return d3.svg.symbol().type("circle")(d);
        } else {
            return d3.svg.symbol().type("circle")(d);
        }
    } else { 
        // if (isSelf(d)) {
            return d3.svg.symbol().type("circle")(d);
        // } else {
            // return d3.svg.symbol().type("circle");
        // }
    }
}


function chooseHullFill(d) {
    return "#ECF0F1";
}

function renderCommentsList(comments) {
    function renderComment(comment) {
        var template = $('#commentListItemTemplate').html();
        return Mustache.to_html(template, comment);
    }
    // TODO check out template partials "> foo"
    var x = "<ul>";
    for (var i = 0; i < comments.length; i++) {
        x += renderComment(comments[i]);
    }
    x += "</ul>";
    return x;
}

function isSelf(d) {
    return d.pid === getPersonId();
}



function hashCode(s){
    var hash = 0,
        i,
        char;
    if (s.length === 0) {
        return hash;
    }
    for (i = 0; i < s.length; i++) {
        char = s.charCodeAt(i);
        hash = ((hash<<5)-hash)+char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

var colorFromString = _.compose(d3.scale.category20(), function(s) {
    return hashCode(s) % 20;
});

function key(d) {
    return d.pid;
}


function hasChanged(n1, n2) {
    //return !_.isEqual(n1.data.projection, n2.data.projection);
    var p1 = n1.data.projection;
    var p2 = n2.data.projection;
    for (var i = 0; i < p1.length; i++) {
        if (Math.abs(p1[i] - p2[i]) > 0.01) {
            return true;
        }
    }
    return false;
}


// clusters [[4,3,2],[5,1]]
function upsertNode(updatedNodes, newClusters) {
    if (!updatesEnabled) {
        return;
    }
    console.log('upsert');
    //nodes.set(node.pid, node);

    clusters = newClusters;

    function computeTarget(d) {
        //if (!isPersonNode(d)) {
            // If we decide to show the branching points, we could
            // compute their position as the average of their childrens'
            // positions, and return that here.
            //return;
        //}

        d.x = d.data.targetX = scaleX(d.data.projection[0]);
        d.y = d.data.targetY = scaleY(d.data.projection[1]);
        return d;
    }


    var nodeRadius = 4;
    var maxNodeRadius = 10 + 5;

  function createScales(updatedNodes) {
    var spans = { 
        x: { min: Infinity, max: -Infinity },
        y: { min: Infinity, max: -Infinity }
    };
    for (var i = 0; i < updatedNodes.length; i++) {
        if (updatedNodes[i].data && updatedNodes[i].data.projection) {
            spans.x.min = Math.min(spans.x.min, updatedNodes[i].data.projection[0]);
            spans.x.max = Math.max(spans.x.max, updatedNodes[i].data.projection[0]);
            spans.y.min = Math.min(spans.y.min, updatedNodes[i].data.projection[1]);
            spans.y.max = Math.max(spans.y.max, updatedNodes[i].data.projection[1]);
        }
    }

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
 
    var oldpositions = nodes.map( function(node) { return { x: node.x, y: node.y, pid: node.pid }; });

    function sortWithSelfOnTop(a, b) {
        if (isSelf(a)) {
            return 1;
        }
        if (isSelf(b)) {
            return -1;
        }
        return key(a) - key(b);
    }


    nodes = updatedNodes.sort(sortWithSelfOnTop).map(computeTarget);
    console.log('number of people: ' + nodes.length);

    oldpositions.forEach(function(oldNode) { 
        var newNode = _.findWhere(nodes, {pid: oldNode.pid});
        if (!newNode) { 
            console.error('not sure why a node would dissapear');
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
            console.log('changed key');
            console.dir(window.temp);
            console.dir(nodes[0]);
        }
        if (!_.isEqual(window.temp.data.projection, nodes[0].data.projection)) {
            console.log('changed projection');
            console.dir(window.temp);
            console.dir(nodes[0]);
        }
        window.temp = nodes[0];
    }


  var circle = visualization.selectAll(".ptpt")
      .data(nodes);

  // ENTER
  circle
    .enter().append("path")
      .on("click", onParticipantClicked)
      .attr("d", d3.svg.symbol().type("circle"))
      // .attr("d", d3.svg.symbol().type("triangle-down"))
      // .attr("d", d3.svg.symbol().type("triangle-up"))
      .classed("node", true)
      .classed("enter", true)
      .classed("ptpt", true)
      //.each(function(d) {d.x = w/2; d.y = h/2;})
      .attr("r", chooseRadius)

/*
      .style("fill", function(d) {
            if (!isPersonNode(d)) {
                // only render leaves - may change? render large transucent circles? 
                return "rgba(0,0,0,0)";
            }
            var color = colorFromString(d.data && d.data.meta && d.data.meta.country || "");
            if (!color) {
                console.error(29384723897);
                return "black";
            }
            return color;
      })
*/
        .style("stroke-width", strokeWidth)
        .attr("transform", function(d) {
            return "translate(" + d.x + "," + d.y + ")";
        })
          // .attr("cx", function(d) {
          //   return d.x;
          // })
          // .attr("cy", function(d) {
          //   return d.y;
          // })
        .on('mouseover', tip.show)
        .on('mouseout', tip.hide)
        ;

 

      // UPDATE
      // TODO Can we do this less frequently?
      circle.classed("node", true);
      circle.classed("update", true)
        //.each(function(d) {
            //d.x = d.x !== undefined ? d.x : d.data.targetX;
            //d.y = d.y !== undefined ? d.y : d.data.targetY;
        //})
        //.style("stroke", function(d) {
            //if (!isPersonNode(d)) {
                //return;
            //}
            //return "darkgrey";
        //})
        .attr("r", chooseRadius) 
        .style("fill", function(d) { 
            //var distanceInPixels = Math.abs(this.cx.baseVal.value - d.data.targetX);
            //if (distanceInPixels > 30) {
                //return "lightgrey";
            //} else {
                return chooseFill(d);
            //}
        })
/*
        .style("r", function(d) {
            if (!isPersonNode(d)) {
                return;
            }
            //if (Math.abs(this.cx.baseVal.value - d.data.targetX) > 0.001) {
                //return 50;
            //} else {
                return nodeRadius;
            //}
        })
*/
;

  visualization.selectAll(".ptpt")
        .transition()
        .duration(500)
        //.style("stroke", "black")
        .style("fill", chooseFill)
        .transition()
          .duration(500)
          //.attr("opacity", function(d) {
          //return isPersonNode(d) ? 1 : 0;
          //})
          //.ease("quad")
          //.delay(100)
          //.transition()
           // .duration(500)
            //.style("fill", "black")
          ;

}

function renderComments(comments) {

        function onCommentClicked(d) {
            unhoverAll();
            d3CommentList.classed("query_result_item_hover", false);

            getReactionsToComment(d.tid).then(function(reactions) {
                var userToReaction = {};
                var i;
                for (i = 0; i < reactions.length; i++) {
                    userToReaction[reactions[i].pid] = reactions[i];
                }
                for (i = 0; i < nodes.length; i++) {
                    var node = nodes[i];

                    var reaction = userToReaction[node.pid];
                    if (reaction) {
                        node.effects = reaction.vote;
                        if (undefined === node.effects) {
                            node.effects = "blabla";
                        }
                    }
                }
                visualization.selectAll(".ptpt")
                  .style("fill", chooseFill)
                  .attr("d", chooseShape)
                ;
            }, function() {
                console.error('failed to get reactions to comment: ' + d._id);
            });
            $(this).addClass("query_result_item_hover");
        }
        if (comments.length) {
            $(el_queryResultSelector).show();
        } else {
            $(el_queryResultSelector).hide();
        }
        queryResults.html("");
        var d3CommentList = queryResults.selectAll("li")
            .data(comments)
            .sort(function(a,b) { return b.freq - a.freq; });

        d3CommentList.enter()
            .append("li")
            .classed("query_result_item", true)
            .on("click", onCommentClicked)
            .text(function(d) { return d.txt; });

        d3CommentList.exit().remove();
}


function onParticipantClicked(d) {
    d3.event.stopPropagation();
<<<<<<< HEAD
    d3.event.preventDefault(); // prevent flashing on iOS
=======
>>>>>>> Squillions of semicolon and whitespace changes part two.
  // alert(getUserInfoByPid(d.pid).hname)
}

function unhoverAll() {
    $(el_queryResultSelector).removeClass("query_result_item_hover");
    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        delete node.effects;
    }
    visualization.selectAll(".ptpt")
        .style("fill", chooseFill)
        .attr("d", chooseShape)
    ;
}

function resetSelection() {
  visualization.selectAll(".active").classed("active", false);
  selectedCluster = false;
  // visualization.transition().duration(750).attr("transform", "");
  renderComments([]);
  unhoverAll();
}

function emphasizeParticipants(pids) {
    var hash = []; // sparse-ish array
    for (var i = 0; i < pids.length; i++) {
        hash[pids[i]] = true;
    }

    function chooseOpacity(d) {
        if (hash[d.pid]) {
            return 1;
        }
        return 0.3;
    }

    visualization.selectAll(".ptpt")
        .attr("opacity", chooseOpacity);
}

return {
    upsertNode: upsertNode,
    addClusterTappedListener: clusterClickedCallbacks.add,
    emphasizeParticipants: emphasizeParticipants,
};

};