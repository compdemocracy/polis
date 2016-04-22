var eb = require("../eventBus");
var Handlebones = require("handlebones");

var PolisModelView = Handlebones.ModelView.extend({

  render: function() {
    eb.trigger(eb.firstRender);
    // this.trigger("beforeRender");
    Handlebones.ModelView.prototype.render.apply(this, arguments);
    // this.trigger("afterRender");
  },

});


module.exports = PolisModelView;
