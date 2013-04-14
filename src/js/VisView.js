
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var PcaVis = (function(){

// The h and w values should be locked at a 1:2 ratio of h to w
var h;
var w;
var nodes = [];
var visualization;
var force;
var queryResults;

var el_selector;
var el_queryResultSelector;
var getPersonId;
var getCommentsForProjection;
var getCommentsForSelection;
var getReactionsToComment;

// hack_mouseout_replacement
// mouseout isn't reliable, so this is needed as part of optimizing
// a mousemove event catcher on the window, for mosuemoves that escape
// from the query results list. (indicating a mouseout)
var queryItemHoverOn = false;

var mouseDown = false;
var selectionRectangle = {
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0
};

var updatesEnabled = true;

// Tunables
var baseNodeRadiusScaleForGivenVisWidth = d3.scale.linear().range([1, 5]).domain([350, 800]).clamp(true);
var chargeForGivenVisWidth = d3.scale.linear().range([-1, -10]).domain([350, 800]).clamp(true);
var strokeWidthGivenVisWidth = d3.scale.linear().range([0.2, 2]).domain([350, 800]).clamp(true);

// Cached results of tunalbes - set during init
var strokeWidth;
var baseNodeRadius;



window.P.stop = function() {
    if (window.P.stop) {
        window.P.stop();
    }
    updatesEnabled = false;
};

function setCy(d) {
    if (o.y !== undefined) {
        return o.y;
    } else {
        console.log('y bad');
        return h/2;
    }
}

function setCx(d) {
    //console.log(d.id, d.data.projection[0]);
    if (o.x !== undefined) {
        return o.x;
    } else {
        console.log('x bad');
        return w/2;
    }
}

function chooseRadiusSelected(d) {
    return chooseRadius(d) + 2;
}
function chooseRadius(d) {
  var r = baseNodeRadius;
    if (isSelf(d)){
        return r += 5;
    }
    return r;
}
function chooseFill(d) {
    if (d.effects !== undefined) {
        if (d.effects===-1) {
            return "blue";
        } else if (d.effects === 1) {
            return "red";
        } else if (d.effects === 0){
            return "black";
        }
    } else { 
        if (isSelf(d)) {
            return "red";
        } else {
            return "black";
        }
    }
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
    return d.data.person_id === getPersonId();
}

function initialize(params) {
    console.log('init');
    el_selector = params.el;
    el_queryResultSelector = params.el_queryResultSelector;
    getPersonId = params.getPersonId;
    getCommentsForProjection = params.getCommentsForProjection;
    getCommentsForSelection = params.getCommentsForSelection;
    getReactionsToComment = params.getReactionsToComment;

    // Since initialize is called on resize, clear the old vis before setting up the new one.
    $(el_selector).html("");

    //create svg, appended to a div with the id #visualization_div, w and h values to be computed by jquery later
    //to connect viz to responsive layout if desired
    visualization = d3.select(el_selector)
        .append('svg')
          .attr('width', "100%")
          .attr('height', "100%")
          .attr('class', 'visualization');
    window.vis = visualization;
    w = $(el_selector).width();
    h = $(el_selector).height();

    strokeWidth = strokeWidthGivenVisWidth(w);
    baseNodeRadius = baseNodeRadiusScaleForGivenVisWidth(w);
    charge = chargeForGivenVisWidth(w);

    queryResults = d3.select(el_queryResultSelector)
        .append('ol')
          .attr('class', 'query_results');

        //$(el_selector).prepend($($("#pca_vis_overlays_template").html()));

    force = d3.layout.force()
        .nodes(nodes)
        .links([])
        .friction(0.9) // more like viscosity [0,1], defaults to 0.9
        .gravity(0)
        .charge(charge) // slight overlap allowed
        .size([w, h]);

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

          visualization.selectAll("circle.node")
              .attr("cx", function(d) { return d.x;})
              .attr("cy", function(d) { return d.y;});
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
    $(el_selector).on('mousedown', function(e) {
        selectionRectangle.x1 = getOffsetX(e);
        selectionRectangle.y1 = getOffsetY(e);
        selectionRectangle.x2 = getOffsetX(e);
        selectionRectangle.y2 = getOffsetY(e);
        mouseDown = true;
    });
    $(el_selector).on('mousemove', function(e) {
        if (mouseDown) {
            selectionRectangle.x2 = getOffsetX(e);
            selectionRectangle.y2 = getOffsetY(e);
            drawSelectionRectangle(selectionRectangle);
        }
    });
    $(el_selector).on('mouseup', function(e) {
        if (mouseDown) {
            selectRectangle(selectionRectangle);
            if (selectionRectangle.x1 === selectionRectangle.x2 &&
                selectionRectangle.y1 === selectionRectangle.y2) {
                drawSelectionRectangle(null);
            }
        }
        mouseDown = false;
    });
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
    return d.id;
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

function upsertNode(updatedNodes) {
    if (!updatesEnabled) {
        return;
    }
    console.log('upsert');
    //nodes.set(node.id, node);


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

    var border = maxNodeRadius + 50;
    return {
        x: d3.scale.linear().range([0 + border, w - border]).domain([spans.x.min, spans.x.max]),
        y: d3.scale.linear().range([0 + border, h - border]).domain([spans.y.min, spans.y.max])
    };
  }
    // TODO pass all nodes, not just updated nodes, to createScales.
    var scales = createScales(updatedNodes);
    var scaleX = scales.x;
    var scaleY = scales.y;
 
    var oldpositions = nodes.map( function(node) { return { x: node.x, y: node.y, id: node.id }; });

    function sortWithSelfOnTop(a, b) {
        if (isSelf(a)) {
            return 1;
        }
        if (isSelf(b)) {
            return -1;
        }
        return key(a) - key(b);
    }

    nodes = updatedNodes.filter(isPersonNode).sort(sortWithSelfOnTop).map(computeTarget);
    console.log('number of people: ' + nodes.length);

    oldpositions.forEach(function(oldNode) { 
        var newNode = _.findWhere(nodes, {id: oldNode.id});
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


  var circle = visualization.selectAll("circle.node")
      .data(nodes);

  // ENTER
  circle
    .enter().append("svg:circle")
      .attr("class", "node enter")
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
          .attr("cx", function(d) {
            return d.x;
          })
          .attr("cy", function(d) {
            return d.y;
          })
        .call(force.drag)
          ;

 

      // UPDATE
      // TODO Can we do this less frequently?
      circle.attr("class", "node update")
        //.each(function(d) {
            //d.x = d.x !== undefined ? d.x : d.data.targetX;
            //d.y = d.y !== undefined ? d.y : d.data.targetY;
        //})
        .style("stroke", function(d) {
            if (!isPersonNode(d)) {
                return;
            }
            return "darkgrey";
        })
        .style("fill", function(d) { 
            var distanceInPixels = Math.abs(this.cx.baseVal.value - d.data.targetX);
            if (distanceInPixels > 30) {
                return "lightgrey";
            } else {
                return chooseFill(d);
            }
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
/*
function dragstart(e) {
}
function dragend(e) {
}
function dragmove(e) {
}

var node_drag = d3.behavior.drag()
        .on("dragstart", dragstart)
        .on("drag", dragmove)
        .on("dragend", dragend);
*/

  visualization.selectAll("circle.node")
        .call(force.drag)
        .transition()
        .duration(500)
        .style("stroke", "black")
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

function inside(rect, x, y) {
    var ok = x <= rect.right && x >= rect.left && y <= rect.bottom && y >= rect.top;
    return ok;
}

function selectRectangle(rect) {
    var rect2 = {
        top:    Math.min(rect.y1, rect.y2),
        bottom: Math.max(rect.y1, rect.y2),
        left:   Math.min(rect.x1, rect.x2),
        right:  Math.max(rect.x1, rect.x2)
    };
    var circle = visualization.selectAll("circle.node")
        .data(nodes);

    var selectedNodes = [];
    circle
      .style('stroke', "black")
      .attr("r", chooseRadius)
      .filter(function(d) {
          if (inside(rect2, d.x, d.y)) {
              selectedNodes.push(d);
              return true;
          }
          return false;
      })
      .attr("r", chooseRadiusSelected)
      .style("stroke", "white");


    var selectedIds = selectedNodes.map(function(d) { return d.data.person_id;});
    function renderComments(comments) {
    function hover(d) {
            getReactionsToComment(d._id).then(function(reactions) {
                var userToReaction = {};
                var i;
                for (i = 0; i < reactions.length; i++) {
                    userToReaction[reactions[i].u] = reactions[i];
                }
                for (i = 0; i < nodes.length; i++) {
                    var node = nodes[i];

                    var reaction = userToReaction[node.data.person_id];
                    if (reaction) {
                        node.effects = reaction.type;
                        if (undefined === node.effects) {
                            node.effects = "blabla";
                        }
                    }
                }
                visualization.selectAll("circle.node")
                  .style("fill", chooseFill);
                //console.log(reactions);
                queryItemHoverOn = true;
            }, function() {
                console.error('failed to get reactions to comment: ' + d._id);
            });
            $(this).addClass("query_result_item_hover");
        }
        function unhover(d) {
            $(el_queryResultSelector).children().children().removeClass("query_result_item_hover");
            if (queryItemHoverOn) { // check this, so we can call it on every mouse move from the window, since mouseout isn't reliable
                //$(this).removeClass("query_result_item_hover");
                for (var i = 0; i < nodes.length; i++) {
                    var node = nodes[i];
                    delete node.effects;
                }
                visualization.selectAll("circle.node")
                  .style("fill", chooseFill);
            }
            queryItemHoverOn = false;
        }
        function unhoverAll() {
            $(el_queryResultSelector).removeClass("query_result_item_hover");
        }
        var d3CommentList = queryResults.selectAll("li")
            .data(comments, function(d) { return d._id; });

        d3CommentList.enter()
            .append("li")
            .attr('class', 'query_result_item')
            .on("mouseover", hover)
            .on("mouseout", unhover)
            .text(function(d) { return d.txt; });

        d3CommentList.exit().remove();

        // part of hack_mouseout_replacement
        $(el_queryResultSelector).on('mousemove', function(e) {
            e.preventDefault();
            // prevent these events from propagating to window
            return false;
        });
        // part of hack_mouseout_replacement
        $(window).on('mousemove', unhover);

        //d3CommentList
            //.attr("x", x)
            //.attr("y", y)
            //.attr("width", width)
            //.attr("height", height);
    }
    if (selectedIds.length) {
        getCommentsForSelection(selectedIds).then(
            renderComments,
            function(err) {
                console.error(err);
            });
    } else {
        renderComments([]);
    }
}

function drawSelectionRectangle(rect) {
    function x(d) { 
        return Math.min(d.x1, d.x2);}
    function y(d) { 
        return Math.min(d.y1, d.y2);}
    function width(d) { 
        return Math.abs(d.x1 - d.x2);}
    function height(d) { 
        return Math.abs(d.y1 - d.y2);}

    var data = rect ? [rect] : [];
    var d3Rect = visualization.selectAll("rect")
        .data(data);


    /*
    function dragmove(d) {
        //var left = 100;
        //var right = 200;
        //var top = 100;
        //var bottom = 200;
        var z = 100;
        //console.dir(d3.event);
        console.dir(d);
        d3.select(this)
            .attr("x",function(d) {
                d.x1 = d3.event.sourceEvent.offsetX;;
                d.x2 = d.x1 + 100;
                d.y1 = d3.event.sourceEvent.offsetY;;
                d.y2 = d.y1 + 100;
                return x(d);
            })
            //.attr("x", function(d) {console.dir(d); return x(d) + d3.event.dx})
            .attr("y", function(d) {return y(d);})
            .attr("width", width)
            .attr("height", height)
            ;
            //.attr("x", d.x = Math.max(z, Math.min(500 - z, d3.event.x)))
            //.attr("y", d.y = Math.max(z, Math.min(300 - z, d3.event.y)));
    }
    var drag = d3.behavior.drag()
        .origin(Object)
        .on("drag", dragmove)
    ;
    */

    d3Rect.enter()
        .append("svg:rect")
        .style("opacity", 0.2)
        .style("stroke", "darkgrey")
        .style("fill", "lightgrey");

    d3Rect
        .attr("x", x)
        .attr("y", y)
        .attr("width", width)
        .attr("height", height)
        //.call(drag)
    ;

    d3Rect.exit().remove();
}

function dismissSelection() {
    console.log('dismiss');
    drawSelectionRectangle(null);
    visualization.selectAll("rect")
        .data([]);
}


return {
    initialize: initialize,
    upsertNode: upsertNode
};
}());


