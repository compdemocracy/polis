var Handlebones = require("handlebones");


var PolisView = Handlebones.View.extend({ 

    initialize: function(options) { 
        _.bindAll(this, 'beforeRender', 'render', 'afterRender'); 
        var _this = this; 
        this.render = _.wrap(this.render, function(render) { 
            _this.beforeRender(); 
            render(); 
            _this.afterRender(); 
            return _this; 
        }); 
    }, 

    beforeRender: function() { 
       this.trigger("beforeRender");
    }, 

    render: function() { 
        return this; 
    }, 

    afterRender: function() { 
       this.trigger("afterRender");
    } 
});

module.exports = PolisView;