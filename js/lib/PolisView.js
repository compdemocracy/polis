var Handlebones = require("handlebones");

var PolisView = Handlebones.View.extend({ 

    render: function() { 
       this.trigger("beforeRender");
       Handlebones.View.prototype.render.apply(this, arguments);
       this.trigger("afterRender");
    }, 

});


module.exports = PolisView;