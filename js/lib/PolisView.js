var eb = require("../eventBus");
var Handlebones = require("handlebones");

var PolisView = Handlebones.View.extend({ 

    render: function() { 
       eb.trigger(eb.firstRender);
       // this.trigger("beforeRender");
       Handlebones.View.prototype.render.apply(this, arguments);
       // this.trigger("afterRender");
    }, 

});


module.exports = PolisView;