
// TODO are we using force Layout or not? not really. so it may be worth cleaning up to simplify.
// Use a css animation to transition the position

var PcaVis = (function(){

// The h and w values should be locked at a 1:2 ratio of h to w
var h = 450;
var w = 900;
var nodes = d3.map();
var visualization;
var force;

function initialize(el_selector) {
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

function computePosition(projection, screenSize, e) {
    var u = projection;

    var halfScreenSize = screenSize/2;
    // scale to width (or height if we're mapping to y)
    u *= halfScreenSize;
    // animation effect - TODO remove or find something better
    //u *= (1 - e.alpha);
    // align to the center
    u += halfScreenSize;
    return u;
}

// pca plotting setup
function setupPlot() {


    force = d3.layout.force()
        .nodes(nodes.values())
        .links([])
        .gravity(0)
        .size([w, h]);


    force.on("tick", function(e) {

      // Push nodes toward their designated location
      var k = 0.1 * e.alpha;
      nodes.forEach( function(id, o) {
          /*
        if (!isPersonNode(o)) {
            // If we decide to show the branching points, we could
            // compute their position as the average of their childrens'
            // positions, and return that here.
            return;
        }
        if (undefined === o.x) { o.x = w/2; }
        if (undefined === o.y) { o.y = h/2; }
        var targetX = computePosition(o.data.projection[0], w, e);
        var targetY = computePosition(o.data.projection[1], h, e);

        o.x += (targetX - o.x) * k;
        o.y += (targetY - o.y) * k;


        var roughDistance = (Math.abs(targetX - o.x) + Math.abs(targetY - o.y))/ (w+h)/2;
        var opacity = 1 / roughDistance;
        debugger;
*/
        
      });


      // TODO Can we do this less frequently?
      var node = visualization.selectAll("circle.node")
          .attr("cx", function(d) {
            if (!isPersonNode(d)) {
                // If we decide to show the branching points, we could
                // compute their position as the average of their childrens'
                // positions, and return that here.
                return;
            }
            if (undefined === d.x) { d.x = w/2; }
            d.targetX = computePosition(d.data.projection[0], w, e);

            d.x += (d.targetX - d.x) * k;


            //var roughDistance = (Math.abs(targetX - d.x) + Math.abs(targetY - d.y))/ (w+h)/2;
            //var opacity = 1 / roughDistance;
            return d.x;
          })
          .attr("cy", function(d) {
            if (!isPersonNode(d)) {
                // If we decide to show the branching points, we could
                // compute their position as the average of their childrens'
                // positions, and return that here.
                return;
            }
            if (undefined === d.y) { d.y = h/2; }
            d.targetY = computePosition(d.data.projection[1], h, e);

            d.y += (d.targetY - d.y) * k;


            return d.y;
          })
          .attr("opacity", function(d) {
            var distance = (Math.pow(d.targetX - d.x,2) + Math.pow(d.targetY - d.y,2))/ (w+h)/2;
            // A gradual slope will cause the opacity to smoothly transition.
            // A high value for slope will cause the nodes  to pop in and out.
            var slope = 0.2;
            return Math.min(1, 1 - distance * slope);
          });

    });



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


function upsertNode(node) {
    nodes.set(node.id, node);
    force.start();

  visualization.selectAll("circle.node")
      .data(nodes.values(), key)
    .enter().append("svg:circle")
      .attr("class", "node")
      .attr("r", 8)
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
      .style("stroke-width", 1.5)
      .call(force.drag);
}

return {
    initialize: initialize,
    upsertNode: upsertNode
};
}());


