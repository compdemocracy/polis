
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var PcaVis = (function(){

// The h and w values should be locked at a 1:2 ratio of h to w
var h = 450;
var w = 900;
var nodes = d3.map();
var visualization;

var el_selector;
var getPersonId;

function initialize(params) {
    el_selector = params.el;
    getPersonId = params.getPersonId;


    //create svg, appended to a div with the id #visualization_div, w and h values to be computed by jquery later
    //to connect viz to responsive layout if desired
    visualization = d3.select(el_selector)
        .append('svg')
          .attr('width', w)
          .attr('height', h)
          .attr('class', 'visualization');

        $(el_selector).prepend($($("#pca_vis_overlays_template").html()));

    setupOverlays();
    setupPlot();
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
    }, function() { 
    });

    $('#centercircle').hover(function(){});

    //make this more robust using conditionals to make sure the class isn't misapplied:

    $('#centercircle').click(function(){
        $('#centercircle_content').removeClass('hidden'); 
    });

    $('#centercircle_content, #top_pillar, #right_pillar, #bottom_pillar, #left_pillar').click(function(){
        $(this).addClass('hidden');
    });

    $('#top_circle').click(function(){
        $('#top_pillar').toggleClass('hidden');
    });
    $('#right_circle').click(function(){
        $('#right_pillar').toggleClass('hidden');
    });
    $('#bottom_circle').click(function(){
        $('#bottom_pillar').toggleClass('hidden');
    });
    $('#left_circle').click(function(){
        $('#left_pillar').toggleClass('hidden');
    });

} // End setup overlays

// pca plotting setup
function setupPlot() {


} // end setupPlot


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

var nodeCounts = [];

function upsertNode(node) { // TODO, accept an array, since this could get expensive.
    nodes.set(node.id, node);
    var sortedNodes = nodes.values().sort(key);
    nodeCounts.push(sortedNodes.length);
    //console.dir(nodeCounts);
    console.log(sortedNodes.length);

    var nodeRadius = 10;

    var spans = { 
        x: { min: Infinity, max: -Infinity },
        y: { min: Infinity, max: -Infinity }
    };
    for (var i = 0; i < sortedNodes.length; i++) {
        if (sortedNodes[i].data.projection) {
            spans.x.min = Math.min(spans.x.min, sortedNodes[i].data.projection[0]);
            spans.x.max = Math.max(spans.x.max, sortedNodes[i].data.projection[0]);
            spans.y.min = Math.min(spans.y.min, sortedNodes[i].data.projection[1]);
            spans.y.max = Math.max(spans.y.max, sortedNodes[i].data.projection[1]);
        }
    }

    var border = nodeRadius + 5;
    var scaleX = d3.scale.linear().range([0 + border, w - border]).domain([spans.x.min, spans.x.max]);
    var scaleY = d3.scale.linear().range([0 + border, h - border]).domain([spans.y.min, spans.y.max]);

  var circle = visualization.selectAll("circle.node")
      .data(sortedNodes, key);

  // ENTER
  circle.enter().append("svg:circle")
      .attr("class", "node enter")
      .attr("r", nodeRadius)
      .attr("opacity", 0)
      .attr("cx", w/2)
      .attr("cy", h/2)
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
          ;
      //.call(force.drag);

      // UPDATE
      // TODO Can we do this less frequently?
      circle.attr("class", "node update")
        .each(function(d) {
            if (!isPersonNode(d)) {
                // If we decide to show the branching points, we could
                // compute their position as the average of their childrens'
                // positions, and return that here.
                return;
            }
            d.targetX = scaleX(d.data.projection[0]);
            d.targetY = scaleY(d.data.projection[1]);
            return d;
        })
        .style("fill", function(d) {
            if (!isPersonNode(d)) {
                return;
            }
            if (Math.abs(this.cx.baseVal.value - d.targetX) > 0.001) {
                return "blue";
            } else if (d.data.person_id === getPersonId()) {
                return "red";
            } else {
                return "black";
            }
        })
        .style("r", function(d) {
            if (!isPersonNode(d)) {
                return;
            }
            if (Math.abs(this.cx.baseVal.value - d.targetX) > 0.001) {
                return 15;
            } else {
                return 8;
            }
        })
        .transition()
        .duration(350)
        .style("fill", function(d) { return d.data.person_id === getPersonId() ? "red" : "black";})
        .transition()
          .duration(1000)
          .attr("cx", function(d) {
            return d.targetX;
          })
          .attr("cy", function(d) {
            return d.targetY;
          })
          .attr("opacity", function(d) {
              return isPersonNode(d) ? 1 : 0;
          })
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


