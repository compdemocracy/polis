var tree = Arboreal.parse(survey200, 'children');


//the h and w values should be locked at a 1:2 ratio of h to w
var h = 450;
var w = 900;

function setupVis(){

//create svg, appended to a div with the id #visualization_div, w and h values to be computed by jquery later
//to connect viz to responsive layout if desired
var visualization = d3.select('#visualization_div').append('svg')
              .attr('width', w)
              .attr('height', h)
              .attr('class', 'visualization');

// setup overlays
(function() {

    //add four directional arrows, scalable on resize of parent container which must be a square to preserve dimensions of viz.
    visualization.append('line')
            .attr('x1', w*.5)
            .attr('y1', h*.25)
            .attr('x2', w*.5)
            .attr('y2', 15)
            .attr('id', 'toparrow')
            .attr('marker-end', "url(#Triangle)");
    visualization.append('line')
            .attr('x1', w*.75)
            .attr('y1', h*.5)
            .attr('x2', w-15)
            .attr('y2', h*.5)
            .attr('id', 'rightarrow')
            .attr('marker-end', "url(#Triangle)");
    visualization.append('line')
            .attr('x1', w*.25)
            .attr('y1', h*.5)
            .attr('x2', 15)
            .attr('y2', h*.5)
            .attr('id', 'leftarrow')
            .attr('marker-end', "url(#Triangle)");
    visualization.append('line')
            .attr('x1', w*.5)
            .attr('y1', h*.75)
            .attr('x2', w*.5)
            .attr('y2', h-15)
            .attr('id', 'bottomarrow')
            .attr('marker-end', "url(#Triangle)");
    // add the center circle
    visualization.append('circle')
            .attr('cx', w*.5)
            .attr('cy', h*.5)
            .attr('r', 7)
            .attr('id', 'centercircle');
    // add four hover circles on lines
    visualization.append('circle')
            .attr('cx', w*.5)
            .attr('cy', h*.1)
            .attr('r', 10)
            .attr('id', 'top_circle');
    visualization.append('circle')
            .attr('cx', w*.9)
            .attr('cy', h*.5)
            .attr('r', 10)
            .attr('id', 'right_circle');
    visualization.append('circle')
            .attr('cx', w*.5)
            .attr('cy', h*.9)
            .attr('r', 10)
            .attr('id', 'bottom_circle');
    visualization.append('circle')
            .attr('cx', w*.1)
            .attr('cy', h*.5)
            .attr('r', 10)
            .attr('id', 'left_circle');
    // add four boxes that will come up on hover to show PILLARS which will show comments with 
    // most PCA SUPPORT both positively and negatively




      $('#toparrow').hover(function(){ 
          $('.visualization').addClass('.toparrow_hover');
          $('visualization').addClass
        }, function() { 
           

        });

      $('#centercircle').hover(function(){})

      //make this more robust using conditionals to make sure the class isn't misapplied:
      
      $('#centercircle').click(function(){
        $('#centercircle_content').removeClass('hidden'); 
      });

      $('#centercircle_content, #top_pillar, #right_pillar, #bottom_pillar, #left_pillar').click(function(){
        $(this).addClass('hidden');
      })

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

}()); // End setup overlays


// pca plotting setup
(function() {

    var nodes = [];

    var force = d3.layout.force()
        .nodes(nodes)
        .links([])
        .gravity(0)
        .size([w, h]);


    force.on("tick", function(e) {

      // Push nodes toward their designated location
      var k = .1 * e.alpha;
      nodes.forEach( function(o, i) {
        if (o.children && o.children.length) {
            return;
        }
        o.x = o.data.projection[0] * w / 2 + w/2;
        o.y = o.data.projection[1] * h / 2 + h/2;
        
      });

      // TODO Can we do this less frequently?
      var node = visualization.selectAll("circle.node")
          .attr("cx", function(d) { return d.x; })
          .attr("cy", function(d) { return d.y; });

    });


    function hashCode(s){
        var hash = 0, i, char;
        if (s.length == 0) return hash;
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

    //principlecomponents

    setInterval(function(){
      if  (dataFromPca.length === 0) {
        return;
      }
      nodes.push(dataFromPca.shift());
      force.start();

      visualization.selectAll("circle.node")
          .data(nodes)
        .enter().append("svg:circle")
          .attr("class", "node")
          .attr("cx", function(d) { return d.x; })
          .attr("cy", function(d) { return d.y; })
          .attr("r", 8)
          .style("fill", function(d) {
                if (d.children && d.children.length) {
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
    }, 10);



    // Normalize to [-1,1]
    function normalize(projectionDimension) {
        return projectionDimension / 6;
    }
    tree.traverseDown(function(n) {
        if (n.data.projection) {
            n.data.projection = n.data.projection.map(normalize);
        }
    });

    var dataFromPca = tree.toArray();

}()); // end pca plot setup

}

$(document).ready(setupVis);
