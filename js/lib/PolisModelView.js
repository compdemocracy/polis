var Handlebones = require("handlebones");

var PolisModelView = Handlebones.ModelView.extend({ 

    render: function() { 
        debugger;
       this.trigger("beforeRender");
       Handlebones.ModelView.prototype.render.apply(this, arguments);
       this.trigger("afterRender");
    }, 

});


module.exports = PolisModelView;