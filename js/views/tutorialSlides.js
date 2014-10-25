var Handlebones = require("handlebones");
var template = require("../tmpl/tutorialSlides");
var display = require("../util/display");
var Utils = require("../util/utils");


module.exports =  Handlebones.ModelView.extend({
  name: "tutorialSlidesView",
  template: template,
  context: function() {
    var c = Handlebones.ModelView.prototype.context.apply(this, arguments);
    // c.use_background_content_class = display.xs();

    // var step = 2;
    c["step" + c.step] = true;
    return c;
  },

  events: {
  },

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    setTimeout(function() {
      that.trigger("done");
    }, 3000);
  }
});
