
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var PcaVis = (function(){

// The h and w values should be locked at a 1:2 ratio of h to w
var h;
var w;
var nodes = [];
var visualization;

var el_selector;
var getPersonId;
var getCommentsForProjection;

var force;


var updatesEnabled = true;

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
    getPersonId = params.getPersonId;
    getCommentsForProjection = params.getCommentsForProjection;

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

        //$(el_selector).prepend($($("#pca_vis_overlays_template").html()));

    force = d3.layout.force()
        .nodes(nodes)
        .links([])
        .friction(0.9) // more like viscosity [0,1], defaults to 0.9
        .gravity(0)
        .charge(-10) // slight overlap allowed
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
    setupOverlays();
}

function setupOverlays() {

    //add four directional arrows, scalable on resize of parent container which must be a square to preserve dimensions of viz.
    visualization.append('line')
        .attr('x1', w * 0.5)
        .attr('y1', h * 0.25)
        .attr('x2', w * 0.5)
        .attr('y2', 15)
        .attr('id', 'toparrow')
        .attr('marker-end', "url(#Triangle)");
    visualization.append('line')
        .attr('x1', w * 0.75)
        .attr('y1', h * 0.5)
        .attr('x2', w - 15)
        .attr('y2', h * 0.5)
        .attr('id', 'rightarrow')
        .attr('marker-end', "url(#Triangle)");
    visualization.append('line')
        .attr('x1', w * 0.25)
        .attr('y1', h * 0.5)
        .attr('x2', 15)
        .attr('y2', h * 0.5)
        .attr('id', 'leftarrow')
        .attr('marker-end', "url(#Triangle)");
    visualization.append('line')
        .attr('x1', w * 0.5)
        .attr('y1', h * 0.75)
        .attr('x2', w * 0.5)
        .attr('y2', h - 15)
        .attr('id', 'bottomarrow')
        .attr('marker-end', "url(#Triangle)");
    // add the center circle
    visualization.append('circle')
        .attr('cx', w * 0.5)
        .attr('cy', h * 0.5)
        .attr('r', 7)
        .attr('id', 'centercircle');
    // add four hover circles on lines
    visualization.append('circle')
        .attr('cx', w * 0.5)
        .attr('cy', h * 0.1)
        .attr('r', 10)
        .attr('id', 'top_circle');
    visualization.append('circle')
        .attr('cx', w * 0.9)
        .attr('cy', h * 0.5)
        .attr('r', 10)
        .attr('id', 'right_circle');
    visualization.append('circle')
        .attr('cx', w * 0.5)
        .attr('cy', h * 0.9)
        .attr('r', 10)
        .attr('id', 'bottom_circle');
    visualization.append('circle')
        .attr('cx', w * 0.1)
        .attr('cy', h * 0.5)
        .attr('r', 10)
        .attr('id', 'left_circle');
    // add four boxes that will come up on hover to show PILLARS which will show comments with 
    // most PCA SUPPORT both positively and negatively




    $('#toparrow').hover(function(){ 
        $('.visualization').addClass('.toparrow_hover');
    });

    $('#centercircle').hover(function(){});

    //make this more robust using conditionals to make sure the class isn't misapplied:

    $('#centercircle').click(function(){
        $('#centercircle_content').removeClass('hidden'); 
    });

    $('#centercircle_content, #top_pillar, #right_pillar, #bottom_pillar, #left_pillar').click(function(){
        $(this).addClass('hidden');
    });

    function setupHandler(directionName) {
        function handler(comments) {
            // hide the others
            $('.commentlist').addClass('hidden');
            
            // render and show this
            $('#'+directionName+'_pillar > .commentlist_contents').html(renderCommentsList(comments));
            $('#'+directionName+'_pillar').removeClass('hidden');
        }

        var projection = {"top": 1, "bottom": 1, "left": 0, "right": 0}[directionName];
        var sort = {"top": -1, "bottom": 1, "left": 1, "right": -1}[directionName];

        $('#'+directionName+'_circle').click(function(){
            getCommentsForProjection({
                sort: sort,
                count: 2,
                projection: projection 
            }).done( handler );
        });
    }

    ["top", "bottom", "left", "right"].forEach(setupHandler);
} // End setup overlays


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

function upsertNode(updatedNodes) { // TODO, accept an array, since this could get expensive.
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
    var scaleX = d3.scale.linear().range([0 + border, w - border]).domain([spans.x.min, spans.x.max]);
    var scaleY = d3.scale.linear().range([0 + border, h - border]).domain([spans.y.min, spans.y.max]);
    //var scaleX = d3.scale.linear().range([0 + border, w - border]).domain([-0.5, 0.5]);
    //var scaleY = d3.scale.linear().range([0 + border, h - border]).domain([-0.5, 0.5]);
 
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

    function chooseFill(d) {
        return isSelf(d) ? "red" : "black";
    }


  var circle = visualization.selectAll("circle.node")
      .data(nodes);

  // ENTER
  circle
    .enter().append("svg:circle")
      .attr("class", "node enter")
      //.each(function(d) {d.x = w/2; d.y = h/2;})
      .attr("r", function(d) {
            if (isSelf(d)){
                return nodeRadius + 5; // medium
            }
            return nodeRadius;// + (Math.random() * 10);
        })
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
        .style("stroke-width", 1.5)
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
            return "orange";
        })
        .style("fill", function(d) { 
            var distanceInPixels = Math.abs(this.cx.baseVal.value - d.data.targetX);
            if (distanceInPixels > 30) {
                return "blue";
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

return {
    initialize: initialize,
    upsertNode: upsertNode
};
}());


